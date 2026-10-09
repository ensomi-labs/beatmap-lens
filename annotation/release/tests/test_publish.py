"""Publication boundaries use fake Hub operations; tests never upload user data."""
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import httpx
from huggingface_hub import RepoFile, RepoFolder
from huggingface_hub.errors import RepositoryNotFoundError

import publish


class ReferenceTests(unittest.TestCase):
    def verify(self, source, api=None, content=b'original .osu bytes', *, source_access=None,
               artifact_content=b'exporter code'):
        artifact = b'exporter code'
        manifest = {'exporter': {'repository': 'https://github.com/example/annotations',
                                 'commit': 'a'*40, 'path': 'export.py',
                                 'sha256': publish.digest(artifact)},
                    'exporter_files': {}, 'foundations': {}, 'methods': {}}
        if source_access is not None:
            manifest['policy'] = {'source_access': source_access}
        responses = [httpx.Response(200, content=value,
                                    request=httpx.Request('GET', 'https://example.com'))
                     for value in (artifact_content, content)]
        with patch.object(publish.httpx, 'Client') as client, patch.object(publish.pq, 'read_table') as table:
            client.return_value.__enter__.return_value.get.side_effect = responses
            table.return_value.to_pylist.return_value = [source]
            result = publish.verify_public_references(Path('/snapshot'), manifest, api=api)
            if source_access == 'metadata-only':
                self.assertEqual(client.return_value.__enter__.return_value.get.call_count, 1)
            return result

    def test_metadata_only_keeps_source_identity_without_weakening_artifact_checks(self):
        source = {'source_sha256': publish.digest(b'original .osu bytes'),
                  'source_ref': {'kind': 'osu', 'uri': 'https://osu.ppy.sh/osu/123'}}
        result = self.verify(source, content=b'new edited version', source_access='metadata-only')
        self.assertEqual(result['sources'], {
            'content_verified': 0, 'locator_verified': 0, 'identity_only': 1})
        with self.assertRaisesRegex(ValueError, 'Published artifact checksum differs'):
            self.verify(source, source_access='metadata-only', artifact_content=b'changed exporter')

    def test_osu_locator_requires_exact_original_bytes(self):
        for kind, uri in (('osu', 'https://osu.ppy.sh/osu/123'),
                          ('url', 'https://osu.direct/api/osu/123')):
            source = {'source_sha256': publish.digest(b'original .osu bytes'),
                      'source_ref': {'kind': kind, 'uri': uri}}
            result = self.verify(source)
            self.assertEqual(result['sources'], {'content_verified': 1, 'locator_verified': 0})
            with self.assertRaisesRegex(ValueError, 'Source content checksum differs'):
                self.verify(source, content=b'new edited version')

    def test_hf_row_locator_must_point_to_a_file(self):
        source = {'source_sha256': 'b'*64, 'source_ref': {
            'kind': 'hf', 'repository': 'example/corpus', 'commit': 'c'*40,
            'path': 'data/shard.parquet', 'record_key': 'row-123'}}
        api = Mock()
        api.get_paths_info.return_value = [RepoFolder(path='data/shard.parquet', oid='d'*40)]
        with self.assertRaisesRegex(ValueError, 'Source corpus file is unavailable'):
            self.verify(source, api=api)
        api.get_paths_info.return_value = [RepoFile(path='data/shard.parquet', oid='d'*40, size=100)]
        result = self.verify(source, api=api)
        self.assertEqual(result['sources'], {'content_verified': 0, 'locator_verified': 1})


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)/'snapshot'
        self.root.mkdir()
        (self.root/'README.md').write_text('Snapshot card\n')
        self.manifest = {'contract': 'beatmap-lens-annotations', 'version': 1,
                         'release_id': '2026-09-09.1', 'repo_id': 'example/annotations',
                         'previous_snapshot': None,
                         'counts': {'human': 1, 'agents': {}},
                         'files': {'README.md': {'sha256': publish.digest((self.root/'README.md').read_bytes())}}}
        self.save()
        self.api = Mock()
        self.api.repo_info.return_value = SimpleNamespace(sha='a'*40)
        self.api.list_repo_files.return_value = ['.gitattributes']
        self.api.create_commit.return_value = SimpleNamespace(oid='b'*40)
        # Full Arrow/schema validation belongs to test_snapshot. This validator
        # isolates copying/commit races while still enforcing file identity.
        self.checker = patch.object(publish, 'validate_snapshot', side_effect=self.check_files)
        self.checker.start()
        self.addCleanup(self.checker.stop)
        self.remote = patch.object(publish, '_remote_manifest', return_value=(None, None))
        self.remote_mock = self.remote.start()
        self.addCleanup(self.remote.stop)
        self.refs = Mock(return_value={'artifact_count': 1})
        verification = patch.object(publish, '_verify_remote_files')
        self.remote_files_mock = verification.start()
        self.addCleanup(verification.stop)

    def save(self):
        (self.root/'manifest.json').write_text(json.dumps(self.manifest))

    def check_files(self, root):
        manifest = json.loads((Path(root)/'manifest.json').read_text())
        for name, metadata in manifest['files'].items():
            if publish.digest((Path(root)/name).read_bytes()) != metadata['sha256']:
                raise ValueError('File changed')
        return {'valid': True}

    def test_plan_is_read_only_and_upload_is_one_guarded_commit(self):
        plan = publish.plan_publication(self.root, api=self.api, reference_verifier=self.refs)
        self.assertEqual(plan['add'], ['README.md', 'manifest.json'])
        self.api.create_repo.assert_not_called()
        self.api.create_commit.assert_not_called()
        observed = {}

        def commit(repo_id, operations, **kwargs):
            observed.update(kwargs)
            observed['files'] = {op.path_in_repo: Path(op.path_or_fileobj).read_bytes() for op in operations}
            # A user editing the original directory during upload cannot change
            # the staged file handles submitted to HF.
            (self.root/'README.md').write_text('changed while uploading')
            self.assertEqual(observed['files']['README.md'], b'Snapshot card\n')
            return SimpleNamespace(oid='b'*40)

        self.api.create_commit.side_effect = commit
        receipt = publish.publish_snapshot(self.root, api=self.api, reference_verifier=self.refs)
        self.assertEqual(receipt['commit'], 'b'*40)
        self.assertEqual(observed['parent_commit'], 'a'*40)
        self.assertEqual(observed['repo_type'], 'dataset')
        self.assertEqual(set(observed['files']), {'README.md', 'manifest.json'})
        self.api.create_commit.assert_called_once()

    def test_new_repository_creation_requires_explicit_flag(self):
        missing = RepositoryNotFoundError('not found', response=httpx.Response(
            404, request=httpx.Request('GET', 'https://huggingface.co/api/datasets/example/annotations')))
        self.api.repo_info.side_effect = missing
        plan = publish.plan_publication(self.root, api=self.api, reference_verifier=self.refs)
        self.assertFalse(plan['exists'])
        with self.assertRaisesRegex(ValueError, '--create-repo'):
            publish.publish_snapshot(self.root, api=self.api, reference_verifier=self.refs)
        self.api.create_repo.assert_not_called()
        self.api.repo_info.side_effect = [missing, SimpleNamespace(sha='a'*40)]
        publish.publish_snapshot(self.root, create_repo=True, api=self.api, reference_verifier=self.refs)
        self.api.create_repo.assert_called_once_with('example/annotations', repo_type='dataset',
                                                     private=True, exist_ok=False)

    def test_previous_snapshot_removes_only_owned_old_files(self):
        previous = {**self.manifest, 'files': {**self.manifest['files'], 'data/agent/old.parquet': {}}}
        self.remote_mock.return_value = (previous, 'previous-manifest-hash')
        self.api.list_repo_files.return_value = ['README.md', 'manifest.json', 'data/agent/old.parquet']
        with self.assertRaisesRegex(ValueError, 'current destination commit'):
            publish.plan_publication(self.root, api=self.api, reference_verifier=self.refs)
        self.manifest['previous_snapshot'] = {'repo_id': 'example/annotations', 'commit': 'a'*40}
        self.manifest['previous_manifest_sha256'] = 'previous-manifest-hash'
        self.save()
        plan = publish.plan_publication(self.root, api=self.api, reference_verifier=self.refs)
        self.assertEqual(plan['delete'], ['data/agent/old.parquet'])
        self.api.list_repo_files.return_value += ['unrelated/private-source.osu']
        with self.assertRaisesRegex(ValueError, 'outside the previous snapshot'):
            publish.plan_publication(self.root, api=self.api, reference_verifier=self.refs)

    def test_retry_of_same_snapshot_returns_existing_commit(self):
        self.remote_mock.return_value = (self.manifest, publish.digest((self.root/'manifest.json').read_bytes()))
        self.api.list_repo_files.return_value = ['README.md', 'manifest.json']
        receipt = publish.publish_snapshot(self.root, api=self.api, reference_verifier=self.refs)
        self.assertTrue(receipt['already_published'])
        self.assertEqual(receipt['commit'], 'a'*40)
        self.api.create_commit.assert_not_called()
        self.remote_files_mock.assert_called_once()

    def test_retry_rejects_missing_or_replaced_remote_data(self):
        self.remote_mock.return_value = (self.manifest, publish.digest((self.root/'manifest.json').read_bytes()))
        self.api.list_repo_files.return_value = ['manifest.json']
        with self.assertRaisesRegex(ValueError, 'missing files'):
            publish.plan_publication(self.root, api=self.api, reference_verifier=self.refs)
        self.api.list_repo_files.return_value = ['manifest.json', 'README.md']
        self.remote_files_mock.side_effect = ValueError('Existing snapshot file differs')
        with self.assertRaisesRegex(ValueError, 'file differs'):
            publish.publish_snapshot(self.root, api=self.api, reference_verifier=self.refs)
        self.api.create_commit.assert_not_called()

    def test_manifest_swap_cannot_escape_temporary_staging(self):
        def replace_after_validation(root):
            self.check_files(root)
            swapped = {**self.manifest, 'files': {'../outside.osu': {}}}
            (self.root/'manifest.json').write_text(json.dumps(swapped))

        with patch.object(publish, 'validate_snapshot', side_effect=replace_after_validation):
            with self.assertRaisesRegex(ValueError, 'unsafe publication paths'):
                publish.publish_snapshot(self.root, api=self.api, reference_verifier=self.refs)
        self.api.create_commit.assert_not_called()

    def test_reference_failure_prevents_remote_mutation(self):
        self.refs.side_effect = ValueError('Published Foundation checksum differs')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            publish.publish_snapshot(self.root, create_repo=True, api=self.api, reference_verifier=self.refs)
        self.api.create_repo.assert_not_called()
        self.api.create_commit.assert_not_called()

    def test_empty_default_or_selected_configuration_cannot_publish(self):
        for counts in ({'human': 0, 'agents': {}}, {'human': 1, 'agents': {'empty-method': 0}}):
            self.manifest['counts'] = counts
            self.save()
            with self.assertRaisesRegex(ValueError, 'no publishable rows'):
                publish.publish_snapshot(self.root, api=self.api, reference_verifier=self.refs)
        self.api.create_commit.assert_not_called()

    def test_public_artifact_uses_pinned_commit(self):
        ref = {'repository': 'https://github.com/ensomi-labs/beatmap-lens', 'commit': 'c'*40,
               'path': 'annotation/foundations/definition.json', 'sha256': 'd'*64}
        self.assertEqual(publish._public_artifact_url(ref),
                         'https://raw.githubusercontent.com/ensomi-labs/beatmap-lens/' + 'c'*40 +
                         '/annotation/foundations/definition.json')
        with self.assertRaisesRegex(ValueError, 'full Git commit'):
            publish._public_artifact_url({**ref, 'commit': 'main'})


if __name__ == '__main__':
    unittest.main()
