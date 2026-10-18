#!/usr/bin/env python3
"""Reconcile an existing Compose deployment after boot; never initialize/promote DBs."""
import argparse
import fcntl
import ipaddress
import json
import pathlib
import subprocess


def run(args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=120)
    if result.returncode:
        # Docker/Compose errors can include configuration. Do not log raw output.
        raise RuntimeError('command failed: ' + args[0])
    return result.stdout


def env_values(path):
    values = {}
    for line in path.read_text().splitlines():
        if line.strip() and not line.lstrip().startswith('#') and '=' in line:
            key, value = line.split('=', 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def validate(env, role, local_ips, database_role=None):
    bind = env['CURSUS_POSTGRES_BIND_IP']
    address = ipaddress.ip_address(bind)
    if not address.is_private or address.is_unspecified or address.is_loopback:
        raise ValueError('database bind must be a dedicated private address')
    if bind not in local_ips:
        raise ValueError('private database interface not ready; retry later')
    if database_role is None:
        data = pathlib.Path(env['CURSUS_POSTGRES_DATA_PATH'])
        if not (data / 'PG_VERSION').is_file():
            raise ValueError('existing database required; initialization forbidden')
        standby = (data / 'standby.signal').is_file()
    else:
        if database_role not in ('primary', 'secondary'):
            raise ValueError('existing database required; initialization forbidden')
        standby = database_role == 'secondary'
    if standby != (role == 'secondary'):
        raise ValueError('database role mismatch; promotion/reinitialization forbidden')


def binding_missing(inspect, bind, port):
    actual = inspect.get('NetworkSettings', {}).get('Ports', {}).get('5432/tcp') or []
    return not any(p.get('HostIp') == bind and p.get('HostPort') == str(port) for p in actual)


def validate_mount(current, desired, configured_path):
    target = '/var/lib/postgresql/data'
    actual = [m for m in current.get('Mounts', []) if m.get('Destination') == target]
    requested = [m for m in desired.get('volumes', []) if m.get('target') == target]
    if (len(actual) != 1 or len(requested) != 1 or actual[0].get('Type') != 'bind' or
            requested[0].get('type') != 'bind' or actual[0].get('RW') is not True or
            actual[0].get('Source') != configured_path or requested[0].get('source') != configured_path):
        raise ValueError('database mount drift; refusing to replace authoritative storage')
    return actual[0]['Source']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', required=True, type=pathlib.Path)
    parser.add_argument('--role', required=True, choices=['primary', 'secondary'])
    parser.add_argument('--check-only', action='store_true', help='validate prerequisites without reconciling services')
    parser.add_argument('--expected-project', required=True)
    parser.add_argument('--expected-identity', type=json.loads)
    args = parser.parse_args()
    env_path = args.env_file.resolve()
    if (env_path.parent / '.boot-recover-paused').exists() and not args.check_only:
        print('Recovery paused for operator maintenance')
        return
    with (env_path.parent / '.boot-recover.lock').open('w') as lock:
        if not args.check_only:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return
            # A pause may have completed after our early check but before this
            # lock acquisition. No actions may cross that maintenance boundary.
            if (env_path.parent / '.boot-recover-paused').exists():
                print('Recovery paused for operator maintenance')
                return
        env = env_values(env_path)
        if env.get('COMPOSE_PROJECT_NAME') != args.expected_project:
            raise ValueError('deployment project drift')
        if not args.check_only and not args.expected_identity:
            raise ValueError('pinned database identity required for automatic recovery')
        ips = {a['local'] for i in json.loads(run(['ip', '-j', 'address'])) for a in i.get('addr_info', [])}
        project = env['COMPOSE_PROJECT_NAME']
        service = 'postgres' if args.role == 'primary' else 'postgres-standby'
        container = f'{project}-{service}-1'
        current = json.loads(run(['docker', 'inspect', container]))[0]
        # Only adopt existing named resources; do not initialize a new cluster.
        if current.get('Config', {}).get('Labels', {}).get('com.docker.compose.project') != project:
            raise ValueError('container ownership mismatch')
        compose = ['docker', 'compose', '--project-directory', str(env_path.parent),
                   '--env-file', str(env_path), '-f', str(env_path.parent / 'compose.stateful.yaml'),
                   '--profile', 'database-primary' if args.role == 'primary' else 'database-standby']
        desired = json.loads(run(compose + ['config', '--format', 'json']))
        mount = validate_mount(current, desired['services'][service], env['CURSUS_POSTGRES_DATA_PATH'])
        # Read only the existing container's verified mount, never an unrelated
        # initialized directory substituted through .env. pg_controldata works
        # even when the database is stopped; no DB startup is required to inspect.
        probe = run(['docker', 'run', '--rm', '--pull', 'never', '--network', 'none',
                     '--read-only', '--entrypoint', 'sh', '--mount',
                     f'type=bind,source={mount},target=/db,readonly', current['Image'], '-ec',
                     'test -s /db/PG_VERSION; if test -e /db/standby.signal; then echo secondary; else echo primary; fi; '
                     'LC_ALL=C pg_controldata /db | sed -n "s/^Database system identifier: *//p"']).splitlines()
        if len(probe) != 2 or not probe[1].isdigit():
            raise ValueError('cannot establish PostgreSQL cluster identity')
        validate(env, args.role, ips, probe[0])
        identity = {'project': project, 'service': service, 'pgdata': mount, 'system_identifier': probe[1]}
        if args.expected_identity is not None and identity != args.expected_identity:
            raise ValueError('database cluster identity drift')
        hashes = dict(line.split() for line in run(compose + ['config', '--hash', '*']).splitlines())
        for name in (service, 'velo', 'carta', 'cursus'):
            existing = json.loads(run(['docker', 'inspect', f'{project}-{name}-1']))[0]
            labels = existing.get('Config', {}).get('Labels', {})
            if (labels.get('com.docker.compose.project') != project or not hashes.get(name) or
                    labels.get('com.docker.compose.config-hash') != hashes[name]):
                raise ValueError('Compose configuration drift; recovery is not a deployment')
            expected = json.loads(run(['docker', 'image', 'inspect', desired['services'][name]['image']]))[0]['Id']
            if existing['Image'] != expected:
                raise ValueError('image drift; recovery may not perform an application upgrade')
        if args.check_only:
            print(json.dumps({'database_identity': identity, 'services_changed': False}))
            return
        start = ['up', '-d', '--no-deps', '--no-build', '--pull', 'never']
        if binding_missing(current, env['CURSUS_POSTGRES_BIND_IP'], env.get('CURSUS_POSTGRES_HOST_PORT', '55432')):
            # Docker can report a healthy DB after boot with its configured
            # host port absent. Recreate only this container, preserving PGDATA.
            run(compose + start + ['--force-recreate', service])
        elif not current.get('State', {}).get('Running'):
            run(compose + start + ['--no-recreate', service])
        for name in ('velo', 'carta', 'cursus'):
            run(compose + start + ['--no-recreate', name])
        print('Existing Compose services reconciled; verify readiness and replication separately')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, ValueError, KeyError, OSError, subprocess.TimeoutExpired) as error:
        print('Recovery deferred: ' + (str(error) if isinstance(error, (ValueError, RuntimeError)) else type(error).__name__))
        raise SystemExit(1)
