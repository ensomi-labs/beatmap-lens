"""Real MCP transport and frozen-bundle boundaries for annotation tools."""
import asyncio
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest

import pyarrow as pa
import pyarrow.parquet as pq

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from harness_examples import extract_examples
from test_harness_examples import claim, feedback, review

SCRIPTS = Path(__file__).resolve().parent.parent


def module(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), (SCRIPTS.parent / 'annotation/evaluation' if name == 'prepare-harness-benchmark' else SCRIPTS) / (name + '.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


prepare = module('prepare-annotation-harness')
harness = module('annotation-harness')
benchmark_preparer = module('prepare-harness-benchmark')


class BenchmarkGoldTest(unittest.TestCase):
    def test_gold_uses_the_final_human_decision_instead_of_design_or_agent_comment(self):
        data = feedback()
        original = claim()
        corrected = claim(presence='absent')
        row = review(original, status='modified', rationale='Exact human correction.')
        row['modifiedClaim'] = corrected
        data['agentReviews'] = [row]
        case = {'benchmarkCaseId': 'case', 'cohort': 'regression', 'sourceSha256': data['sourceSha256'],
                'decisionId': row['decision']['id'], 'handoffId': row['handoffId'], 'claimId': row['claimId'],
                'scope': corrected['scope'], 'reviewContext': corrected['reviewContext'],
                'goldTagId': 'tech', 'goldAssessment': corrected['assessment'],
                'feedbackSha256': 'verified-snapshot', 'humanRationale': 'Unverified agent design prose.'}
        for comment in ('Exact human correction.', 'Human confirmed the original proposal.'):
            with self.subTest(comment=comment):
                row['decision']['rationale'] = comment
                gold = benchmark_preparer.benchmark_gold(case, data)
                self.assertEqual(gold['gold'], {'tech': {'presence': 'absent'}})
                self.assertNotIn('agent', json.dumps(gold))
                self.assertNotIn('Old machine uncertainty', json.dumps(gold))
                if comment.startswith('Exact'):
                    self.assertEqual(gold['humanComment'], comment)
                else:
                    self.assertNotIn('humanComment', gold)
        with self.assertRaisesRegex(ValueError, 'gold differs'):
            benchmark_preparer.benchmark_gold({**case, 'goldAssessment': original['assessment']}, data)
        with self.assertRaisesRegex(ValueError, 'scope is not'):
            benchmark_preparer.benchmark_gold({**case, 'scope': {'startMs': 1, 'endMs': 2}}, data)
        row['status'] = 'needs-expert'
        with self.assertRaisesRegex(ValueError, 'referenced final human judgment'):
            benchmark_preparer.benchmark_gold(case, data)


class HarnessTest(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        campaign = self.root / 'campaign'
        sources, sections = [], []
        self.feedback_dir = self.root / 'feedback'
        self.source_ids = []
        for index in range(3):
            # Valid source input, two related difficulties plus another song.
            text = ('osu file format v14\n[General]\nMode:3\n[Metadata]\n'
                    f'Title:Fixture {index}\nVersion:Test\n[Difficulty]\nCircleSize:4\n'
                    '[TimingPoints]\n0,500,4,2,0,100,1,0\n[HitObjects]\n'
                    '64,192,1000,128,0,1500:0:0:0:0:\n192,192,1250,1,0,0:0:0:0:\n')
            path = self.root / f'source-{index}.osu'
            path.write_text(text)
            sha = hashlib.sha256(path.read_bytes()).hexdigest()
            self.source_ids.append(sha)
            source = {'sha256': sha, 'title': f'Fixture {index}', 'difficulty': 'Test',
                      'keyCount': 4, 'beatmapSetId': 10 if index < 2 else 20}
            bounds = {'startMs': 0, 'endMs': 1501}
            sources.append({'source': source, 'range': bounds, 'sourcePath': str(path)})
            notes = [{'source_line': 12, 'column': 0, 'kind': 'long', 'start_ms': 1000, 'end_ms': 1500},
                     {'source_line': 13, 'column': 1, 'kind': 'normal', 'start_ms': 1250, 'end_ms': 1250}]
            meta = {'source': source, 'range': bounds,
                    'timingPoints': [{'sourceLine': 10, 'fields': ['0', '500', '4', '2', '0', '100', '1', '0']}]}
            target = campaign / 'agent/charts' / (sha + '.parquet')
            target.parent.mkdir(parents=True, exist_ok=True)
            table = pa.Table.from_pylist(notes).replace_schema_metadata({b'beatmap_lens': json.dumps(meta).encode()})
            pq.write_table(table, target)
            data = feedback(sha)
            value = claim(identity=f'claim-{index}')
            value.update(scope={'startMs': 1000, 'endMs': 1501}, reviewContext=bounds)
            data['agentReviews'] = [review(value, identity=f'human-{index}', rationale=f'Exact human explanation {index}.')]
            data['agentReviews'][0]['observationSha256'] = str(index) * 64
            prepare.save(self.feedback_dir / f'{sha}.json', data)
            sections.append({'caseId': f'case-{index}', 'sourceSha256': sha,
                             'scope': value['scope'], 'reviewContext': bounds})
        prepare.save(campaign / 'admin/source-map.json', sources)
        prepare.save(campaign / 'controller/config.json', {'foundationSha256': 'frozen-foundation'})
        self.sections = self.root / 'sections.json'
        prepare.save(self.sections, {'cases': sections[:1]})
        self.campaign = campaign
        self.bundle = self.root / 'bundle'
        self.contrast_sets = self.root / 'curated-sets.json'
        records = extract_examples([prepare.read(p) for p in self.feedback_dir.glob('*.json')], {})
        self.example_ids = {record['sourceSha256']: record['id'] for record in records}
        prepare.save(self.contrast_sets, {'sets': [
            {'id': 'articulation', 'description': 'Compare articulation and expression.',
             'exampleIds': [self.example_ids[sha] for sha in self.source_ids]},
            {'id': 'target-only', 'description': 'A comparison unavailable under this evaluation split.',
             'exampleIds': [self.example_ids[sha] for sha in self.source_ids[:2]]}]})
        prepare.prepare(campaign, self.sections, self.feedback_dir, self.bundle, 'evaluation',
                        contrast_sets_path=self.contrast_sets)

    def test_evaluation_excludes_target_and_related_difficulty_labels_from_disk_and_tools(self):
        library = prepare.read(self.bundle / 'examples.json')
        self.assertEqual(len(library), 1)
        self.assertEqual(library[0]['sourceSha256'], self.source_ids[2])
        agent = harness.Harness(self.bundle)
        cards = agent.search()['cards']
        self.assertEqual(len(cards), 1)
        self.assertNotIn('sourceSha256', cards[0])
        self.assertNotIn('existingHumanJudgments', agent.context('case-0'))
        records = extract_examples([prepare.read(p) for p in self.feedback_dir.glob('*.json')], {})
        excluded = next(e for e in records if e['sourceSha256'] == self.source_ids[0])
        with self.assertRaisesRegex(ValueError, 'unavailable'):
            agent.example(excluded['id'])
        with self.assertRaisesRegex(ValueError, 'unavailable'):
            agent.rows('example:' + excluded['id'])
        frozen_sets = prepare.read(self.bundle / 'contrast-sets.json')
        self.assertEqual(frozen_sets['sets'][0]['exampleIds'], [library[0]['id']])
        self.assertEqual(len(frozen_sets['sets']), 1)
        search = agent.search(contrast_set='articulation')
        self.assertEqual(search['availableContrastSets'][0]['assessmentCounts'],
                         {'absent': 0, 'supporting': 1, 'prominent': 0})
        for sha in self.source_ids[:2]:
            self.assertNotIn(self.example_ids[sha], json.dumps(frozen_sets))
            self.assertNotIn(self.example_ids[sha], json.dumps(search))
        self.assertNotIn('target-only', json.dumps(search))
        with self.assertRaisesRegex(ValueError, 'unavailable'):
            agent.search(contrast_set='target-only')
        self.assertEqual(agent.manifest['provenance']['contrastSetsSha256'], prepare.digest(self.contrast_sets))
        self.assertEqual(agent.manifest['files']['contrast-sets.json'], prepare.digest(self.bundle / 'contrast-sets.json'))

    def test_annotation_reuses_exact_scoped_human_judgments_and_reference_views(self):
        bundle = self.root / 'annotation'
        prepare.prepare(self.campaign, self.sections, self.feedback_dir, bundle, 'annotation',
                        contrast_sets_path=self.contrast_sets)
        agent = harness.Harness(bundle)
        current = agent.context('case-0')['existingHumanJudgments']
        self.assertEqual(current[0]['humanComment'], 'Exact human explanation 0.')
        card = agent.search()['cards'][0]
        example = agent.example(card['id'])
        view = agent.rows(example['sectionId'], view='actions')
        self.assertEqual(view['sourceSha256'], example['sourceSha256'])
        self.assertTrue(view['coverage']['allEventsReturned'])
        self.assertNotIn('notes', example)

    def test_preparation_preserves_current_human_confidence_and_derives_reference_facts_from_source(self):
        source = self.source_ids[2]
        path = self.feedback_dir / (source + '.json')
        data = prepare.read(path)
        row = data['agentReviews'][0]
        row['summary']['sourceFacts'] = {'noteKind': 'machine-only-inherited-fact'}
        data['effectiveHumanObservations'] = [{
            'id': row['decision']['observationId'], 'summary': row['summary'],
            'confidence': 'high', 'humanComment': '', 'observationSha256': 'a' * 64,
            'humanId': 'local-expert', 'confirmedAt': '2026-09-11T00:00:00Z',
            'foundationSha256': 'stored-human-foundation'}]
        prepare.save(path, data)
        bundle = self.root / 'reference-facts'
        prepare.prepare(self.campaign, self.sections, self.feedback_dir, bundle, 'evaluation',
                        contrast_sets_path=self.contrast_sets)
        agent = harness.Harness(bundle)
        result = agent.search(confidence='high', key_count=4, note_kind='with-ln')
        card, = result['cards']
        self.assertEqual(card['title'], 'Fixture 2')
        self.assertEqual(card['difficulty'], 'Test')
        self.assertEqual(card['humanConfidence'], 'high')
        self.assertNotIn('humanComment', card)
        self.assertEqual(card['sourceFacts'], {'keyCount': 4, 'noteKind': 'with-ln', 'attackRowCount': 2,
                                             'tapCount': 1, 'longNoteHeadCount': 1, 'enteringHoldCount': 0,
                                             'chordSizeCounts': [[1, 2]]})
        self.assertNotIn('machine-only', json.dumps(prepare.read(bundle / 'examples.json')))
        self.assertEqual(result['availableConfidenceCounts'], {'high': 1, 'low': 0, 'unspecified': 0})
        self.assertEqual(agent.example(card['id'])['sourceFacts'], card['sourceFacts'])
        self.assertEqual(agent.example(card['id'])['humanConfidence'], 'high')
        self.assertEqual(agent.search(confidence='low')['total'], 0)
        self.assertEqual(agent.search(note_kind='tap-only')['total'], 0)

    def test_trace_tracks_returned_examples_and_context_without_exposing_provenance_to_worker(self):
        bundle = self.root / 'tracked-annotation'
        prepare.prepare(self.campaign, self.sections, self.feedback_dir, bundle, 'annotation',
                        contrast_sets_path=self.contrast_sets)
        trace = self.root / 'human-trace.jsonl'
        agent = harness.Harness(bundle, trace)
        self.assertEqual(trace.read_text(), '')
        body, _ = agent.call('find_human_examples', {'limit': 1})
        card, = json.loads(body)['cards']
        self.assertNotIn('observationSha256', body)
        agent.call('get_human_example', {'example_id': card['id']})
        agent.call('inspect_section', {'section_id': 'example:' + card['id']})
        context, _ = agent.call('chart_context', {'section_id': 'case-0'})
        self.assertNotIn('observationSha256', context)
        agent.call('inspect_section', {'section_id': 'case-0'})
        events = [json.loads(line) for line in trace.read_text().splitlines()]
        refs = prepare.read(bundle / 'example-refs.json')
        self.assertTrue(all(event['humanEvidenceTrackingComplete'] for event in events))
        for event in events[:3]:
            self.assertEqual(event['humanEvidenceRefs'], [refs[card['id']]])
        self.assertEqual(events[3]['humanEvidenceRefs'], [refs[self.example_ids[self.source_ids[0]]]])
        self.assertEqual(events[4]['humanEvidenceRefs'], [])
        self.assertEqual(len(events[0]['humanEvidenceRefs']), 1)
        self.assertEqual(len(refs), 3)

    def test_legacy_human_example_without_canonical_hash_is_marked_untracked(self):
        source = self.source_ids[2]
        path = self.feedback_dir / (source + '.json')
        data = prepare.read(path)
        data['agentReviews'][0].pop('observationSha256')
        prepare.save(path, data)
        bundle = self.root / 'legacy-human'
        prepare.prepare(self.campaign, self.sections, self.feedback_dir, bundle, 'evaluation',
                        contrast_sets_path=self.contrast_sets)
        trace = self.root / 'legacy-human-trace.jsonl'
        agent = harness.Harness(bundle, trace)
        agent.call('find_human_examples', {})
        event = json.loads(trace.read_text())
        self.assertFalse(event['humanEvidenceTrackingComplete'])
        self.assertEqual(event['humanEvidenceRefs'], [])

    def test_search_full_and_context_expose_only_final_human_judgment_and_optional_comment(self):
        bundle = self.root / 'public-human-views'
        prepare.prepare(self.campaign, self.sections, self.feedback_dir, bundle, 'annotation',
                        contrast_sets_path=self.contrast_sets)
        agent = harness.Harness(bundle)
        record = next(e for e in agent.examples if e['sourceSha256'] == self.source_ids[0])
        record.update(agentComment='machine-only-comment', evidence={'rationale': 'machine-only-evidence'},
                      proposal='machine-only-proposal', audit={'text': 'machine-only-audit'},
                      arbitraryFutureField='machine-only-future')
        record['provenance'] = {'rationale': 'machine-only-provenance'}
        record['sourceEvidence'] = {'rationale': 'machine-only-source-evidence'}
        record['assessment']['agentRationale'] = 'machine-only-assessment'
        record['scope']['agentRationale'] = 'machine-only-scope'
        record['reviewContext']['agentRationale'] = 'machine-only-context'
        agent.manifest['charts'][self.source_ids[0]]['source'].update(
            noteCount=123, taskId='machine-only-task', agentComment='machine-only-source-comment')
        for comment in ('  Exact human comment.\nSecond line.  ', '/', 'Human confirmed the original proposal.', ''):
            with self.subTest(comment=comment):
                record['humanComment'] = comment
                card = next(c for c in agent.search()['cards'] if c['id'] == record['id'])
                full = agent.example(record['id'])
                context, = agent.context('case-0')['existingHumanJudgments']
                self.assertNotIn('machine-only', json.dumps(agent.context('example:' + record['id'])))
                for value in (card, full, context):
                    self.assertEqual(value['assessment'], {'presence': 'present', 'salience': 'supporting'})
                    self.assertNotIn('machine-only', json.dumps(value))
                    for excluded in ('rationale', 'rationaleOrigin', 'provenance', 'sourceEvidence', 'evidence', 'proposal', 'audit'):
                        self.assertNotIn(excluded, value)
                    if comment.startswith('  Exact'):
                        self.assertEqual(value['humanComment'], comment)
                    else:
                        self.assertNotIn('humanComment', value)
                self.assertNotIn('noteCount', full['source'])
        self.assertEqual(agent.search(text='machine-only')['total'], 0)
        self.assertEqual(agent.rows('example:' + record['id'])['rows'][0][1], [[12, 0, 'long', 1000, 1500]])

    def test_saved_example_library_is_human_only_in_both_modes_for_every_dimension(self):
        tags = ('jack-organization', 'stream-organization', 'trill-organization', 'tech', 'ln-coordination')
        for path in self.feedback_dir.glob('*.json'):
            data = prepare.read(path)
            original = data['agentReviews'][0]
            data['agentReviews'] = []
            for tag in tags:
                value = claim(identity=tag)
                value.update(tagId=tag, scope=original['summary']['scope'],
                             reviewContext=original['summary']['reviewContext'])
                data['agentReviews'].append(review(value, identity=tag, rationale='Exact human comment.'))
            prepare.save(path, data)
        allowed = {'id', 'sourceSha256', 'groupId', 'tagId', 'assessment', 'scope', 'reviewContext',
                   'humanComment', 'humanConfidence', 'title', 'difficulty', 'sourceFacts'}
        for mode in ('annotation', 'evaluation'):
            with self.subTest(mode=mode):
                bundle = self.root / f'human-only-{mode}'
                prepare.prepare(self.campaign, self.sections, self.feedback_dir, bundle, mode,
                                contrast_sets_path=self.contrast_sets)
                records = prepare.read(bundle / 'examples.json')
                self.assertEqual({e['tagId'] for e in records}, set(tags))
                self.assertEqual(len(records), 15 if mode == 'annotation' else 5)
                for record in records:
                    self.assertLessEqual(set(record), allowed)
                    self.assertEqual(record['humanComment'], 'Exact human comment.')
                    self.assertNotIn('Old machine uncertainty', json.dumps(record))
                agent = harness.Harness(bundle)
                for tag in tags:
                    for card in agent.search(tag_id=tag)['cards']:
                        self.assertEqual(agent.example(card['id'])['humanComment'], 'Exact human comment.')

    def test_job_case_handles_disambiguate_source_local_section_ids(self):
        first = prepare.read(self.sections)['cases'][0]
        first['sectionId'] = 'whole-source'
        second = {**first, 'caseId': 'case-1', 'sourceSha256': self.source_ids[1]}
        prepare.save(self.sections, {'cases': [first, second]})
        bundle = self.root / 'unique-handles'
        prepare.prepare(self.campaign, self.sections, self.feedback_dir, bundle, 'evaluation',
                        contrast_sets_path=self.contrast_sets)
        agent = harness.Harness(bundle)
        self.assertEqual(agent.rows('case-0')['sourceSha256'], self.source_ids[0])
        self.assertEqual(agent.rows('case-1')['sourceSha256'], self.source_ids[1])
        for section in (first, second):
            section.pop('caseId')
        prepare.save(self.sections, {'sections': [first, second]})
        with self.assertRaisesRegex(ValueError, 'Supply unique caseId'):
            prepare.prepare(self.campaign, self.sections, self.feedback_dir, self.root / 'collision',
                            contrast_sets_path=self.contrast_sets)

    def test_changed_source_snapshot_is_detected_before_inspection(self):
        manifest = prepare.read(self.bundle / 'manifest.json')
        chart = self.bundle / manifest['charts'][self.source_ids[0]]['path']
        chart.write_text(chart.read_text().replace('Fixture 0', 'Edited title'))
        with self.assertRaisesRegex(ValueError, 'Frozen harness input changed'):
            harness.Harness(self.bundle).rows('case-0')

    def test_changed_tool_snapshot_is_detected_on_start(self):
        path = self.bundle / 'tools/harness_inspection.py'
        path.write_text(path.read_text() + '\n# changed\n')
        with self.assertRaisesRegex(ValueError, 'Frozen harness tool changed'):
            harness.Harness(self.bundle)

    def test_native_mcp_returns_compact_text_images_and_actionable_argument_errors(self):
        async def run():
            trace = self.root / 'trace.jsonl'
            params = StdioServerParameters(command=sys.executable, args=[
                str(self.bundle / 'tools/annotation-harness.py'), '--bundle', str(self.bundle), '--trace', str(trace)])
            async with stdio_client(params) as (reader, writer):
                async with ClientSession(reader, writer) as client:
                    await client.initialize()
                    tools = (await client.list_tools()).tools
                    self.assertEqual(len(tools), 7)
                    self.assertTrue(all(t.annotations.readOnlyHint for t in tools))
                    examples = await client.call_tool('find_human_examples', {'contrast_set': 'articulation',
                                                                             'assessment': 'supporting',
                                                                             'confidence': 'unspecified',
                                                                             'key_count': 4, 'note_kind': 'with-ln'})
                    self.assertFalse(examples.isError)
                    search = json.loads(examples.content[0].text)
                    self.assertEqual(search['cards'][0]['id'], self.example_ids[self.source_ids[2]])
                    self.assertEqual(search['missingContrastLabels'], ['absent', 'prominent'])
                    self.assertEqual(search['availableContrastSets'][0]['id'], 'articulation')
                    self.assertEqual(search['matchedConfidenceCounts'], {'high': 0, 'low': 0, 'unspecified': 1})
                    self.assertEqual(search['cards'][0]['sourceFacts']['noteKind'], 'with-ln')
                    context = await client.call_tool('chart_context', {'section_id': 'case-0', 'start_ms': 0,
                                                                       'timing_offset': 0, 'timing_limit': 1})
                    self.assertFalse(context.isError)
                    self.assertEqual(json.loads(context.content[0].text)['timingChanges']['returned'], 1)
                    page = await client.call_tool('inspect_section', {'section_id': 'case-0', 'view': 'actions', 'limit': 1})
                    self.assertFalse(page.isError)
                    self.assertEqual(json.loads(page.content[0].text)['pagination']['nextOffset'], 1)
                    articulation = await client.call_tool('inspect_section', {'section_id': 'case-0', 'view': 'articulation'})
                    self.assertFalse(articulation.isError)
                    detail = json.loads(articulation.content[0].text)
                    self.assertEqual(detail['rows'][0], [1000, [[12, 0, 'long', 1000, 1500]], 250,
                                                         [[12, 500, 1, 1, 'after-last-attack', [], []]]])
                    self.assertEqual(detail['rows'][1][:2], [1250, [[13, 1, 'normal', 1250, 1250]]])
                    negative = await client.call_tool('inspect_section', {'section_id': 'case-0', 'offset': -1000})
                    self.assertTrue(negative.isError)
                    self.assertIn('nonnegative', negative.content[0].text)
                    query = await client.call_tool('query_structure', {'section_id': 'case-0', 'query': 'ln-events'})
                    self.assertFalse(query.isError)
                    self.assertGreater(json.loads(query.content[0].text)['total'], 0)
                    image = await client.call_tool('render_section', {'section_id': 'case-0'})
                    self.assertFalse(image.isError)
                    self.assertEqual([c.type for c in image.content], ['text', 'image'])
                    self.assertEqual(image.content[1].mimeType, 'image/png')
            records = [json.loads(line) for line in trace.read_text().splitlines()]
            self.assertEqual(records[-1]['tool'], 'render_section')
            self.assertGreater(records[-1]['imageBytes'], 0)
            self.assertNotIn('png', records[-1]['response'])
            self.assertEqual(sum(record['failed'] for record in records), 1)
        asyncio.run(run())


if __name__ == '__main__':
    unittest.main()
