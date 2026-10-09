#!/usr/bin/env python3
"""Build and publish compact, versioned Beatmap Lens annotation snapshots."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import sys

from snapshot import build_snapshot, validate_snapshot


REPO = Path(__file__).resolve().parents[2]
REPOSITORY = 'https://github.com/ensomi-labs/beatmap-lens'


def read(path):
    return json.loads(Path(path).read_text())


def write_new(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x') as output:
        output.write(json.dumps(value, indent=2, ensure_ascii=False) + '\n')


def collect(workspace, output, workers=1):
    command = ['node', str(REPO/'apps/inspector/server/collect-annotation-release.mjs'),
               '--workspace', str(Path(workspace).resolve()), '--out', str(Path(output).resolve()),
               '--workers', str(workers)]
    subprocess.run(command, cwd=REPO, check=True)


def prepare_config(projection_path, output):
    """Prepare project defaults and explicit missing immutable artifact references."""
    projection = read(projection_path)
    if projection.get('contract') != 'beatmap-lens-release-input' or projection.get('version') != 1:
        raise ValueError('Expected a collected V2 release input.')
    output = Path(output)
    if output.exists():
        raise ValueError('Preparation output already exists; choose a new directory.')
    sources = {source['sha256']: source for source in projection['sources']}
    foundations = {}
    for frozen, foundation in projection['foundations'].items():
        artifact = projection['foundation_artifacts'][frozen]
        content = artifact['content'].encode('utf-8')
        if hashlib.sha256(content).hexdigest() != artifact['sha256']:
            raise ValueError('Collected public Foundation artifact checksum differs.')
        for example in foundation['calibrationExamples']:
            sources[example['source']['sha256']] = example['source']
        foundations[frozen] = {
            'artifact': {'repository': REPOSITORY, 'commit': None,
                         'path': f'annotation/foundations/{frozen}.json', 'sha256': artifact['sha256']},
            'relationship': 'source-bytes-referenced',
        }
    entrypoint = Path(__file__).resolve()
    config = {
        'release_id': datetime.now(timezone.utc).strftime('%Y-%m-%d') + '.1',
        'repo_id': 'sed-i/mania-pattern-annotations', 'title': 'osu!mania pattern annotations', 'license': 'mit',
        'exporter': {'repository': REPOSITORY, 'commit': None,
                     'path': entrypoint.relative_to(REPO).as_posix(),
                     'sha256': hashlib.sha256(entrypoint.read_bytes()).hexdigest()},
        'sources': {sha: {'kind': 'osu' if (source.get('beatmapId') or 0) > 0 else 'hf',
                          'repository': None, 'commit': None, 'path': None, 'record_key': None,
                          'uri': f'https://osu.ppy.sh/osu/{source["beatmapId"]}'
                          if (source.get('beatmapId') or 0) > 0 else None}
                    for sha, source in sorted(sources.items())},
        'foundations': foundations,
        'methods': {key: {'artifacts': {}, 'provenance_status': 'partial'}
                    for key in sorted(projection['methods'])},
        'policy': {'agent_methods': [], 'auxiliary_evidence': ['current'],
                   'allow_partial_method_provenance': False, 'excluded_sources': {},
                   'human_precedence': True},
        'previous_snapshot': None, 'removals': {},
    }
    output.mkdir(parents=True)
    for frozen, artifact in projection['foundation_artifacts'].items():
        target = output/'foundations'/f'{frozen}.json'
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(artifact['content'].encode('utf-8'))
    write_new(output/'release.json', config)
    summary = {
        'ready_to_publish': False,
        'sources': len(projection['sources']), 'human_candidates': len(projection['human']),
        'agent_candidates': len(projection['agents']), 'methods': len(projection['methods']),
        'required_configuration': ['exporter.commit',
                                   'sources: verify exact bytes at public content locators',
                                   'foundations: published GitHub artifact commits'],
        'config': str(output/'release.json'),
    }
    write_new(output/'preparation.json', summary)
    return summary


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    gather = commands.add_parser('collect', help='Freeze a read-only projection from a Review workspace')
    gather.add_argument('--workspace', required=True)
    gather.add_argument('--out', required=True)
    gather.add_argument('--workers', type=int, default=1, help='Parallel source validators (default: 1)')
    initialize = commands.add_parser('init', help='Prepare configuration and public Foundation reference artifacts')
    initialize.add_argument('--input', required=True)
    initialize.add_argument('--out', required=True)
    build = commands.add_parser('build', help='Build a new local HF snapshot; no upload')
    build.add_argument('--input', required=True)
    build.add_argument('--config', required=True)
    build.add_argument('--out', required=True)
    build.add_argument('--previous', help='Validated local copy of the previous HF snapshot')
    check = commands.add_parser('validate', help='Verify local snapshot files and semantics')
    check.add_argument('snapshot')
    plan = commands.add_parser('plan', help='Read-only remote reference and upload preview')
    plan.add_argument('snapshot')
    publish = commands.add_parser('publish', help='Publish a validated snapshot in one guarded HF commit')
    publish.add_argument('snapshot')
    publish.add_argument('--create-repo', action='store_true', help='Explicitly create the destination if absent')
    publish.add_argument('--public', action='store_true', help='Create a public repository (only with --create-repo)')
    publish.add_argument('--receipt', required=True, help='Write the returned HF commit identity outside the snapshot')
    args = parser.parse_args(argv)
    if args.command == 'collect':
        collect(args.workspace, args.out, args.workers)
        return 0
    if args.command == 'init':
        result = prepare_config(args.input, args.out)
    elif args.command == 'build':
        result = build_snapshot(read(args.input), read(args.config), Path(args.out),
                                previous=Path(args.previous) if args.previous else None)
    elif args.command == 'validate':
        result = validate_snapshot(Path(args.snapshot))
    elif args.command == 'plan':
        from publish import plan_publication
        result = plan_publication(Path(args.snapshot))
    else:
        from publish import publish_snapshot
        receipt = Path(args.receipt).resolve()
        snapshot = Path(args.snapshot).resolve()
        if receipt == snapshot or snapshot in receipt.parents:
            raise ValueError('Publication receipt must be outside the immutable snapshot.')
        if receipt.exists():
            raise ValueError('Receipt already exists; choose a new receipt path.')
        if args.public and not args.create_repo:
            raise ValueError('--public only sets visibility when explicitly creating a repository.')
        result = publish_snapshot(snapshot, create_repo=args.create_repo, private=not args.public)
        # Print the immutable identity before receipt I/O so a write failure cannot hide a commit.
        print(json.dumps(result, ensure_ascii=False), flush=True)
        write_new(receipt, result)
        return 0
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
