"""Validate, plan, and atomically publish an annotation snapshot to the HF Hub."""
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import re
import shutil
import tempfile
import time
from urllib.parse import quote, urlsplit

import httpx
from huggingface_hub import CommitOperationAdd, CommitOperationDelete, HfApi, RepoFile, hf_hub_download
from huggingface_hub.errors import EntryNotFoundError, RepositoryNotFoundError
import pyarrow.parquet as pq

from snapshot import JUDGMENT_SCHEMAS, validate_snapshot


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text())


def _owned_path(path):
    return path in ('README.md', 'LICENSE', 'manifest.json') or bool(
        re.fullmatch(r'data/(?:sources|human|agent/[A-Za-z0-9][A-Za-z0-9._-]*)\.parquet', path))


def _public_artifact_url(ref):
    repository = urlsplit(ref['repository'].removesuffix('.git'))
    if repository.scheme != 'https' or repository.netloc != 'github.com':
        raise ValueError('Artifact repository must be a public HTTPS GitHub repository.')
    if not re.fullmatch(r'/[\w.-]+/[\w.-]+', repository.path):
        raise ValueError('Artifact repository must identify one GitHub repository.')
    if not re.fullmatch(r'[0-9a-f]{40}', ref['commit']):
        raise ValueError('Artifact reference requires a full Git commit.')
    path = ref['path']
    if not path or path.startswith('/') or '..' in path.split('/'):
        raise ValueError('Artifact path must be relative to its repository.')
    return f'https://raw.githubusercontent.com{repository.path}/{ref["commit"]}/{quote(path)}'


def verify_public_references(snapshot, manifest, api=None):
    """Verify public artifacts and source locators, without loading corpus shards."""
    api = api or HfApi()
    references = [manifest['exporter']]
    references.extend({**manifest['exporter'], 'path': name, 'sha256': sha}
                      for name, sha in manifest['exporter_files'].items())
    references.extend(entry['artifact'] for entry in manifest['foundations'].values())
    for method in manifest['methods'].values():
        references.extend(ref for ref in method.get('artifacts', {}).values() if ref)
        if method.get('evaluation'):
            references.append(method['evaluation'])
    checked = set()
    sources = {'content_verified': 0, 'locator_verified': 0}
    next_osu_request = 0
    with httpx.Client(follow_redirects=True, timeout=60) as client:
        for ref in references:
            url = _public_artifact_url(ref)
            key = (url, ref['sha256'])
            if key in checked:
                continue
            response = client.get(url)
            response.raise_for_status()
            if digest(response.content) != ref['sha256']:
                raise ValueError(f'Published artifact checksum differs: {url}')
            checked.add(key)
        for source in pq.read_table(Path(snapshot)/'data/sources.parquet').to_pylist():
            if manifest.get('policy', {}).get('source_access', 'verified') == 'metadata-only':
                sources['identity_only'] = sources.get('identity_only', 0) + 1
                continue
            ref = source['source_ref']
            if ref['kind'] in ('content-addressed', 'osu', 'url'):
                if ref['kind'] == 'osu':
                    time.sleep(max(0, next_osu_request - time.monotonic()))
                    next_osu_request = time.monotonic() + 1
                response = client.get(ref['uri'])
                response.raise_for_status()
                if digest(response.content) != source['source_sha256']:
                    raise ValueError(f'Source content checksum differs: {source["source_sha256"]}')
                sources['content_verified'] += 1
            elif ref['record_key'] is None:
                path = hf_hub_download(repo_id=ref['repository'], filename=ref['path'],
                                       revision=ref['commit'], repo_type='dataset', token=False)
                if digest(Path(path).read_bytes()) != source['source_sha256']:
                    raise ValueError(f'Source content checksum differs: {source["source_sha256"]}')
                sources['content_verified'] += 1
            else:
                # The collector checked the original bytes. A corpus row locator does
                # not imply that this publisher implements that corpus's record decoder.
                key = (ref['repository'], ref['commit'], ref['path'])
                if key not in checked:
                    paths = api.get_paths_info(ref['repository'], [ref['path']],
                                               revision=ref['commit'], repo_type='dataset', token=False)
                    if (not paths or not isinstance(paths[0], RepoFile)
                            or paths[0].path != ref['path']):
                        raise ValueError(f'Source corpus file is unavailable: {ref["path"]}')
                    checked.add(key)
                sources['locator_verified'] += 1
    return {'artifact_count': len(references), 'sources': sources}


def _remote_manifest(api, repo_id, commit):
    try:
        path = hf_hub_download(repo_id=repo_id, filename='manifest.json', revision=commit,
                               repo_type='dataset', token=api.token)
    except EntryNotFoundError:
        return None, None
    raw = Path(path).read_bytes()
    value = json.loads(raw)
    if value.get('contract') != 'beatmap-lens-annotations' or value.get('version') not in JUDGMENT_SCHEMAS:
        raise ValueError('The destination contains an unrelated dataset manifest.')
    if value.get('repo_id') != repo_id:
        raise ValueError('The destination manifest identifies another repository.')
    if not all(_owned_path(name) for name in value['files']):
        raise ValueError('The previous manifest contains paths outside this pipeline.')
    return value, digest(raw)


def _verify_remote_files(api, repo_id, commit, manifest):
    for name, metadata in manifest['files'].items():
        path = hf_hub_download(repo_id=repo_id, filename=name, revision=commit,
                               repo_type='dataset', token=api.token)
        if digest(Path(path).read_bytes()) != metadata['sha256']:
            raise ValueError(f'Existing snapshot file differs from its manifest: {name}')


def plan_publication(snapshot, api=None, reference_verifier=verify_public_references):
    """Read-only preview. A plan does not create repositories, commits, or tags."""
    snapshot = Path(snapshot)
    validate_snapshot(snapshot)
    manifest = read_json(snapshot/'manifest.json')
    if not manifest['counts']['human']:
        raise ValueError('The default human configuration has no publishable rows.')
    empty_methods = [name for name, count in manifest['counts']['agents'].items() if not count]
    if empty_methods:
        raise ValueError('Selected agent configurations have no publishable rows; deselect them or revise admission: ' + ', '.join(empty_methods))
    api = api or HfApi()
    verification = reference_verifier(snapshot, manifest, api)
    repo_id = manifest['repo_id']
    try:
        info = api.repo_info(repo_id, repo_type='dataset', revision='main')
    except RepositoryNotFoundError:
        # This can also mean inaccessible. Creation is an explicit CLI option and
        # still fails normally if the user lacks access; never infer permission.
        return {'repo_id': repo_id, 'release_id': manifest['release_id'],
                'exists': False, 'parent_commit': None, 'already_published': False,
                'add': sorted([*manifest['files'], 'manifest.json']), 'delete': [],
                'reference_checks': verification}
    parent = info.sha
    previous, old_digest = _remote_manifest(api, repo_id, parent)
    old_files = set(previous['files']) | {'manifest.json'} if previous else set()
    remote_files = set(api.list_repo_files(repo_id, repo_type='dataset', revision=parent))
    unmanaged = remote_files - old_files - {'.gitattributes', 'README.md'}
    if unmanaged:
        raise ValueError('Destination has files outside the previous snapshot: ' + ', '.join(sorted(unmanaged)))
    same = old_digest == digest((snapshot/'manifest.json').read_bytes())
    if previous and old_files - remote_files:
        raise ValueError('The destination is missing files declared by its snapshot manifest.')
    if same:
        _verify_remote_files(api, repo_id, parent, previous)
    predecessor = manifest.get('previous_snapshot')
    if previous and not same:
        if not predecessor or predecessor.get('repo_id') != repo_id or predecessor.get('commit') != parent:
            raise ValueError('Build the next snapshot against the current destination commit.')
        if manifest.get('previous_manifest_sha256') != old_digest:
            raise ValueError('The local predecessor manifest differs from the declared remote snapshot.')
    if not previous and predecessor:
        raise ValueError('A first publication cannot claim an absent predecessor snapshot.')
    return {'repo_id': repo_id, 'release_id': manifest['release_id'], 'exists': True,
            'parent_commit': parent, 'already_published': same,
            'add': [] if same else sorted([*manifest['files'], 'manifest.json']),
            'delete': sorted(old_files - set(manifest['files']) - {'manifest.json'}),
            'reference_checks': verification}


@contextmanager
def _frozen_upload(snapshot):
    """Copy only validated files, then validate again before opening upload handles."""
    snapshot = Path(snapshot)
    validate_snapshot(snapshot)
    manifest_bytes = (snapshot/'manifest.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    if (manifest.get('contract') != 'beatmap-lens-annotations' or manifest.get('version') not in JUDGMENT_SCHEMAS
            or not isinstance(manifest.get('files'), dict)
            or not all(_owned_path(name) for name in manifest['files'])):
        raise ValueError('Snapshot manifest changed or contains unsafe publication paths.')
    with tempfile.TemporaryDirectory(prefix='beatmap-lens-upload-') as temporary:
        staged = Path(temporary)
        for name in manifest['files']:
            target = staged/name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(snapshot/name, target)
        (staged/'manifest.json').write_bytes(manifest_bytes)
        validate_snapshot(staged)
        yield staged


def publish_snapshot(snapshot, *, create_repo=False, private=True, api=None,
                     reference_verifier=verify_public_references):
    """Publish all files in one guarded commit, returning its immutable identity."""
    api = api or HfApi()
    with _frozen_upload(snapshot) as staged:
        plan = plan_publication(staged, api=api, reference_verifier=reference_verifier)
        manifest = read_json(staged/'manifest.json')
        repo_id = plan['repo_id']
        if not plan['exists']:
            if not create_repo:
                raise ValueError('Destination not found or inaccessible; use --create-repo to create it explicitly.')
            if manifest.get('previous_snapshot'):
                raise ValueError('Cannot create a new repository with a predecessor snapshot.')
            api.create_repo(repo_id, repo_type='dataset', private=private, exist_ok=False)
            parent = api.repo_info(repo_id, repo_type='dataset', revision='main').sha
        else:
            parent = plan['parent_commit']
        if plan['already_published']:
            commit = parent
        else:
            operations = [CommitOperationAdd(path_in_repo=name, path_or_fileobj=staged/name)
                          for name in plan['add']]
            operations += [CommitOperationDelete(path_in_repo=name) for name in plan['delete']]
            result = api.create_commit(repo_id, operations, repo_type='dataset', revision='main',
                                       parent_commit=parent,
                                       commit_message=f'Publish annotation snapshot {manifest["release_id"]}')
            commit = result.oid
        return {'repo_id': repo_id, 'release_id': manifest['release_id'], 'commit': commit,
                'url': f'https://huggingface.co/datasets/{repo_id}/tree/{commit}',
                'manifest_sha256': digest((staged/'manifest.json').read_bytes()),
                'already_published': plan['already_published'],
                'reference_checks': plan['reference_checks']}
