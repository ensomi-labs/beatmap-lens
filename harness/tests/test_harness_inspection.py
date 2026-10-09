"""Supported observation boundaries and the information kept by each view."""
import json
import unittest

from harness_inspection import chart_context, inspect, perspective


def note(line, start, column, end=None):
    return {"sourceLine": line, "column": column, "kind": "normal" if end is None else "long",
            "startMs": start, "endMs": start if end is None else end}


def chart(notes, timing=None):
    return {
        "source": {"sha256": "fixture-source", "title": "Source fixture", "keyCount": 4},
        "range": {"startMs": min(n["startMs"] for n in notes),
                  "endMs": max(n["endMs"] for n in notes) + 1},
        "notes": notes,
        "timingPoints": timing if timing is not None else [
            {"sourceLine": 1, "fields": ["-1000", "500", "4", "2", "0", "100", "1", "0"]},
        ],
    }


class HarnessInspectionTest(unittest.TestCase):
    def test_entering_holds_and_full_ends_survive_scope_and_page_boundaries(self):
        source = chart([note(10, -100, 0, 1500), note(11, -50, 1, 0),
                        note(12, 0, 1, 1000), note(13, 250, 2), note(14, 500, 3)])
        first = inspect(source, 0, 600, limit=1)
        self.assertEqual(first["enteringHolds"], [[10, 0, "long", -100, 1500]])
        self.assertEqual(first["rows"], [[0, [[12, 1, "long", 0, 1000]]]])
        self.assertFalse(first["coverage"]["allEventsReturned"])
        second = inspect(source, 0, 600, offset=1, limit=1)
        self.assertEqual(second["pageEnteringHolds"], [[10, 0, "long", -100, 1500],
                                                        [12, 1, "long", 0, 1000]])
        self.assertTrue(second["coverage"]["enteringHoldsComplete"])

    def test_equal_time_release_is_not_a_continuing_hold(self):
        source = chart([note(10, -100, 0, 0), note(11, 0, 1, 500),
                        note(12, 500, 2, 1000), note(13, 500, 3), note(14, 1000, 0)])
        result = inspect(source, 0, 1000, view="actions")
        self.assertEqual([event[0] for event in result["rows"]], [0, 500])
        self.assertEqual(result["enteringHolds"], [])
        self.assertEqual(result["rows"][0][2], [[10, 0, "long", -100, 0]])
        self.assertEqual(result["rows"][1][2], [[11, 1, "long", 0, 500]])
        self.assertEqual(result["rows"][1][3], [])
        self.assertTrue(result["coverage"]["allEventsReturned"])
        facts = perspective(source, 0, 1000)["pressHoldRelease"]
        self.assertEqual(facts["simultaneousPressReleaseEvents"], 2)
        self.assertEqual(facts["pressWhileOtherHoldsContinueEvents"], 0)

    def test_paging_recovers_each_complete_row_without_duplication(self):
        notes = [note(100 + i * 2 + column, i * 100, column) for i in range(90) for column in (0, 1)]
        source = chart(list(reversed(notes)))
        events, offset = [], 0
        while offset is not None:
            page = inspect(source, 0, 9000, offset=offset, limit=17)
            events.extend(page["rows"])
            offset = page["pagination"]["nextOffset"]
        self.assertEqual([event[0] for event in events], list(range(0, 9000, 100)))
        self.assertEqual([n[0] for event in events for n in event[1]], list(range(100, 280)))
        limited = inspect(source, 0, 9000, limit=1000)
        self.assertEqual(limited["pagination"]["returned"], 64)
        self.assertEqual(limited["pagination"]["nextOffset"], 64)
        self.assertEqual(limited["coverage"]["eventsNotInThisPage"], 26)
        with self.assertRaisesRegex(ValueError, "offset must be nonnegative"):
            inspect(source, 0, 9000, offset=-1000)

    def test_same_chord_counts_retain_different_column_organizations(self):
        repeated = [note(10 + i * 2 + c, i * 100, c) for i in range(6) for c in (0, 1)]
        alternating = [{**n, "column": n["column"] + (2 if n["startMs"] // 100 % 2 else 0)}
                       for n in repeated]
        a = perspective(chart(repeated), 0, 600)["pressOrganization"]
        b = perspective(chart(alternating), 0, 600)["pressOrganization"]
        self.assertEqual(a["rowArities"], b["rowArities"])
        self.assertEqual(a["identicalPressGroups"], 5)
        self.assertEqual(b["identicalPressGroups"], 0)
        self.assertEqual(b["disjointPressGroups"], 5)
        self.assertEqual(a["recurrences"]["examples"][0]["kind"], "identical complete press group")
        self.assertEqual(b["recurrences"]["examples"][0]["kind"], "disjoint complete-group alternation")

    def test_same_heads_retain_staggered_release_articulation(self):
        shared = [note(10, 0, 0, 100), note(11, 0, 1, 100),
                  note(12, 100, 0, 200), note(13, 100, 1, 200)]
        staggered = [{**n, "endMs": n["endMs"] - (50 if n["column"] == 0 else 0)} for n in shared]
        a = perspective(chart(shared), 0, 201)
        b = perspective(chart(staggered), 0, 201)
        self.assertEqual(a["pressOrganization"], b["pressOrganization"])
        self.assertEqual(a["pressHoldRelease"]["releaseWhileOtherHoldsContinueEvents"], 0)
        self.assertEqual(b["pressHoldRelease"]["releaseWhileOtherHoldsContinueEvents"], 2)
        self.assertEqual(b["pressHoldRelease"]["releaseOnlyEvents"], 3)
        events = inspect(chart(staggered), 0, 201, view="actions")["rows"]
        self.assertEqual(events[1][0], 50)
        self.assertEqual(events[1][3], [[11, 1, "long", 0, 100]])

    def test_articulation_keeps_mixed_rows_and_describes_ln_head_tail_relationships(self):
        # A short-LN chord releases around tap rows and a same-column renewal.
        source = chart([note(10, 0, 0, 100), note(11, 0, 1, 40), note(12, 0, 2, 125),
                        note(13, 50, 1), note(14, 75, 3), note(15, 100, 0, 200),
                        note(16, 125, 2), note(17, 150, 1, 225), note(18, 200, 0),
                        note(19, 250, 3), note(20, 300, 2, 350)])
        plain = inspect(source, 0, 351)
        result = inspect(source, 0, 351, view="articulation")
        self.assertEqual([row[:2] for row in result["rows"]], plain["rows"])
        self.assertEqual(result["coverage"], plain["coverage"])
        self.assertEqual([row[2] for row in result["rows"]], [50, 25, 25, 25, 25, 50, 50, 50, None])
        facts = {item[0]: item for row in result["rows"] for item in row[3]}
        self.assertEqual(facts[10], [10, 100, 0.2, 2, "at-attack", [0], [2]])
        self.assertEqual(facts[11], [11, 40, 0.08, 0, "between-attacks", [], [0, 2]])
        self.assertEqual(facts[12], [12, 125, 0.25, 3, "at-attack", [2], [0]])
        self.assertEqual(facts[15], [15, 100, 0.2, 2, "at-attack", [0], [1]])
        self.assertEqual(facts[17], [17, 75, 0.15, 1, "between-attacks", [], []])
        self.assertEqual(facts[20], [20, 50, 0.1, 0, "after-last-attack", [], []])
        self.assertEqual(set(facts), {n["sourceLine"] for n in source["notes"] if n["kind"] == "long"})

    def test_articulation_integrates_tempo_and_keeps_source_facts_across_scope_and_pages(self):
        timing = [
            {"sourceLine": 1, "fields": ["0", "500", "4", "2", "0", "100", "1", "0"]},
            {"sourceLine": 2, "fields": ["50", "-25", "4", "2", "0", "100", "0", "0"]},
            {"sourceLine": 3, "fields": ["100", "250", "4", "2", "0", "100", "1", "0"]},
        ]
        source = chart([note(10, 0, 0, 200), note(11, 0, 1, 50), note(12, 50, 1, 125),
                        note(13, 100, 2), note(14, 125, 3), note(15, 200, 0)], timing)
        first = inspect(source, 50, 125, view="articulation", limit=1)
        self.assertEqual(first["enteringHolds"], [[10, 0, "long", 0, 200]])
        self.assertEqual(first["enteringHoldArticulation"], [[10, 200, 0.6, 3, "at-attack", [0], []]])
        self.assertEqual(first["rows"][0][3], [[12, 75, 0.2, 1, "at-attack", [3], [0]]])
        second = inspect(source, 50, 125, view="articulation", offset=first["pagination"]["nextOffset"], limit=1)
        self.assertEqual(second["pageEnteringHolds"], [[10, 0, "long", 0, 200], [12, 1, "long", 50, 125]])
        self.assertEqual(second["pageEnteringHoldArticulation"], [first["enteringHoldArticulation"][0], first["rows"][0][3][0]])
        # The next row and both tails remain source facts beyond the half-open crop.
        self.assertEqual(second["rows"], [[100, [[13, 2, "normal", 100, 100]], 25, []]])
        self.assertIsNone(second["pagination"]["nextOffset"])
        release_crop = inspect(source, 125, 126, view="articulation")
        self.assertEqual(release_crop["enteringHolds"], [[10, 0, "long", 0, 200]])
        self.assertEqual(release_crop["rows"][0][1], [[14, 3, "normal", 125, 125]])
        between = inspect(source, 175, 180, view="articulation")
        self.assertEqual(between["rows"], [])
        self.assertEqual(between["enteringHoldArticulation"], first["enteringHoldArticulation"])

    def test_tempo_changes_integrate_beats_and_inherited_sv_does_not(self):
        timing = [
            {"sourceLine": 1, "fields": ["0", "500", "4", "2", "0", "100", "1", "0"]},
            {"sourceLine": 2, "fields": ["250", "-25", "4", "2", "0", "100", "0", "0"]},
            {"sourceLine": 3, "fields": ["500", "250", "3", "2", "0", "100", "1", "0"]},
            {"sourceLine": 4, "fields": ["750", "-50", "3", "2", "0", "100", "0", "0"]},
        ]
        source = chart([note(10, 0, 0), note(11, 1000, 1), note(12, 1250, 2)], timing)
        context = chart_context(source, 600, 1100)
        self.assertEqual(context["activeTempoAtStart"]["bpm"], 240)
        self.assertEqual(context["activeTempoAtStart"]["meter"], 3)
        self.assertEqual(context["activeSvAtStart"], {"rawMultiplier": 1, "sourceLine": 3})
        self.assertEqual(context["timingChanges"]["points"][0]["kind"], "sv")
        self.assertEqual(chart_context(source, 800, 1100)["activeSvAtStart"]["rawMultiplier"], 2)
        facts = perspective(source, 0, 1300)
        self.assertEqual(facts["pulse"]["examples"][0]["gapsMs"], [1000, 250])
        self.assertEqual(facts["pulse"]["examples"][0]["beatDistances"], [3, 1])

    def test_context_neighbors_and_timing_overflow_are_explicit(self):
        timing = [{"sourceLine": i + 1,
                   "fields": [str(i * 100), "500", "4", "2", "0", "100", "1", "0"]}
                  for i in range(20)]
        source = chart([note(100, 0, 0), note(101, 500, 1), note(102, 2500, 2)], timing)
        result = chart_context(source, 250, 2000)
        self.assertEqual(result["neighbors"]["previousAttackRow"]["sourceLines"], [100])
        self.assertEqual(result["neighbors"]["nextAttackRow"]["sourceLines"], [102])
        self.assertEqual(result["timingChanges"]["total"], 17)
        self.assertEqual(len(result["timingChanges"]["points"]), 12)
        self.assertEqual(result["timingChanges"]["omitted"], 5)
        self.assertEqual(result["timingChanges"]["nextOffset"], 12)
        self.assertEqual(sum(part["heads"] for part in result["overview"]), 3)

    def test_timing_pagination_keeps_later_tempo_changes_and_same_time_sv(self):
        # A red/green pair at each beat models Caravan's dense timing example.
        timing = [{"sourceLine": 10 + i * 2 + inherited,
                   "fields": [str(i * 250), str(-50 if inherited else 500 - i * 5),
                              "4", "2", "0", "100", str(1 - inherited), "0"]}
                  for i in range(20) for inherited in range(2)]
        source = chart([note(100, 0, 0), note(101, 5000, 1)], timing)
        offset, points = 0, []
        while offset is not None:
            result = chart_context(source, 0, 5000, timing_offset=offset)
            page = result["timingChanges"]
            points.extend(page["points"])
            self.assertEqual(page["total"], 40)
            self.assertFalse(page["allChangesReturned"])
            # Paging timing facts does not shift the requested start's active BPM.
            self.assertEqual(result["activeTempoAtStart"]["bpm"], 120)
            offset = page["nextOffset"]
        self.assertEqual([p["sourceLine"] for p in points], list(range(10, 50)))
        self.assertEqual([p["kind"] for p in points], ["tempo", "sv"] * 20)
        limited = chart_context(source, 0, 5000, timing_limit=1000)["timingChanges"]
        self.assertEqual(limited["returned"], 32)
        self.assertEqual(limited["nextOffset"], 32)
        with self.assertRaisesRegex(ValueError, "timing_offset must be nonnegative"):
            chart_context(source, 0, 5000, timing_offset=-1000)

    def test_perspective_is_bounded_and_marks_examples_as_partial(self):
        notes = [note(100 + i * 2 + column, i * 100, column, i * 100 + 50 + column * 20)
                 for i in range(1000) for column in (0, 1)]
        result = perspective(chart(notes), 0, 100000)
        self.assertEqual(result["pressOrganization"]["heads"], 2000)
        self.assertEqual(result["pressHoldRelease"]["releaseEvents"], 2000)
        self.assertIn("not complete inspection", result["coverage"])
        self.assertLess(len(json.dumps(result).split()), 800)
        self.assertLessEqual(len(result["pressHoldRelease"]["examples"]), 3)
        self.assertLessEqual(len(result["pressOrganization"]["recurrences"]["examples"]), 3)


if __name__ == "__main__":
    unittest.main()
