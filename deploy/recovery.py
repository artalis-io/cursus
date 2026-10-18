#!/usr/bin/env python3
"""Manage application-owned reboot recovery; reuse cutover's production inventory."""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
import signal
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
MUTATIONS = {'install', 'pause', 'resume', 'uninstall'}


class RecoveryError(RuntimeError):
    pass


def bounded_run(argv, *, input=None, timeout=180, env=None):
    """Bound a local operation and reap its ordinary (non-daemonized) children.

    Nested helper commands inherit the top-level helper's process group, so
    timing out that helper also kills a still-running Compose subprocess.
    Docker daemon requests are not cancellable this way; the helper persists
    an uncertainty marker before writes and leaves it on any interruption.
    """
    environment = dict(os.environ if env is None else env)
    owns_group = environment.get('CURSUS_RECOVERY_NESTED') != '1'
    environment['CURSUS_RECOVERY_NESTED'] = '1'
    process = subprocess.Popen(argv, stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                               start_new_session=owns_group, env=environment)
    try:
        stdout, stderr = process.communicate(input=input, timeout=timeout)
        return subprocess.CompletedProcess(argv, process.returncode, stdout, stderr)
    finally:
        # Always reap the owned group, including descendants left by an exited
        # immediate child. Do not kill our own group in a nested invocation.
        if owns_group:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        elif process.poll() is None:
            process.kill()
        process.wait()
        for pipe in (process.stdin, process.stdout, process.stderr):
            if pipe is not None:
                pipe.close()


def execute(argv, *, input=None, allow_missing_crontab=False, timeout=180):
    # cron commonly supplies only /usr/bin:/bin; Linux `ip` lives in /usr/sbin.
    environment = {**os.environ, 'PATH': os.environ.get('PATH', '') + ':/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'}
    result = bounded_run(argv, input=input, timeout=timeout, env=environment)
    if result.returncode:
        if allow_missing_crontab and result.returncode == 1 and 'no crontab for' in result.stderr.lower():
            return ''
        # Never echo crontabs, rendered Compose config, or subprocess diagnostics.
        raise RecoveryError('command failed: ' + Path(argv[0]).name)
    return result.stdout


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic(path, content, mode=0o600):
    descriptor, name = tempfile.mkstemp(prefix='.recovery-write-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(name, mode)
        os.replace(name, path)
        # fsync(file) alone does not persist the directory entry after power loss.
        sync_directory(path.parent)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def checked_path(path, resolve=True):
    value = str(path)
    if any(c in value for c in '\r\n%'):
        raise RecoveryError('deployment paths may not contain newlines or cron percent syntax')
    if not resolve:
        if not path.is_absolute() or '..' in path.parts:
            raise RecoveryError('remote paths must be absolute and normalized')
        # Never resolve Linux paths against the controller's filesystem (macOS
        # /home is an automount/symlink with a different physical location).
        return path
    return path.resolve()


def paths(env_path):
    env_path = checked_path(env_path)
    directory = env_path.parent
    return {'env': env_path, 'root': directory, 'helper': directory / 'deploy/boot-recover.py',
            'manager': directory / 'deploy/recovery.py', 'manifest': directory / '.boot-recover.json',
            'paused': directory / '.boot-recover-paused', 'uncertain': directory / '.boot-recover-uncertain'}


def cron_line(p, role, project):
    command = shlex.join(['/usr/bin/python3', str(p['manager']), '--local', '--env-file', str(p['env']),
                          '--role', role, '--project', project, 'run'])
    return f'*/2 * * * * {command} 2>&1 | /usr/bin/logger -t cursus-boot-recover # cursus-recovery:{project}'


def owned_lines(text, p, role, project):
    marker = '# cursus-recovery:' + project
    legacy = ('*/2 * * * * /usr/bin/python3 ' + str(p['helper']) + ' --env-file ' + str(p['env']) +
              ' --role ' + role + ' 2>&1 | /usr/bin/logger -t cursus-boot-recover # cursus-boot-recover-managed')
    result = []
    for line in text.splitlines():
        if line.rstrip().endswith(marker) or line == legacy:
            result.append(line)
        elif not line.lstrip().startswith('#') and (str(p['helper']) in line or str(p['manager']) in line):
            raise RecoveryError('unrecognized recovery crontab entry; refusing to duplicate or remove it')
    return result


def rewritten_cron(text, p, role, project, install):
    owned = owned_lines(text, p, role, project)
    lines = [line for line in text.splitlines() if line not in owned]
    if install:
        lines.append(cron_line(p, role, project))
    return '\n'.join(lines) + ('\n' if lines else '')


def read_manifest(p):
    try:
        return json.loads(p['manifest'].read_text())
    except (OSError, ValueError):
        return {}


def status(p, role, project, text, expected=None):
    owned = owned_lines(text, p, role, project)
    manifest = read_manifest(p)
    pinned = (manifest.get('schema_version') == 1 and manifest.get('project') == project and
              manifest.get('role') == role and manifest.get('env_file') == str(p['env']) and
              bool(manifest.get('database_identity')) and
              all(path.is_file() and sha(path) == manifest.get(name + '_sha256')
                  for name, path in [('helper', p['helper']), ('manager', p['manager'])]))
    current = expected is None or all(manifest.get(name + '_sha256') == value for name, value in expected.items())
    return {'project': project, 'role': role, 'installed': owned == [cron_line(p, role, project)],
            'entries': len(owned), 'checksums_valid': pinned, 'version_current': current,
            'paused': p['paused'].exists(), 'manifest_schema': manifest.get('schema_version'),
            'uncertain_operation': p['uncertain'].exists(),
            'database_identity': manifest.get('database_identity'),
            'helper_sha256': manifest.get('helper_sha256'), 'manager_sha256': manifest.get('manager_sha256')}


def prerequisites(p, role, project, helper, allow_paused=False):
    for tool in ('crontab', 'docker', 'ip', 'logger', 'systemctl'):
        if not shutil.which(tool):
            raise RecoveryError('missing host prerequisite: ' + tool)
    if not Path('/usr/bin/python3').is_file() or not Path('/usr/bin/logger').is_file():
        raise RecoveryError('missing scheduled executable')
    # Installation must not succeed when cron will never execute after boot.
    active = False
    for service in ('cron', 'crond'):
        probe = subprocess.run(['systemctl', 'is-active', service], capture_output=True, text=True, timeout=10)
        enabled = subprocess.run(['systemctl', 'is-enabled', service], capture_output=True, text=True, timeout=10)
        active |= probe.returncode == 0 and enabled.returncode == 0
    if not active:
        raise RecoveryError('cron service must already be active and enabled; host provisioning is external')
    values = {}
    for line in p['env'].read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    if values.get('COMPOSE_PROJECT_NAME') != project:
        raise RecoveryError('deployment project mismatch')
    # Paused maintenance must not be silently bypassed by installation.
    if p['paused'].exists() and not allow_paused:
        raise RecoveryError('deployment is paused; finish maintenance before installation/resume')
    command = ['/usr/bin/python3', str(helper), '--env-file', str(p['env']), '--role', role,
               '--expected-project', project, '--check-only']
    previous = read_manifest(p).get('database_identity')
    if previous:
        command += ['--expected-identity', json.dumps(previous)]
    result = json.loads(execute(command))
    identity = result.get('database_identity')
    if (not isinstance(identity, dict) or identity.get('project') != project or
            identity.get('service') != ('postgres' if role == 'primary' else 'postgres-standby') or
            not str(identity.get('system_identifier', '')).isdigit() or not identity.get('pgdata')):
        raise RecoveryError('database identity prerequisite failed')
    if previous is not None and identity != previous:
        raise RecoveryError('database identity changed during recovery validation')
    return identity


def local(action, env_path, role, project, *, helper_source=None, expected=None):
    if not project or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for c in project):
        raise RecoveryError('invalid project identity')
    p = paths(env_path)
    if action == 'run':
        if p['paused'].exists():
            return {'paused': True}
        if p['uncertain'].exists():
            raise RecoveryError('unresolved Docker operation; operator review required')
        manifest = read_manifest(p)
        if (manifest.get('project') != project or manifest.get('role') != role or
                manifest.get('env_file') != str(p['env']) or manifest.get('schema_version') != 1 or
                not manifest.get('database_identity') or
                any(not p[name].is_file() or sha(p[name]) != manifest.get(name + '_sha256') for name in ('helper', 'manager'))):
            raise RecoveryError('recovery integrity check failed; reinstall from approved source')
        execute(['/usr/bin/python3', str(p['helper']), '--env-file', str(p['env']), '--role', role,
                 '--expected-project', project, '--expected-identity', json.dumps(manifest['database_identity'])])
        return {'reconciled': True}
    text = execute(['crontab', '-l'], allow_missing_crontab=True)
    if action == 'status':
        return status(p, role, project, text, expected)
    # One lock for installation and all control operations. Cron's helper has
    # a separate reconciliation lock; acquire that too before maintenance changes.
    with (p['root'] / '.recovery-management.lock').open('w') as lock, (p['root'] / '.boot-recover.lock').open('a') as runtime_lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        fcntl.flock(runtime_lock, fcntl.LOCK_EX)
        text = execute(['crontab', '-l'], allow_missing_crontab=True)
        if action == 'pause':
            atomic(p['paused'], b'operator maintenance\n')
            if p['uncertain'].exists():
                raise RecoveryError('paused, but Docker operation is unresolved; inspect before maintenance')
        elif action == 'resume':
            current = status(p, role, project, text, expected)
            if current['uncertain_operation']:
                raise RecoveryError('unresolved Docker operation; cannot resume before operator review')
            if not (current['installed'] and current['checksums_valid'] and current['version_current']):
                raise RecoveryError('cannot resume missing or drifted installation')
            # Validate without clearing the real maintenance marker. --check-only
            # ignores that marker but never starts services.
            prerequisites(p, role, project, p['helper'], allow_paused=True)
            p['paused'].unlink(missing_ok=True)
        elif action == 'install':
            source = Path(helper_source) if helper_source else ROOT / 'deploy/boot-recover.py'
            content = source.read_bytes()
            manager_content = Path(__file__).read_bytes()
            calculated = {'helper': hashlib.sha256(content).hexdigest(), 'manager': hashlib.sha256(manager_content).hexdigest()}
            if expected and calculated != expected:
                raise RecoveryError('staged recovery checksum mismatch')
            # Verify staged bytes before allowing any helper execution.
            identity = prerequisites(p, role, project, source)
            if source.read_bytes() != content:
                raise RecoveryError('staged helper changed during validation')
            replacement = rewritten_cron(text, p, role, project, True)
            expected = calculated
            before = status(p, role, project, text, expected)
            if before['installed'] and before['checksums_valid'] and before['version_current']:
                return before
            backup = Path(tempfile.mkdtemp(prefix='.recovery-backup-', dir=p['root']))
            atomic(backup / 'crontab', text.encode())
            originals = {name: p[name].read_bytes() if p[name].exists() else None for name in ('helper', 'manager', 'manifest')}
            for name, data in originals.items():
                if data is not None:
                    atomic(backup / name, data)
            try:
                p['helper'].parent.mkdir(exist_ok=True)
                atomic(p['helper'], content, 0o644)
                atomic(p['manager'], manager_content, 0o644)
                manifest = {'schema_version': 1, 'project': project, 'role': role, 'env_file': str(p['env']),
                            'database_identity': identity,
                            'helper_sha256': sha(p['helper']), 'manager_sha256': sha(p['manager']),
                            'installed_at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
                atomic(p['manifest'], (json.dumps(manifest, indent=2) + '\n').encode())
                if execute(['crontab', '-l'], allow_missing_crontab=True) != text:
                    raise RecoveryError('crontab changed during installation; refusing stale write')
                execute(['crontab', '-'], input=replacement)
                observed = execute(['crontab', '-l'], allow_missing_crontab=True)
                if observed != replacement:
                    raise RecoveryError('crontab changed during installation')
            except Exception:
                for name, data in originals.items():
                    if data is None:
                        p[name].unlink(missing_ok=True)
                    else:
                        atomic(p[name], data, 0o600 if name == 'manifest' else 0o644)
                # Do not overwrite another actor's concurrent crontab edit.
                observed = execute(['crontab', '-l'], allow_missing_crontab=True)
                if observed == replacement:
                    execute(['crontab', '-'], input=text)
                raise
        elif action == 'uninstall':
            replacement = rewritten_cron(text, p, role, project, False)
            if replacement != text:
                backup = Path(tempfile.mkdtemp(prefix='.recovery-backup-', dir=p['root']))
                atomic(backup / 'crontab', text.encode())
                if execute(['crontab', '-l'], allow_missing_crontab=True) != text:
                    raise RecoveryError('crontab changed during uninstall; refusing stale write')
                execute(['crontab', '-'], input=replacement)
            # Preserve source, manifest, backups and pause marker for recovery.
        else:
            raise RecoveryError('unknown local command')
        return status(p, role, project, execute(['crontab', '-l'], allow_missing_crontab=True), expected)


def manage(cfg, action, approved=False, node='all'):
    if action in MUTATIONS and not approved:
        raise RecoveryError('recovery mutation requires --approve')
    nodes = [n for n in cfg['nodes'] if node == 'all' or n['name'] == node]
    if not nodes:
        raise RecoveryError('unknown node')
    expected = {'helper': sha(ROOT / 'deploy/boot-recover.py'), 'manager': sha(Path(__file__))}
    results = []
    for item in nodes:
        role = 'secondary' if item['role'] == 'standby' else item['role']
        directory = checked_path(Path(item['deployment_dir']), resolve=False)
        env = checked_path(directory / item['env_file'], resolve=False)
        if not directory.is_absolute() or role not in ('primary', 'secondary') or str(directory) == '/':
            raise RecoveryError('invalid deployment directory or role')
        if env.parent != directory:
            raise RecoveryError('env file must be inside its deployment directory')
        ssh = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', item['ssh_alias']]
        remote_script = directory / 'deploy/recovery.py'
        stage = None
        try:
            if action == 'install':
                stage = execute(ssh + [shlex.join(['mktemp', '-d', str(directory / '.recovery-stage-XXXXXX')])]).strip()
                if Path(stage).parent != directory or not Path(stage).name.startswith('.recovery-stage-'):
                    raise RecoveryError('invalid staging directory')
                execute(['scp', '-q', str(Path(__file__)), str(ROOT / 'deploy/boot-recover.py'), item['ssh_alias'] + ':' + stage + '/'])
                remote_script = Path(stage) / 'recovery.py'
            command = ['/usr/bin/python3', str(remote_script), '--local', '--env-file', str(env),
                       '--role', role, '--project', item['project'], '--expected', json.dumps(expected), action]
            if stage:
                command += ['--helper-source', str(Path(stage) / 'boot-recover.py')]
            result = json.loads(execute(ssh + [shlex.join(command)], timeout=600))
            results.append({'node': item['name'], **result})
        except (RecoveryError, ValueError, OSError, subprocess.TimeoutExpired) as error:
            raise RecoveryError(f'{item["name"]}: recovery {action} failed; {len(results)} nodes completed; check status before retry') from error
        finally:
            if stage:
                # Remove only the two exact files we staged, never recursive paths.
                execute(ssh + [shlex.join(['rm', '-f', str(Path(stage) / 'recovery.py'), str(Path(stage) / 'boot-recover.py')])])
                execute(ssh + [shlex.join(['rmdir', stage])])
    return {'command': action, 'nodes': results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--local', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--env-file', type=Path)
    parser.add_argument('--role', choices=['primary', 'secondary'])
    parser.add_argument('--project')
    parser.add_argument('--expected', type=json.loads)
    parser.add_argument('action', choices=['install', 'status', 'pause', 'resume', 'uninstall', 'run'])
    parser.add_argument('--helper-source', type=Path)
    args = parser.parse_args()
    if not args.local or not all((args.env_file, args.role, args.project)):
        parser.error('use deploy/cutover.py recovery for controller operations')
    try:
        print(json.dumps(local(args.action, args.env_file, args.role, args.project, helper_source=args.helper_source, expected=args.expected), sort_keys=True))
    except RecoveryError as error:
        print('recovery operation failed: ' + str(error), file=sys.stderr)
        return 1
    except (OSError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        print('recovery operation failed: ' + type(error).__name__, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
