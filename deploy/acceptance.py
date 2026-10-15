#!/usr/bin/env python3
"""Test a locally built production image in an isolated two-replica environment."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import socket
import signal
import subprocess
import sys
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[1]


def run(argv, *, env=None, capture=False, timeout=900):
    return subprocess.run(argv, cwd=ROOT, env=env, text=True, check=True,
                          capture_output=capture, timeout=timeout)


def harness_digest():
    paths = [ROOT / 'compose.integration.yaml', ROOT / 'compose.acceptance.yaml', Path(__file__),
             ROOT / 'web/playwright.acceptance.config.ts', ROOT / 'web/tsconfig.acceptance.json']
    paths += sorted((ROOT / 'tests/acceptance').glob('*.mjs'))
    paths += sorted((ROOT / 'web/acceptance').glob('*.ts'))
    digest = hashlib.sha256()
    for path in sorted(paths):
        digest.update(str(path.relative_to(ROOT)).encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


def free_ports(count):
    # Hold all reservations simultaneously to ensure distinct ports. Docker
    # still fails closed if another process claims one after reservations close.
    sockets = [socket.socket() for _ in range(count)]
    try:
        for sock in sockets: sock.bind(('127.0.0.1', 0))
        return [sock.getsockname()[1] for sock in sockets]
    finally:
        for sock in sockets: sock.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', help='existing local image to certify; omitted builds Dockerfile locally')
    parser.add_argument('--report', required=True, type=Path)
    parser.add_argument('--gyermelyi-config', type=Path, help='external private-input JSON; never a production database or bucket')
    args = parser.parse_args()
    def interrupted(_signum, _frame): raise KeyboardInterrupt('acceptance interrupted')
    signal.signal(signal.SIGTERM, interrupted)
    report_path = args.report.resolve()
    report_path.parent.mkdir(parents=True, exist_ok=True)
    # Never let an earlier passing report survive a failed retry.
    report = {'schema_version': 1, 'suite': 'stateful-production-image', 'status': 'running',
              'created_at': dt.datetime.now(dt.timezone.utc).isoformat(),
              'harness_sha256': harness_digest(), 'geography_verified': False}
    report_path.write_text(json.dumps(report, indent=2) + '\n')
    revision = run(['git', 'rev-parse', 'HEAD'], capture=True).stdout.strip()
    otto_revision = run(['git', 'rev-parse', 'HEAD:vendor/otto'], capture=True).stdout.strip()
    project = 'cursus-acceptance-' + uuid.uuid4().hex[:10]
    image = args.image or f'cursus-acceptance:{project}'
    report['checkout_revision'] = revision
    report['checkout_dirty'] = bool(run(['git', 'status', '--porcelain'], capture=True).stdout.strip())
    environment = os.environ.copy()
    compose = None
    private_compose = None
    started = False
    try:
        if not args.image:
            run(['docker', 'build', '--build-arg', f'CURSUS_REVISION={revision}', '--build-arg',
                 f'OTTO_REVISION={otto_revision}', '-t', image, '.'])
        inspected = json.loads(run(['docker', 'image', 'inspect', image], capture=True).stdout)[0]
        labels = inspected['Config']['Labels'] or {}
        for key in ['io.artalis.cursus.schema.minimum', 'io.artalis.cursus.schema.maximum']:
            if labels.get(key) != '1': raise ValueError('image must declare supported schema version 1')
        report.update(image_id=inspected['Id'], architecture=inspected['Architecture'],
                      image_revision=labels.get('org.opencontainers.image.revision'),
                      otto_revision=labels.get('io.artalis.otto.revision'))
        with tempfile.TemporaryDirectory(prefix=project + '-') as scratch:
            path = Path(scratch)
            path.chmod(0o755)  # disposable fixture credentials, readable by UID 10001
            for name, value in {'database-url': 'postgres://cursus:integration-only@postgres:5432/cursus',
                                'access-key': 'integration', 'secret-key': 'integration',
                                'allowlist': 'admin@acceptance.example.test',
                                'unused-map.vlg': 'not a geographic index; unused by this suite'}.items():
                (path / name).write_text(value + '\n')
                (path / name).chmod(0o444)
            pg, s3, a, b = free_ports(4)
            environment.update(CURSUS_ACCEPTANCE_IMAGE=inspected['Id'], CURSUS_ACCEPTANCE_SCRATCH=scratch,
                               CURSUS_TEST_POSTGRES_PORT=str(pg), CURSUS_TEST_S3_PORT=str(s3),
                               CURSUS_ACCEPTANCE_PORT_A=str(a), CURSUS_ACCEPTANCE_PORT_B=str(b),
                               CURSUS_ACCEPTANCE_ORIGIN=f'http://127.0.0.1:{a}')
            compose = ['docker', 'compose', '--env-file', '/dev/null', '-p', project,
                       '-f', str(ROOT / 'compose.integration.yaml'), '-f', str(ROOT / 'compose.acceptance.yaml')]
            if args.gyermelyi_config:
                private_path = args.gyermelyi_config.resolve(strict=True)
                if private_path.is_relative_to(ROOT): raise ValueError('private configuration must remain outside the checkout')
                settings = json.loads(private_path.read_text())
                private_volumes = []
                for key, target, directory in [('datasetRoot', '/private/customer', True), ('orders', '/private/orders.csv', False),
                                               ('pbf', '/private/map.osm.pbf', False), ('graph', '/private/map.vlg', False),
                                               ('geocodeCache', '/private/geocode-input', True)]:
                    source = Path(settings[key]).resolve(strict=True)
                    if source.is_relative_to(ROOT) or source.is_dir() != directory:
                        raise ValueError('private inputs must be external existing files/directories of the expected type')
                    private_volumes.append({'type': 'bind', 'source': str(source), 'target': target, 'read_only': True,
                                            'bind': {'create_host_path': False}})
                if not 0 < settings['minimumServedFraction'] <= 1: raise ValueError('set minimumServedFraction in (0,1]')
                private_volumes.append({'type': 'bind', 'source': str(private_path), 'target': '/private/config.json',
                                        'read_only': True, 'bind': {'create_host_path': False}})
                override = path / 'private.compose.json'
                override.write_text(json.dumps({'services': {'fixture': {'volumes': private_volumes, 'environment': {
                    'DATASET_ROOT': '/private/customer', 'GEOCODE_PBF': '/private/map.osm.pbf', 'VELO_GRAPH': '/private/map.vlg',
                    'GEOCODE_CACHE_DIR': '/tmp/private-geocode-cache', 'DISPATCH_GEOCODE_OFFLINE': '1'}}}}))
                private_compose = compose + ['-f', str(override)]
            def dc(*argv, capture=False): return run(compose + list(argv), env=environment, capture=capture)
            dc('config', '--quiet')
            started = True
            dc('up', '-d', '--wait', 'postgres', 's3-test')
            seeded = dc('run', '--rm', '-T', 'fixture', 'seed', capture=True)
            report['fixture'] = json.loads(seeded.stdout.strip().splitlines()[-1])
            dc('up', '-d', '--wait', 'app-a', 'app-b')
            # Both HTTP replicas must be running the exact image being certified.
            for service in ['app-a', 'app-b']:
                cid = dc('ps', '-q', service, capture=True).stdout.strip()
                actual = run(['docker', 'inspect', cid, '--format', '{{.Image}}'], capture=True).stdout.strip()
                if actual != inspected['Id']: raise ValueError('candidate image identity changed')
            browser_report = report_path.with_suffix('.playwright.json')
            environment.update(VIEWER_URL=f'http://127.0.0.1:{a}', CURSUS_ACCEPTANCE_PEER=f'http://127.0.0.1:{b}',
                               CURSUS_ACCEPTANCE_COMPOSE=json.dumps(compose),
                               CURSUS_ACCEPTANCE_BROWSER_REPORT=str(browser_report),
                               CURSUS_ACCEPTANCE_OUTPUT_DIR=str(report_path.with_suffix('.artifacts')))
            run(['npm', '--prefix', 'web', 'run', 'test:acceptance'], env=environment)
            stats = json.loads(browser_report.read_text())['stats']
            if stats['unexpected'] or stats['flaky'] or stats['skipped'] or stats['expected'] < 7:
                raise ValueError('release acceptance requires all seven or more tests passing without skips or retries')
            report['browser'] = stats
            if args.gyermelyi_config:
                # Keep private artifacts out of browser traces and CI uploads.
                # Workers stop before the isolated lease/takeover exercise.
                dc('stop', 'app-a', 'app-b')
                private = run(private_compose + ['run', '--rm', '-T', '--entrypoint', 'node', 'fixture',
                                                '/acceptance/private-workflow.mjs'], env=environment, capture=True, timeout=1800)
                report['private_workflow'] = json.loads(private.stdout.strip().splitlines()[-1])
            else:
                report['private_workflow'] = {'status': 'not_requested'}
            report['runtime'] = json.loads(dc('run', '--rm', '-T', 'fixture', 'evidence', capture=True).stdout.strip().splitlines()[-1])
            report['status'] = 'passed'
    except BaseException as error:
        report['status'] = 'failed'
        report['error'] = str(error)
        if isinstance(error, subprocess.CalledProcessError) and error.cmd[-1] == 'seed':
            report_path.with_suffix('.fixture.log').write_text((error.stdout or '') + (error.stderr or ''))
        if compose and started:
            # Contains exclusively synthetic fixture data and test credentials.
            logs = subprocess.run(compose + ['logs', '--no-color', '--tail', '80'], cwd=ROOT, env=environment,
                                  capture_output=True, text=True, check=False, timeout=30)
            report_path.with_suffix('.compose.log').write_text(logs.stdout + logs.stderr)
        raise
    finally:
        if compose and started:
            # Exact random project; never target a production or developer stack.
            cleaned = subprocess.run(compose + ['down', '--volumes', '--remove-orphans'], cwd=ROOT, env=environment,
                                     check=False, timeout=120)
            report['cleanup_completed'] = cleaned.returncode == 0
            if cleaned.returncode: report['status'] = 'failed'
        report['finished_at'] = dt.datetime.now(dt.timezone.utc).isoformat()
        report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + '\n')
    if report['status'] != 'passed': raise ValueError('acceptance teardown did not complete')
    print(f'Acceptance passed for {report["image_id"]}; evidence: {report_path}')


if __name__ == '__main__':
    try: main()
    except (subprocess.SubprocessError, ValueError, OSError, KeyError) as exc:
        print(f'acceptance failed: {exc}', file=sys.stderr)
        raise SystemExit(1)
