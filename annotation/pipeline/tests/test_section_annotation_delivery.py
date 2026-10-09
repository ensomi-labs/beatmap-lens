"""Focused controller tests; the exchange is simulated and no packets are submitted."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import section_annotation_delivery as delivery


class SectionDeliveryTest(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.batch, self.label_job, self.audit_job = [self.root / name for name in ('delivery', 'labeler', 'auditor')]
        source = (b'osu file format v14\n\n[General]\nMode:3\n\n[Difficulty]\nCircleSize:4\n'
                  b'\n[HitObjects]\n64,192,700,128,0,1200:0:0:0:0:\n192,192,1000,1,0,0:0:0:0:\n'
                  b'320,192,1400,1,0,0:0:0:0:\n')
        source_sha = hashlib.sha256(source).hexdigest()
        self.config = {'server': 'http://exchange.test', 'foundationSha256': 'f' * 64}
        self.foundation = {'foundationId': 'approved-five', 'revision': 1,
                           'approval': {'status': 'human-approved'}, 'policies': {},
                           'tags': [{'id': tag} for tag in delivery.TAGS],
                           'foundationSha256': self.config['foundationSha256']}
        self.case = {'caseId': 'episode-1', 'sectionId': 'episode-1', 'sourceSha256': source_sha,
                     'scope': {'startMs': 1000, 'endMs': 1400},
                     'reviewContext': {'startMs': 800, 'endMs': 1600},
                     'notes': [
                         {'source_line': 10, 'column': 0, 'kind': 'long', 'start_ms': 700, 'end_ms': 1200},
                         {'source_line': 11, 'column': 1, 'kind': 'normal', 'start_ms': 1000, 'end_ms': 1000},
                         {'source_line': 12, 'column': 2, 'kind': 'normal', 'start_ms': 1400, 'end_ms': 1400}]}
        self.task = {'taskId': 'frozen-task', 'taskSha256': 't' * 64,
                     'source': {'sha256': source_sha}, 'sourceBytes': list(source),
                     'structure': {'notes': [delivery.note_ref(note) for note in self.case['notes']]},
                     'foundationSha256': self.config['foundationSha256'],
                     'foundation': {key: value for key, value in self.foundation.items() if key != 'foundationSha256'},
                     'base': {'reviewRevision': 0, 'reviewSha256': 'b' * 64}}
        self.current = {'sourceSha256': source_sha, 'reviewBase': self.task['base'],
                        'taskBinding': {'foundationSha256': self.config['foundationSha256']},
                        'agentReviews': [], 'handoffs': [], 'audits': [], 'directObservations': []}
        self.judgments = [{'tagId': tag, 'presence': 'absent', 'salience': None,
                           'rationale': ['The full source episode was inspected.', 'The target organization does not recur.'],
                           'noteLines': [11], 'contextLines': [10, 12]} for tag in delivery.TAGS]
        self.commands = []
        self.addCleanup(patch.stopall)
        patch.object(delivery, 'cli', side_effect=self.exchange).start()
        patch.object(delivery, 'feedback', side_effect=lambda *_: deepcopy(self.current)).start()

    def write_job(self, path, role, cases, response, copies=()):
        delivery.save(path / 'cases.json', {'cases': cases})
        delivery.save(path / 'foundation.json', self.foundation)
        delivery.save(path / 'skill/manifest.json', {'files': []})
        delivery.save(path / 'skill-provenance.json', {'name': 'frozen-skill', 'version': 'test',
                                                      'sha256': delivery.sha(path / 'skill/manifest.json')})
        for source in copies:
            target = path / 'packets' / source.parent.name / source.name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(source.read_bytes())
        hashes = {str(item.relative_to(path)): delivery.sha(item) for item in path.rglob('*')
                  if item.is_file() and item.name not in ('run.json', 'response.json')}
        delivery.save(path / 'response.json', {'cases': response})
        delivery.save(path / 'run.json', {'producerId': 'actual-' + role, 'role': role, 'status': 'completed',
                                        'inputsUnchanged': True, 'inputHashes': hashes, 'toolVersion': 'test-cli',
                                        'requestedModel': 'test-model', 'finishedAt': '2026-09-07T00:00:00Z',
                                        'responseSha256': delivery.sha(path / 'response.json')})

    def label(self):
        self.write_job(self.label_job, 'labeler', [self.case], [{'caseId': self.case['caseId'], 'judgments': self.judgments}])
        return delivery.prepare_handoffs(self.batch, self.label_job, self.config)

    def test_disjoint_labeler_case_fragments_preserve_all_judgments_and_raw_worker_hashes(self):
        self.case.update(caseId='scale500-421', sectionId='scale500-421')
        fragments = [{'caseId': self.case['caseId'], 'judgments': self.judgments[:3]},
                     {'caseId': self.case['caseId'], 'judgments': self.judgments[3:]}]
        self.write_job(self.label_job, 'labeler', [self.case], fragments)
        frozen = {path: path.read_bytes() for path in self.label_job.rglob('*') if path.is_file()}
        manifest = delivery.prepare_handoffs(self.batch, self.label_job, self.config)
        handoff = delivery.read(manifest['entries'][0]['handoffPath'])
        self.assertEqual([claim['tagId'] for claim in handoff['proposals']], list(delivery.TAGS))
        self.assertEqual(delivery.group_labeler_cases(fragments, [self.case['caseId']])[self.case['caseId']],
                         {'caseId': self.case['caseId'], 'judgments': self.judgments})
        self.assertEqual(manifest['labelerRun']['responseSha256'], delivery.sha(self.label_job / 'response.json'))
        self.auditor(manifest)
        self.assertEqual(delivery.deliver_audits(self.batch, self.audit_job, self.config)['status'], 'complete')
        for path, contents in frozen.items():
            self.assertEqual(path.read_bytes(), contents)

    def test_labeler_fragment_conflicts_and_missing_coverage_fail_before_sealing(self):
        complete = {'caseId': self.case['caseId'], 'judgments': self.judgments}
        duplicate = deepcopy(self.judgments[0])
        duplicate.update(presence='present', salience='supporting')
        invalid = [
            ('identical-tag', [complete, {'caseId': self.case['caseId'], 'judgments': self.judgments[:1]}], 'Duplicate tagId'),
            ('conflicting-tag', [complete, {'caseId': self.case['caseId'], 'judgments': [duplicate]}], 'Duplicate tagId'),
            ('unexpected-case', [complete, {**complete, 'caseId': 'unexpected'}], 'caseId coverage'),
            ('wrong-case', [{**complete, 'caseId': 'wrong'}], 'caseId coverage'),
            ('missing-case', [], 'caseId coverage'),
            ('missing-tag', [{'caseId': self.case['caseId'], 'judgments': self.judgments[:3]},
                             {'caseId': self.case['caseId'], 'judgments': self.judgments[3:4]}], 'tagId coverage')]
        for name, fragments, error in invalid:
            with self.subTest(name=name):
                self.write_job(self.label_job, 'labeler', [self.case], fragments)
                with self.assertRaisesRegex(ValueError, error):
                    delivery.prepare_handoffs(self.batch, self.label_job, self.config)
                self.assertEqual(self.commands, [])

    def test_auditor_case_fragments_remain_rejected_before_submission(self):
        manifest = self.label()
        self.auditor(manifest)
        original = delivery.read(self.audit_job / 'response.json')['cases'][0]
        fragments = [{**original, 'results': original['results'][:3]},
                     {**original, 'results': original['results'][3:]}]
        self.write_job(self.audit_job, 'auditor', [{'caseId': self.case['caseId']}], fragments,
                       [Path(manifest['entries'][0][k]) for k in ('taskPath', 'handoffPath')])
        with self.assertRaisesRegex(ValueError, 'Duplicate caseId'):
            delivery.deliver_audits(self.batch, self.audit_job, self.config)
        self.assertNotIn('submit', self.commands)

    def test_raw_foundation_document_delivers_labels_and_independent_audits(self):
        self.foundation.pop('foundationSha256')
        self.foundation.update(contract='beatmap-lens-judgment-foundation', version=2)
        self.task['foundation'] = deepcopy(self.foundation)
        manifest = self.label()
        self.auditor(manifest)
        result = delivery.deliver_audits(self.batch, self.audit_job, self.config)
        self.assertEqual(result['status'], 'complete')
        self.assertEqual(delivery.read(self.label_job / 'foundation.json'), self.foundation)
        self.assertEqual(delivery.read(self.audit_job / 'foundation.json'), self.foundation)

    def test_foundation_binding_preserves_pins_and_all_supplied_definitions(self):
        for embedded_pin in (False, True):
            foundation = deepcopy(self.foundation)
            if not embedded_pin:
                foundation.pop('foundationSha256')
            for change in ('config-pin', 'missing-tags', 'changed-tags', 'changed-version'):
                with self.subTest(embedded_pin=embedded_pin, change=change):
                    supplied, config = deepcopy(foundation), deepcopy(self.config)
                    if change == 'config-pin':
                        config['foundationSha256'] = 'a' * 64
                    elif change == 'missing-tags':
                        supplied.pop('tags')
                    elif change == 'changed-tags':
                        supplied['tags'][0]['definition'] = 'different meaning'
                    else:
                        supplied['version'] = 1
                    with self.assertRaisesRegex(ValueError, 'Foundation (pin|content) differs'):
                        delivery.bind_foundation(self.task, supplied, config)
        self.foundation['foundationSha256'] = 'a' * 64
        with self.assertRaisesRegex(ValueError, 'Worker Foundation pin differs'):
            self.label()

    def test_auditor_foundation_content_must_match_even_with_a_correct_embedded_pin(self):
        manifest = self.label()
        self.foundation['tags'][0]['definition'] = 'different meaning'
        self.auditor(manifest)
        with self.assertRaisesRegex(ValueError, 'Worker Foundation content differs'):
            delivery.deliver_audits(self.batch, self.audit_job, self.config)
        self.assertNotIn('submit', self.commands)

    def test_rate_judgments_coexist_with_original_rate_human_and_machine_cells(self):
        self.add_review(delivery.TAGS[0], 'accepted')
        self.add_review(delivery.TAGS[1], 'agent-reviewed')
        self.case['playbackRate'] = 0.75
        manifest = self.label()
        self.assertEqual(manifest['skippedCells'], [])
        entry = manifest['entries'][0]
        self.assertEqual(entry['playbackRate'], 0.75)
        handoff = delivery.read(entry['handoffPath'])
        self.assertEqual([c['playbackRate'] for c in handoff['proposals']], [0.75] * 5)
        self.assertEqual(handoff['proposals'][0]['scope'], self.case['scope'])
        self.assertEqual(handoff['proposals'][0]['evidence']['noteRefs'][0]['startMs'], 1000)
        self.auditor(manifest)
        result = delivery.deliver_audits(self.batch, self.audit_job, self.config)
        self.assertEqual(result['status'], 'complete')

    def test_same_rate_human_still_protects_its_scope(self):
        self.case['playbackRate'] = 1.5
        self.add_review(delivery.TAGS[0], 'accepted')
        self.current['agentReviews'][0]['summary']['playbackRate'] = 1.5
        selected, _, skipped = delivery.select_cells(self.case, self.judgments, self.current,
                                                     self.config['foundationSha256'])
        self.assertEqual(len(selected), 4)
        self.assertEqual(skipped[0]['reason'], 'human-exact')
        self.assertEqual(skipped[0]['playbackRate'], 1.5)

    def test_auditor_must_read_the_sealed_rate(self):
        self.case['playbackRate'] = 0.5
        manifest = self.label()
        self.auditor(manifest)
        self.write_job(self.audit_job, 'auditor', [{'caseId': self.case['caseId']}],
                       delivery.read(self.audit_job / 'response.json')['cases'],
                       [Path(manifest['entries'][0][k]) for k in ('taskPath', 'handoffPath')])
        with self.assertRaisesRegex(ValueError, 'Auditor case playback rate'):
            delivery.deliver_audits(self.batch, self.audit_job, self.config)

    def attach_human_evidence(self, refs, events, tracked=True, job=None):
        job = job or self.label_job
        bundle = self.root / (job.name + '-harness')
        delivery.save(bundle / 'example-refs.json', refs)
        manifest = {'files': {'example-refs.json': delivery.sha(bundle / 'example-refs.json')}}
        if tracked:
            manifest['humanEvidenceTracking'] = 'returned-examples-v1'
        delivery.save(bundle / 'manifest.json', manifest)
        run = delivery.read(job / 'run.json')
        run['harness'] = {'bundle': str(bundle), 'manifestSha256': delivery.sha(bundle / 'manifest.json')}
        delivery.save(job / 'run.json', run)
        trace = job / 'harness-trace.jsonl'
        if events is not None:
            trace.write_text(''.join(json.dumps(event) + '\n' for event in events))
        return run

    def test_sealed_handoff_pins_returned_human_evidence_only_and_detects_trace_changes(self):
        self.write_job(self.label_job, 'labeler', [self.case], [{'caseId': self.case['caseId'], 'judgments': self.judgments}])
        used = {'sourceSha256': 'a' * 64, 'observationId': 'used', 'observationSha256': 'b' * 64}
        unrelated = {'sourceSha256': 'c' * 64, 'observationId': 'unseen', 'observationSha256': 'd' * 64}
        event = {'tool': 'find_human_examples', 'humanEvidenceRefs': [used], 'humanEvidenceTrackingComplete': True}
        self.attach_human_evidence({'example-used': used, 'example-unseen': unrelated}, [event, event])
        manifest = delivery.prepare_handoffs(self.batch, self.label_job, self.config)
        handoff = delivery.read(manifest['entries'][0]['handoffPath'])
        self.assertEqual(handoff['humanEvidenceRefs'], [used])
        self.assertEqual(manifest['labelerRun']['humanEvidenceTraceSha256'],
                         delivery.sha(self.label_job / 'harness-trace.jsonl'))
        with (self.label_job / 'harness-trace.jsonl').open('a') as trace:
            trace.write(json.dumps({**event, 'humanEvidenceRefs': [unrelated]}) + '\n')
        with self.assertRaisesRegex(ValueError, 'different immutable inputs'):
            delivery.prepare_handoffs(self.batch, self.label_job, self.config)

    def test_empty_dependency_set_requires_a_complete_initialized_trace(self):
        self.write_job(self.label_job, 'labeler', [self.case], [{'caseId': self.case['caseId'], 'judgments': self.judgments}])
        for tracked, events, expected in [
                (False, [], None), (True, None, None), (True, [], []),
                (True, [{'humanEvidenceRefs': [], 'humanEvidenceTrackingComplete': False}], None)]:
            with self.subTest(tracked=tracked, events=events):
                (self.label_job / 'harness-trace.jsonl').unlink(missing_ok=True)
                run = self.attach_human_evidence({}, events, tracked)
                actual, _ = delivery.human_evidence(self.label_job, run)
                self.assertEqual(actual, expected)
        self.attach_human_evidence({}, [])
        manifest = delivery.prepare_handoffs(self.batch, self.label_job, self.config)
        self.assertEqual(delivery.read(manifest['entries'][0]['handoffPath'])['humanEvidenceRefs'], [])

    def test_audit_seals_its_own_actual_human_examples_and_binds_the_trace_to_delivery(self):
        manifest = self.label()
        self.auditor(manifest)
        used = {'sourceSha256': 'e' * 64, 'observationId': 'auditor-example', 'observationSha256': 'f' * 64}
        unseen = {'sourceSha256': 'a' * 64, 'observationId': 'unseen-example', 'observationSha256': 'b' * 64}
        event = {'tool': 'get_human_example', 'humanEvidenceRefs': [used], 'humanEvidenceTrackingComplete': True}
        self.attach_human_evidence({'used': used, 'unseen': unseen}, [event], job=self.audit_job)
        result = delivery.deliver_audits(self.batch, self.audit_job, self.config)
        audit_manifest_path = self.batch / 'packets/audit-manifest.json'
        sealed = delivery.read(audit_manifest_path)
        audit = delivery.read(sealed['entries'][0]['auditPath'])
        self.assertEqual(audit['humanEvidenceRefs'], [used])
        self.assertNotIn('humanEvidenceRefs', delivery.read(manifest['entries'][0]['handoffPath']))
        self.assertEqual(sealed['humanEvidenceTraceSha256'], delivery.sha(self.audit_job / 'harness-trace.jsonl'))
        self.assertEqual(result['auditManifestSha256'], delivery.sha(audit_manifest_path))
        with (self.audit_job / 'harness-trace.jsonl').open('a') as trace:
            trace.write(json.dumps(event) + '\n')
        with self.assertRaisesRegex(ValueError, 'immutable worker evidence'):
            delivery.deliver_audits(self.batch, self.audit_job, self.config)

    def test_tracked_auditor_with_no_human_tool_results_seals_explicit_empty_evidence(self):
        manifest = self.label()
        self.auditor(manifest)
        self.attach_human_evidence({}, [], job=self.audit_job)
        delivery.deliver_audits(self.batch, self.audit_job, self.config)
        audit_manifest = delivery.read(self.batch / 'packets/audit-manifest.json')
        self.assertEqual(delivery.read(audit_manifest['entries'][0]['auditPath'])['humanEvidenceRefs'], [])

    def auditor(self, manifest, outcomes=None):
        cases, responses, copies = [], [], []
        for entry in manifest['entries']:
            cases.append({'caseId': entry['caseId'], **delivery.playback_rate_fields(entry)})
            responses.append({'caseId': entry['caseId'], 'coverageRationale': ['Every sealed target was independently inspected.'],
                              'results': [{'claimId': claim_id, 'status': (outcomes or {}).get(claim_id, 'supported'),
                                           'rationale': ['The exact supplied witnesses support this outcome.',
                                                         'The complete context contains no contrary arrangement.'],
                                           'question': 'Does this changing held-column relation establish the target organization?'
                                           if (outcomes or {}).get(claim_id) == 'needs-expert' else None}
                                          for claim_id in entry['claimIds']]})
            copies += [Path(entry['taskPath']), Path(entry['handoffPath'])]
        self.write_job(self.audit_job, 'auditor', cases, responses, copies)

    def add_review(self, tag, status, scope=None, presence='absent'):
        number = len(self.current['agentReviews'])
        handoff_id, claim_id = f'prior-{number}', f'claim-{number}'
        row = {'handoffId': handoff_id, 'claimId': claim_id, 'baseStatus': 'current', 'status': status,
               'summary': {'tagId': tag, 'scope': scope or self.case['scope'], 'assessment': {'presence': presence}}, 'audits': []}
        if status in delivery.HUMAN:
            row['decision'] = {'disposition': status, 'humanId': 'actual-human'}
        self.current['agentReviews'].append(row)
        self.current['handoffs'].append({'handoffId': handoff_id, 'handoffSha256': str(number) * 64,
                                         'foundationSha256': self.config['foundationSha256']})
        return {'sourceSha256': self.case['sourceSha256'], 'handoffId': handoff_id, 'claimId': claim_id,
                'tagId': tag, 'scope': scope or self.case['scope']}

    def exchange(self, command, *arguments):
        self.commands.append(command)
        options = dict(zip(arguments[::2], arguments[1::2])) if command != 'fetch-task' else {}
        if command == 'fetch-task':
            self.assertIn('--fresh', arguments)
            delivery.save(arguments[-1], self.task)
            return
        if command in ('handoff', 'audit'):
            task, proposal = delivery.read(options['--task']), delivery.read(options['--input'])
            packet = {**proposal, 'version': 2, 'sourceSha256': task['source']['sha256'],
                      **{key: task[key] for key in ('taskId', 'taskSha256', 'foundationSha256', 'base')}}
            if command == 'audit':
                original = delivery.read(options['--handoff'])
                packet.update(contract='beatmap-lens-independent-audit', handoffId=original['handoffId'],
                              handoffSha256=delivery.sha(options['--handoff']))
            else:
                packet['contract'] = 'beatmap-lens-agent-handoff'
            delivery.save(options['--out'], packet)
            return
        self.assertEqual(command, 'submit')
        packet = delivery.read(options['--input'])
        kind = 'audit' if 'auditId' in packet else 'handoff'
        if kind == 'handoff':
            self.current['handoffs'].append({**packet, 'handoffSha256': delivery.sha(options['--input'])})
            self.current['agentReviews'] += [{'handoffId': packet['handoffId'], 'claimId': claim['id'],
                                             'summary': claim, 'status': 'awaiting-audit', 'baseStatus': 'current', 'audits': []}
                                            for claim in packet['proposals']]
        else:
            self.current['audits'].append({**packet, 'auditSha256': delivery.sha(options['--input'])})
            handoff = next(item for item in self.current['handoffs'] if item['handoffId'] == packet['handoffId'])
            for claim in packet['claims']:
                row = next(item for item in self.current['agentReviews']
                           if (item['handoffId'], item['claimId']) == (packet['handoffId'], claim['claimId']))
                row['audits'].append({'auditId': packet['auditId'], 'result': claim})
                row['status'] = 'agent-reviewed' if claim['outcome'] == 'supported' else claim['outcome']
                for link in handoff.get('supersedes', []):
                    if link['replacementClaimId'] != claim['claimId'] or claim['outcome'] == 'needs-revision':
                        continue
                    old = next(item for item in self.current['agentReviews']
                               if (item['handoffId'], item['claimId']) == (link['handoffId'], link['claimId']))
                    old.update(status='superseded', supersededBy={'handoffId': packet['handoffId'], 'claimId': claim['claimId']})
            # Exchange feedback propagates an audited terminal revision through
            # the already stored linear history, including stale predecessors.
            rows = {(row['handoffId'], row['claimId']): row for row in self.current['agentReviews']}
            for prior in reversed(self.current['handoffs']):
                for link in prior.get('supersedes', []):
                    replacement = rows[(prior['handoffId'], link['replacementClaimId'])]
                    old = rows[(link['handoffId'], link['claimId'])]
                    if replacement['status'] in ('agent-reviewed', 'needs-expert', 'superseded') and not old.get('decision'):
                        old.update(status='superseded', supersededBy={'handoffId': prior['handoffId'], 'claimId': link['replacementClaimId']})
        delivery.save(options['--out'], {'id': 'receipt-' + kind, 'kind': kind,
                                        'packetId': packet['auditId'] if kind == 'audit' else packet['handoffId'],
                                        'sourceSha256': packet['sourceSha256'], 'status': 'imported', 'baseStatus': 'current'})

    def test_prepare_binds_full_source_context_and_retains_entering_holds(self):
        self.judgments[-1].update(presence='present', salience='supporting', noteLines=[10, 11])
        manifest = self.label()
        entry = manifest['entries'][0]
        handoff = delivery.read(entry['handoffPath'])
        self.assertNotIn('humanEvidenceRefs', handoff)
        self.assertEqual(len(handoff['proposals']), 5)
        hold = handoff['proposals'][-1]['evidence']['noteRefs'][0]
        self.assertEqual((hold['startMs'], hold['endMs']), (700, 1200))
        self.assertEqual(handoff['proposals'][-1]['evidence']['contextNoteRefs'][0]['sourceLine'], 12)
        self.assertNotIn('submit', self.commands)
        self.assertEqual(delivery.prepare_handoffs(self.batch, self.label_job, self.config), manifest)
        self.assertEqual(self.commands.count('fetch-task'), 1)

    def test_source_bytes_note_geometry_and_complete_context_are_pinned(self):
        for mutation, message in [('bytes', 'source bytes'), ('column', 'Worker notes'), ('omission', 'Worker notes')]:
            with self.subTest(mutation=mutation):
                task, case = deepcopy(self.task), deepcopy(self.case)
                if mutation == 'bytes':
                    task['sourceBytes'].append(10)
                elif mutation == 'column':
                    case['notes'][0]['column'] = 3
                else:
                    case['notes'].pop()
                with self.assertRaisesRegex(ValueError, message):
                    delivery.bind_source(case, task, self.foundation, self.config)

    def test_human_exact_rejected_and_partial_overlap_cells_are_preserved(self):
        original = self.add_review(delivery.TAGS[0], 'modified')
        self.current['agentReviews'][0]['modifiedClaim'] = {
            **self.current['agentReviews'][0]['summary'], 'scope': {'startMs': 1100, 'endMs': 1450}}
        self.case['originalReferences'] = [original]
        self.add_review(delivery.TAGS[1], 'rejected')
        self.current['directObservations'].append({'summary': {'tagId': 'tech', 'scope': {'startMs': 1200, 'endMs': 1800}}})
        before = deepcopy(self.current)
        manifest = self.label()
        self.assertEqual([cell['reason'] for cell in manifest['skippedCells']], ['human-exact', 'human-exact', 'human-overlap'])
        self.assertEqual(len(manifest['entries'][0]['claimIds']), 2)
        self.assertEqual(manifest['entries'][0]['supersedes'], [])
        self.assertEqual(self.current, before)

    def test_duplicate_supported_cells_skip_and_conflicting_supported_cells_block(self):
        self.add_review(delivery.TAGS[0], 'agent-reviewed')
        self.add_review(delivery.TAGS[1], 'agent-reviewed', presence='unresolved')
        manifest = self.label()
        self.assertEqual([(c['reason'], c['conflict']) for c in manifest['skippedCells']],
                         [('compatible-machine', False), ('supported-machine-conflict', True)])
        self.assertEqual(len(manifest['entries'][0]['claimIds']), 3)
        self.auditor(manifest)
        result = delivery.deliver_audits(self.batch, self.audit_job, self.config)
        self.assertEqual(result['status'], 'needs-controller')
        self.assertEqual(result['skippedCells'], manifest['skippedCells'])

    def test_effective_gold_protects_current_revision_without_retaining_the_old_scope(self):
        old = {'id': 'old-human', 'summary': {'tagId': 'tech', 'scope': self.case['scope']}}
        self.current['directObservations'] = [old]
        self.current['effectiveHumanObservations'] = [
            {'id': 'revised-human', 'summary': {'tagId': 'tech', 'scope': {'startMs': 1500, 'endMs': 1600}}}]
        selected, _, skipped = delivery.select_cells(self.case, self.judgments, self.current, self.config['foundationSha256'])
        self.assertEqual(len(selected), 5)
        self.assertEqual(skipped, [])
        self.current['effectiveHumanObservations'][0]['summary']['scope'] = self.case['scope']
        selected, _, skipped = delivery.select_cells(self.case, self.judgments, self.current, self.config['foundationSha256'])
        self.assertEqual(len(selected), 4)
        self.assertEqual(skipped[0]['reason'], 'human-exact')

    def test_current_pending_machine_cells_require_exact_explicit_lineage(self):
        self.case['originalReferences'] = [self.add_review('tech', 'needs-expert')]
        self.add_review(delivery.TAGS[0], 'needs-revision')
        manifest = self.label()
        links = manifest['entries'][0]['supersedes']
        self.assertEqual(links, [{'handoffId': 'prior-0', 'handoffSha256': '0' * 64, 'claimId': 'claim-0',
                                 'replacementClaimId': 'episode-1-tech'}])
        self.assertEqual(manifest['skippedCells'][0]['reason'], 'missing-current-supersedes-reference')

    def test_stale_or_already_replaced_references_remain_blocked(self):
        ref = self.add_review('tech', 'needs-expert')
        self.case['originalReferences'] = [ref]
        for state in ('stale', 'replacement'):
            with self.subTest(state=state):
                current = deepcopy(self.current)
                if state == 'stale':
                    current['agentReviews'][0]['baseStatus'] = 'stale'
                else:
                    current['handoffs'].append({'handoffId': 'replacement', 'supersedes': [ref]})
                selected, links, skipped = delivery.select_cells(self.case, self.judgments, current, self.config['foundationSha256'])
                self.assertEqual((len(selected), links), (4, []))
                self.assertTrue(skipped[0]['conflict'])

    def test_explicit_terminal_repair_reuses_frozen_labels_without_forking_or_rewriting_history(self):
        original = self.add_review('tech', 'needs-expert')
        terminal = self.add_review('tech', 'stale')
        self.current['agentReviews'][-1]['baseStatus'] = 'stale'
        self.current['handoffs'][-1]['supersedes'] = [{
            'handoffId': original['handoffId'], 'handoffSha256': '0' * 64,
            'claimId': original['claimId'], 'replacementClaimId': terminal['claimId']}]
        self.case['originalReferences'] = [original]
        first = self.label()
        original_packet = Path(first['entries'][0]['handoffPath'])
        original_hash, worker_hash = delivery.sha(original_packet), delivery.sha(self.label_job / 'run.json')
        for tag in delivery.TAGS:
            if tag != 'tech':
                self.add_review(tag, 'agent-reviewed')
        self.batch = self.root / 'lineage-repair'
        manifest = delivery.prepare_handoffs(self.batch, self.label_job, self.config,
                                             follow_terminal_lineage=True, handoff_suffix='lineage-repair')
        entry = manifest['entries'][0]
        self.assertEqual(entry['claimIds'], ['episode-1-tech'])
        self.assertEqual(entry['originalReferences'], [original])
        self.assertEqual(entry['supersedes'], [{
            'handoffId': terminal['handoffId'], 'handoffSha256': '1' * 64,
            'claimId': terminal['claimId'], 'replacementClaimId': 'episode-1-tech'}])
        self.assertEqual(len(entry['lineageRepairs'][0]['chain']), 2)
        self.assertNotEqual(entry['handoffId'], first['entries'][0]['handoffId'])
        self.assertEqual(delivery.sha(original_packet), original_hash)
        self.assertEqual(delivery.sha(self.label_job / 'run.json'), worker_hash)
        self.auditor(manifest)
        result = delivery.deliver_audits(self.batch, self.audit_job, self.config)
        self.assertEqual(result['status'], 'complete')
        self.assertEqual([row['status'] for row in self.current['agentReviews'][:2]], ['superseded', 'superseded'])
        self.assertEqual(self.current['agentReviews'][0]['supersededBy'], {
            'handoffId': terminal['handoffId'], 'claimId': terminal['claimId']})

    def test_terminal_repair_does_not_adopt_an_unrelated_stale_claim_or_changed_crop(self):
        original = self.add_review('tech', 'needs-expert')
        terminal = self.add_review('tech', 'stale', scope={'startMs': 1100, 'endMs': 1400})
        self.current['agentReviews'][-1]['baseStatus'] = 'stale'
        self.current['handoffs'][-1]['supersedes'] = [{
            'handoffId': original['handoffId'], 'handoffSha256': '0' * 64,
            'claimId': original['claimId'], 'replacementClaimId': terminal['claimId']}]
        self.case['originalReferences'] = [original]
        case, current, lineages = delivery.terminal_lineage(self.case, self.current, self.config['foundationSha256'])
        self.assertEqual(lineages, [])
        selected, links, skipped = delivery.select_cells(case, self.judgments, current, self.config['foundationSha256'])
        self.assertEqual((len(selected), links), (4, []))
        self.assertEqual(skipped[0]['reason'], 'original-already-has-replacement')

    def failed_terminal_lineage(self):
        original = self.add_review('tech', 'needs-revision')
        terminal = self.add_review('tech', 'needs-revision')
        original['handoffSha256'], terminal['handoffSha256'] = '0' * 64, '1' * 64
        self.current['handoffs'][-1]['supersedes'] = [{
            'handoffId': original['handoffId'], 'handoffSha256': original['handoffSha256'],
            'claimId': original['claimId'], 'replacementClaimId': terminal['claimId']}]
        self.case['originalReferences'] = [original, terminal]
        return original, terminal

    def test_explicit_current_failed_terminal_delivers_one_link_without_rewriting_frozen_work(self):
        original, terminal = self.failed_terminal_lineage()
        first = self.label()
        self.assertEqual(first['skippedCells'][0]['reason'], 'original-already-has-replacement')
        frozen = {path: path.read_bytes() for path in self.label_job.rglob('*') if path.is_file()}
        original_packet = Path(first['entries'][0]['handoffPath'])
        original_hash = delivery.sha(original_packet)
        original_handoffs = deepcopy(self.current['handoffs'])
        for tag in delivery.TAGS:
            if tag != 'tech':
                self.add_review(tag, 'agent-reviewed')
        self.batch = self.root / 'current-terminal-repair'
        manifest = delivery.prepare_handoffs(self.batch, self.label_job, self.config,
                                             follow_terminal_lineage=True, handoff_suffix='current-terminal')
        entry = manifest['entries'][0]
        self.assertEqual(entry['claimIds'], ['episode-1-tech'])
        self.assertEqual(entry['originalReferences'], [original, terminal])
        self.assertEqual(entry['supersedes'], [{
            'handoffId': terminal['handoffId'], 'handoffSha256': terminal['handoffSha256'],
            'claimId': terminal['claimId'], 'replacementClaimId': 'episode-1-tech'}])
        self.assertEqual([row['status'] for row in entry['lineageRepairs'][0]['chain']], ['needs-revision'] * 2)
        self.auditor(manifest)
        self.assertEqual(delivery.deliver_audits(self.batch, self.audit_job, self.config)['status'], 'complete')
        self.assertEqual([row['status'] for row in self.current['agentReviews'][:2]], ['superseded'] * 2)
        self.assertEqual(self.current['agentReviews'][0]['supersededBy'], {
            'handoffId': terminal['handoffId'], 'claimId': terminal['claimId']})
        self.assertEqual(self.current['handoffs'][:2], original_handoffs)
        self.assertEqual(delivery.sha(original_packet), original_hash)
        for path, contents in frozen.items():
            self.assertEqual(path.read_bytes(), contents)

    def test_current_terminal_and_anchor_references_work_in_either_order(self):
        original, terminal = self.failed_terminal_lineage()
        before = deepcopy(self.current)
        for refs in ([original], [original, terminal], [terminal, original]):
            with self.subTest(refs=refs):
                case = {**self.case, 'originalReferences': refs}
                selected_case, current, lineages = delivery.terminal_lineage(
                    case, self.current, self.config['foundationSha256'])
                selected, links, skipped = delivery.select_cells(
                    selected_case, self.judgments, current, self.config['foundationSha256'])
                self.assertEqual((len(selected), len(links), skipped), (5, 1, []))
                self.assertEqual(links[0]['handoffId'], terminal['handoffId'])
                self.assertEqual(len(selected_case['originalReferences']), 1)
                self.assertEqual(selected_case['staleLineageTargets'], [])
                self.assertEqual(len(lineages), 1)
        self.assertEqual(self.current, before)

    def test_current_terminal_repair_preserves_protected_statuses_and_bindings(self):
        self.failed_terminal_lineage()
        mutations = [
            ('supported', lambda row, handoff: row.update(status='agent-reviewed')),
            ('expert', lambda row, handoff: row.update(status='needs-expert')),
            ('awaiting-audit', lambda row, handoff: row.update(status='awaiting-audit')),
            ('human', lambda row, handoff: row.update(status='accepted', decision={'humanId': 'actual-human'})),
            ('stale-base', lambda row, handoff: row.update(baseStatus='stale')),
            ('stale-source', lambda row, handoff: row.update(trust={'source': 'stale', 'foundation': 'current'})),
            ('stale-foundation', lambda row, handoff: row.update(trust={'source': 'current', 'foundation': 'stale'})),
            ('scope', lambda row, handoff: row['summary'].update(scope={'startMs': 1100, 'endMs': 1400})),
            ('tag', lambda row, handoff: row['summary'].update(tagId='trill-organization')),
            ('rate', lambda row, handoff: row['summary'].update(playbackRate=1.25)),
            ('foundation', lambda row, handoff: handoff.update(foundationSha256='other-foundation'))]
        for name, mutate in mutations:
            with self.subTest(name=name):
                current = deepcopy(self.current)
                mutate(current['agentReviews'][-1], current['handoffs'][-1])
                before = deepcopy(current)
                case, view, lineages = delivery.terminal_lineage(self.case, current, self.config['foundationSha256'])
                selected, links, _ = delivery.select_cells(case, self.judgments, view, self.config['foundationSha256'])
                self.assertEqual(lineages, [])
                self.assertEqual(links, [])
                self.assertNotIn('tech', [judgment['tagId'] for judgment in selected])
                self.assertEqual(current, before)

    def test_current_terminal_repair_rejects_altered_explicit_references_and_chain_hash(self):
        original, terminal = self.failed_terminal_lineage()
        for field, value in [('sourceSha256', 'wrong-source'), ('handoffSha256', 'wrong-hash'),
                             ('tagId', 'trill-organization'), ('scope', {'startMs': 1100, 'endMs': 1400}),
                             ('playbackRate', 1.25)]:
            for refs in ([original, {**terminal, field: value}], [{**terminal, field: value}, original]):
                with self.subTest(field=field, refs=refs):
                    with self.assertRaisesRegex(ValueError, 'Conflicting lineage reference binding'):
                        delivery.terminal_lineage({**self.case, 'originalReferences': refs},
                                                   self.current, self.config['foundationSha256'])
        for field, value in [('sourceSha256', 'wrong-source'), ('handoffSha256', 'wrong-hash')]:
            with self.subTest(anchor=field):
                with self.assertRaisesRegex(ValueError, 'Lineage anchor binding changed'):
                    delivery.terminal_lineage({**self.case, 'originalReferences': [{**original, field: value}]},
                                               self.current, self.config['foundationSha256'])
        self.current['handoffs'][-1]['supersedes'][0]['handoffSha256'] = 'wrong-hash'
        with self.assertRaisesRegex(ValueError, 'Immutable lineage handoff hash differs'):
            delivery.terminal_lineage(self.case, self.current, self.config['foundationSha256'])

    def test_explicit_exact_stale_coalescing_retires_the_detached_duplicate_too(self):
        original = self.add_review('tech', 'needs-revision')
        terminal = self.add_review('tech', 'stale')
        self.current['agentReviews'][-1]['baseStatus'] = 'stale'
        self.current['handoffs'][-1]['supersedes'] = [{
            'handoffId': original['handoffId'], 'handoffSha256': '0' * 64,
            'claimId': original['claimId'], 'replacementClaimId': terminal['claimId']}]
        duplicate = self.add_review('tech', 'stale')
        self.current['agentReviews'][-1]['baseStatus'] = 'stale'
        self.case['originalReferences'] = [original]
        self.label()
        self.batch = self.root / 'coalesced-repair'
        manifest = delivery.prepare_handoffs(self.batch, self.label_job, self.config,
                                             follow_terminal_lineage=True, handoff_suffix='coalesced', include_exact_stale=True)
        entry = manifest['entries'][0]
        self.assertEqual({link['claimId'] for link in entry['supersedes']}, {terminal['claimId'], duplicate['claimId']})
        self.assertEqual(entry['lineageRepairs'][-1]['reason'], 'exact-stale-duplicate')
        self.auditor(manifest)
        result = delivery.deliver_audits(self.batch, self.audit_job, self.config)
        self.assertEqual(result['status'], 'complete')
        self.assertEqual([row['status'] for row in self.current['agentReviews'][:3]], ['superseded'] * 3)

    def test_five_dimension_coverage_and_half_open_witnesses_are_checked_before_sealing(self):
        self.judgments[0]['noteLines'] = [12]
        with self.assertRaisesRegex(ValueError, 'out-of-scope'):
            self.label()
        self.assertEqual(self.commands, [])

    def test_audited_delivery_preserves_actual_outcomes_and_retry_submits_nothing(self):
        self.case['originalReferences'] = [self.add_review('tech', 'needs-expert')]
        self.judgments[3].update(presence='unresolved')
        manifest = self.label()
        self.auditor(manifest, {'episode-1-tech': 'needs-expert', 'episode-1-ln-coordination': 'needs-revision'})
        result = delivery.deliver_audits(self.batch, self.audit_job, self.config)
        self.assertEqual(result['status'], 'complete')
        statuses = result['entries'][0]['claimStatuses']
        self.assertEqual(statuses['episode-1-tech'], 'needs-expert')
        self.assertEqual(statuses['episode-1-ln-coordination'], 'needs-revision')
        self.assertEqual(self.current['agentReviews'][0]['status'], 'superseded')
        self.assertEqual(self.current['audits'][0]['agent']['producerId'], 'actual-auditor')
        self.assertNotIn('humanEvidenceRefs', self.current['audits'][0])
        self.assertEqual(self.commands.count('submit'), 2)
        result = delivery.deliver_audits(self.batch, self.audit_job, self.config)
        self.assertEqual(result['entries'][0]['status'], 'already-delivered')
        self.assertEqual(self.commands.count('submit'), 2)

    def test_unresolved_claim_cannot_be_promoted_by_supported_audit(self):
        self.judgments[3]['presence'] = 'unresolved'
        manifest = self.label()
        self.auditor(manifest)
        with self.assertRaisesRegex(ValueError, 'unresolved proposal'):
            delivery.deliver_audits(self.batch, self.audit_job, self.config)
        self.assertNotIn('submit', self.commands)
        self.assertNotIn('audit', self.commands)

    def test_auditor_must_be_independent_and_pin_exact_original_packet_files(self):
        manifest = self.label()
        self.auditor(manifest)
        path = self.audit_job / 'run.json'
        run = delivery.read(path)
        run['producerId'] = 'actual-labeler'
        delivery.save(path, run)
        with self.assertRaisesRegex(ValueError, 'independent'):
            delivery.deliver_audits(self.batch, self.audit_job, self.config)
        run['producerId'] = 'actual-auditor'
        run['inputHashes'] = {name: digest for name, digest in run['inputHashes'].items() if not name.endswith('/task.json')}
        delivery.save(path, run)
        with self.assertRaisesRegex(ValueError, 'exact task and handoff'):
            delivery.deliver_audits(self.batch, self.audit_job, self.config)
        self.assertNotIn('submit', self.commands)

    def test_new_human_decision_between_handoff_and_audit_stops_the_second_write(self):
        manifest = self.label()
        self.auditor(manifest)
        exchange = self.exchange

        def concurrent_human(command, *arguments):
            exchange(command, *arguments)
            if command == 'submit':
                self.add_review('tech', 'accepted')

        with patch.object(delivery, 'cli', side_effect=concurrent_human):
            result = delivery.deliver_audits(self.batch, self.audit_job, self.config)
        self.assertEqual(result['status'], 'blocked')
        self.assertEqual(self.commands.count('submit'), 1)
        self.assertEqual(self.current['audits'], [])
        self.assertIn('human-exact', result['entries'][0]['error'])

    def test_unrelated_human_update_during_audit_keeps_the_sealed_packet_deliverable(self):
        manifest = self.label()
        self.auditor(manifest)
        entry = manifest['entries'][0]
        self.current['reviewBase'] = {'reviewRevision': 1, 'reviewSha256': 'changed'}
        self.current['effectiveHumanObservations'] = [
            {'id': 'unrelated-human', 'summary': {'tagId': 'tech', 'scope': {'startMs': 1500, 'endMs': 1600}}}]
        result = delivery.deliver_audits(self.batch, self.audit_job, self.config)
        self.assertEqual(result['status'], 'complete')
        self.assertEqual(delivery.sha(entry['handoffPath']), entry['handoffSha256'])
        self.assertEqual(self.commands.count('submit'), 2)

    def test_unrelated_human_saves_between_both_delivery_writes_are_preserved_and_reported(self):
        manifest = self.label()
        self.auditor(manifest)
        exchange = self.exchange

        def concurrent_human(command, *arguments):
            exchange(command, *arguments)
            if command == 'submit':
                index = len(self.current['directObservations'])
                self.current['directObservations'].append({
                    'id': f'concurrent-human-{index}',
                    'summary': {'tagId': 'tech', 'scope': {'startMs': 800 + index * 100, 'endMs': 900 + index * 100},
                                'assessment': {'presence': 'absent'}}})

        with patch.object(delivery, 'cli', side_effect=concurrent_human):
            result = delivery.deliver_audits(self.batch, self.audit_job, self.config)
        self.assertEqual(result['status'], 'complete')
        self.assertFalse(result['entries'][0]['humanRecordsUnchanged'])
        self.assertEqual(self.commands.count('submit'), 2)
        self.assertEqual([row['id'] for row in self.current['directObservations']],
                         ['concurrent-human-0', 'concurrent-human-1'])


if __name__ == '__main__':
    unittest.main()
