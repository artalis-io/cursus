#!/usr/bin/env python3
"""Consistent logical backup on the controller and an isolated, disposable restore."""
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import shlex
import signal
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
PG_OPTIONS = 'PGOPTIONS=-c timezone=UTC -c statement_timeout=30000 -c idle_in_transaction_session_timeout=300000'


class RestoreError(RuntimeError):
    pass


def inventory_sql(tables):
    if not tables or any(not re.fullmatch(r'[a-z_][a-z_0-9]*', name) for name in tables):
        raise RestoreError('invalid inventory table set')
    fields = []
    for table in tables:
        fields.extend([repr(table), "(SELECT json_build_object('count',count(*),'checksum',md5(coalesce(string_agg(row_to_json(t)::text,'' ORDER BY row_to_json(t)::text COLLATE \"C\"),''))) FROM public.\"" + table + '\" t)'])
    return 'SELECT json_build_object(' + ','.join(fields) + ')'


class Runner:
    def __init__(self, seconds=600):
        self.end = time.monotonic() + seconds
        self.diagnostics_path = None

    def run(self, argv, *, input=None, stdout=None, timeout=60):
        remaining = min(timeout, self.end - time.monotonic())
        if remaining <= 0:
            raise RestoreError('restore verification deadline exceeded')
        try:
            result = subprocess.run(argv, stdin=input, stdout=stdout or subprocess.PIPE, stderr=subprocess.PIPE,
                                    timeout=remaining)
        except (OSError, subprocess.TimeoutExpired):
            raise RestoreError('restore command failed or timed out') from None
        if result.returncode:
            if self.diagnostics_path:
                descriptor=os.open(self.diagnostics_path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
                with os.fdopen(descriptor,'wb') as output:output.write(result.stderr[-16384:])
            raise RestoreError('restore command failed')
        return result.stdout.decode().strip() if result.stdout is not None else ''

    def ssh(self, node, args, **kwargs):
        return self.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', node['ssh_alias'], shlex.join(args)], **kwargs)


def psql_args(container):
    return ['docker', 'exec', '-e', PG_OPTIONS, container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'cursus', '-d', 'cursus']


class Snapshot:
    """Keep one read-only exported snapshot alive while pg_dump imports it."""
    def __init__(self, node, container):
        args = psql_args(container)
        args.insert(2, '-i')
        self.buffer = b''
        self.process = subprocess.Popen(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', node['ssh_alias'], shlex.join(args)],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)

    def query(self, query):
        try:
            self.process.stdin.write((query.rstrip(';') + ';\n').encode()); self.process.stdin.flush()
            deadline=time.monotonic()+40
            with selectors.DefaultSelector() as selector:
                selector.register(self.process.stdout, selectors.EVENT_READ)
                while b'\n' not in self.buffer:
                    remaining=deadline-time.monotonic()
                    if remaining<=0 or not selector.select(timeout=remaining):
                        raise RestoreError('snapshot query timed out')
                    data=os.read(self.process.stdout.fileno(),65536)
                    if not data or len(self.buffer)+len(data)>16*1024*1024:
                        raise RestoreError('snapshot query failed')
                    self.buffer+=data
            line,self.buffer=self.buffer.split(b'\n',1)
            return line.decode().strip()
        except (OSError, BrokenPipeError):
            raise RestoreError('snapshot connection failed') from None

    def close(self):
        try:
            self.process.stdin.write(b'ROLLBACK;\n\\q\n'); self.process.stdin.flush(); self.process.stdin.close()
            self.process.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            pass
        finally:
            if self.process.poll() is None:
                try: os.killpg(self.process.pid, signal.SIGKILL)
                except ProcessLookupError: pass
            self.process.wait()
            self.process.stdout.close()
            try: self.process.stdin.close()
            except OSError: pass


def cleanup_restore(runner,node,name,nonce):
    runner.end=time.monotonic()+45
    identifier=runner.ssh(node,['docker','ps','--no-trunc','-aq','--filter','name=^/'+name+'$'])
    if not identifier:return True
    if not re.fullmatch(r'[a-f0-9]{64}',identifier):raise RestoreError('ambiguous temporary container identity')
    label=runner.ssh(node,['docker','inspect',identifier,'--format','{{index .Config.Labels "io.artalis.cursus.restore-run"}}'])
    if label!=nonce:raise RestoreError('restore cleanup ownership mismatch')
    runner.ssh(node,['docker','rm','-f','-v',identifier])
    return True


def verify(production, state_dir, *, runner=None):
    """Creates no production tables/objects, stops no existing container, restores nowhere live."""
    runner = runner or Runner()
    started = time.time(); nonce = uuid.uuid4().hex
    # Never silently add another verifier when a crashed predecessor may remain.
    previous_path=state_dir/'restore-attempt.json'
    if previous_path.exists():
        previous=json.loads(previous_path.read_text())
        if previous.get('restore_container_name') and previous.get('cleanup_completed') is not True:
            raise RestoreError('previous temporary restore requires operator review')
    if (state_dir/'backups').is_symlink():raise RestoreError('backup root cannot be a symlink')
    if shutil.disk_usage(state_dir).free<1024**3:raise RestoreError('insufficient controller space for backup verification')
    root = state_dir / 'backups' / nonce
    root.mkdir(parents=True, mode=0o700, exist_ok=False)
    root.chmod(0o700)
    archive = root / 'database.dump'
    runner.diagnostics_path=root/'command-error.log'
    primary = next(n for n in production['nodes'] if n['role'] == 'primary')
    secondary = next(n for n in production['nodes'] if n['role'] == 'standby')
    source = primary['project'] + '-' + primary['postgres_service'] + '-1'
    snapshot = None; restore_id = None
    name = 'cursus-ops-restore-' + nonce
    report = {'schema_version': 1, 'status': 'running', 'run_id': nonce, 'started_at': started,
              'source_node': primary['name'], 'restore_node': secondary['name'], 'logical_backup': True,
              'network_isolated': True, 'production_writes': 0}
    from ops import atomic_json
    atomic_json(state_dir / 'restore-attempt.json', report)
    try:
        report['stage']='source-metadata'
        image = runner.ssh(primary, ['docker', 'inspect', source, '--format', '{{.Image}}'])
        if not re.fullmatch(r'sha256:[a-f0-9]{64}', image):
            raise RestoreError('database image must be immutable')
        if runner.ssh(secondary, ['docker', 'image', 'inspect', image, '--format', '{{.Id}}']) != image:
            raise RestoreError('matching local database image unavailable')
        snapshot = Snapshot(primary, source)
        # BEGIN has no output under -q. Exported snapshot pins all metadata/checksums.
        snapshot_id = snapshot.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot()')
        if not re.fullmatch(r'[0-9A-F]+-[0-9A-F]+-[0-9]+', snapshot_id):
            raise RestoreError('invalid exported snapshot')
        if snapshot.query('SELECT pg_is_in_recovery()') != 'f':
            raise RestoreError('configured source is not primary')
        report['source_system_id']=snapshot.query('SELECT system_identifier FROM pg_control_system()')
        report['source_timeline']=int(snapshot.query('SELECT timeline_id FROM pg_control_checkpoint()'))
        tables = json.loads(snapshot.query("SELECT json_agg(tablename ORDER BY tablename) FROM pg_tables WHERE schemaname='public'"))
        inventory = json.loads(snapshot.query(inventory_sql(tables)))
        report['schema'] = int(snapshot.query('SELECT max(version) FROM schema_migrations'))
        report['stage']='dump'
        with archive.open('xb') as output:
            os.chmod(archive, 0o600)
            runner.ssh(primary, ['docker', 'exec', '-e', PG_OPTIONS, source, 'pg_dump', '-U', 'cursus', '-d', 'cursus',
                                '--format=custom', '--snapshot=' + snapshot_id], stdout=output, timeout=180)
            output.flush(); os.fsync(output.fileno())
        snapshot.close(); snapshot = None
        with archive.open('rb') as source_file:
            report['archive_sha256'] = hashlib.file_digest(source_file, 'sha256').hexdigest()
        report['archive_bytes'] = archive.stat().st_size
        if report['archive_bytes'] == 0:
            raise RestoreError('empty backup archive')
        if runner.ssh(secondary, ['docker', 'ps', '-aq', '--filter', 'name=^/' + name + '$']):
            raise RestoreError('restore container name conflicts')
        # Persist ownership intent before Docker accepts the request. Cleanup may
        # remove only this nonce-labelled temporary container, never by a prefix.
        report['restore_container_name'] = name
        atomic_json(state_dir / 'restore-attempt.json', report)
        report['stage']='restore-start'
        restore_id = runner.ssh(secondary, ['docker', 'run', '--pull', 'never', '-d', '--name', name,
            '--label', 'io.artalis.cursus.restore-run=' + nonce, '--network', 'none', '--read-only', '--user', '70:70',
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '2g', '--cpus', '1', '--pids-limit', '128',
            '--tmpfs', '/var/lib/postgresql/data:rw,size=1g,uid=70,gid=70,mode=0700',
            '--tmpfs', '/tmp:rw,size=64m,mode=1777', '--tmpfs', '/var/run/postgresql:rw,size=1m,uid=70,gid=70,mode=0775',
            '-e', 'PGHOST=/var/run/postgresql',
            '-e', 'POSTGRES_USER=cursus', '-e', 'POSTGRES_DB=cursus', '-e', 'POSTGRES_PASSWORD=disposable-local-only',
            image, 'postgres', '-c', 'listen_addresses='])
        if not re.fullmatch(r'[a-f0-9]{64}', restore_id):
            raise RestoreError('invalid temporary container identity')
        report['stage']='restore-readiness'
        for _ in range(30):
            try:
                runner.ssh(secondary, ['docker', 'exec', restore_id, 'pg_isready', '-h', '/var/run/postgresql', '-U', 'cursus', '-d', 'cursus']); break
            except RestoreError:
                time.sleep(1)
        else:
            raise RestoreError('isolated database did not become ready')
        report['stage']='restore-import'
        with archive.open('rb') as input:
            runner.ssh(secondary, ['docker', 'exec', '-i', restore_id, 'pg_restore', '-h', '/var/run/postgresql', '-U', 'cursus', '-d', 'cursus',
                                  '--no-owner', '--no-privileges', '--exit-on-error'], input=input, timeout=180)
        report['stage']='restore-inventory'
        target_args = psql_args(restore_id) + ['-h', '/var/run/postgresql']
        restored = json.loads(runner.ssh(secondary, target_args + ['-c', inventory_sql(tables)]))
        if restored != inventory:
            raise RestoreError('restored counts or checksums do not match the exported source snapshot')
        if int(runner.ssh(secondary, target_args + ['-c', 'SELECT max(version) FROM schema_migrations'])) != report['schema']:
            raise RestoreError('restored schema mismatch')
        report.update(status='passed', tables=len(tables), inventory=inventory, image=image, snapshot_consistent=True)
    except Exception:
        if restore_id and re.fullmatch(r'[a-f0-9]{64}',restore_id):
            try:
                diagnostic=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=5',secondary['ssh_alias'],shlex.join(['docker','logs','--tail','80',restore_id])],capture_output=True,timeout=12)
                descriptor=os.open(root/'restore-container-private.log',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
                with os.fdopen(descriptor,'wb') as output:output.write((diagnostic.stdout+diagnostic.stderr)[-16384:])
            except Exception:pass
        report['status'] = 'failed'; report['error'] = 'backup or isolated restore verification failed; inspect controller status'
    finally:
        if snapshot:
            snapshot.close()
        # A timed-out docker run may have been accepted. Verify its unique label
        # before deleting anything; leave uncertainty visible on lost SSH access.
        if 'restore_container_name' in report:
            try:
                report['cleanup_completed']=cleanup_restore(runner,secondary,name,nonce)
            except Exception:
                report['status'] = 'failed'; report['cleanup_completed'] = False
                report['error'] = 'temporary restore cleanup requires operator review'
        report['finished_at'] = time.time(); report['duration_seconds'] = round(time.time() - started, 2)
        atomic_json(root / 'report.json', report); atomic_json(state_dir / 'restore-attempt.json', report)
        if report['status'] == 'passed':
            atomic_json(state_dir / 'verified-restore.json', report)
    return report
