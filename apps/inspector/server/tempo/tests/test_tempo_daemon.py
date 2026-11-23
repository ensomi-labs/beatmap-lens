"""Unit and integration tests for ``tempo_daemon.py`` DSP invariants and warm concurrency."""

from __future__ import annotations

import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import wave

import numpy as np

import tempo_daemon as daemon

RATE = 44100
FORBIDDEN_COPY_RE = re.compile(
    r"\b(mock|wip|experimental|reserved for n1|seg_\d+|beat_\d+|offer_[a-z0-9_]+|batch_[a-z0-9_]+|sound_\d+|unbeat_\d+|sk:[0-9a-f]+)\b",
    re.IGNORECASE,
)


def click_train(
    times_s,
    duration_s: float,
    amplitudes=None,
    rate: int = RATE,
) -> np.ndarray:
    signal = np.zeros(int(round(duration_s * rate)), dtype=np.float64)
    burst = np.exp(-np.arange(int(0.025 * rate)) / (0.0035 * rate))
    noise = np.random.default_rng(7).standard_normal(burst.size)
    for idx, t_val in enumerate(times_s):
        start = int(round(float(t_val) * rate))
        if start < 0 or start >= signal.size:
            continue
        gain = 1.0 if amplitudes is None else float(amplitudes[idx])
        end = min(signal.size, start + burst.size)
        signal[start:end] += 0.65 * gain * (burst * noise)[: end - start]
    return signal


def write_wav(path: Path, samples: np.ndarray, rate: int = RATE) -> None:
    arr = np.asarray(samples, dtype=np.float64)
    if arr.ndim == 1:
        arr = arr[:, None]
    pcm16 = (np.clip(arr, -1.0, 1.0) * 32767.0).round().astype("<i2")
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(arr.shape[1])
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(pcm16.tobytes())


class ZeroScipyAndHopInvariantTest(unittest.TestCase):
    def test_zero_scipy_imports(self):
        self.assertNotIn("scipy", sys.modules)
        source_text = Path(daemon.__file__).read_text(encoding="utf-8")
        self.assertNotRegex(source_text, r"^\s*(import|from)\s+scipy\b")

    def test_exact_hop_prevents_drift_at_22050_hz_for_sounds_and_beats(self):
        rate = 22050
        duration = 42.0
        impulse_sig = np.zeros(int(duration * rate), dtype=np.float64)
        impulse_sig[int(round(40.000 * rate))] = 0.9
        sounds = daemon.onset_flux_sounds(impulse_sig, rate)
        self.assertEqual(len(sounds), 1, sounds)
        self.assertLess(abs(sounds[0]["timeSec"] - 40.000), 0.003, sounds[0])

        step = 50 * (220 / rate)
        times = np.arange(step, 41.0, step)
        beats = daemon.dsp_pulse_beats(click_train(times, duration, rate=rate), rate, duration)
        self.assertGreater(len(beats), 70)
        target = float(times[-1])
        nearest = min(beats, key=lambda b: abs(b["timeSec"] - target))
        self.assertLess(abs(nearest["timeSec"] - target), 0.010, (target, nearest))

    def test_short_clip_under_21_frames_is_safe(self):
        # 80 ms clip (~8 frames at 10 ms hop, < 21-frame kernel).
        sig = click_train([0.03], 0.08, rate=RATE)
        sounds = daemon.onset_flux_sounds(sig, RATE)
        self.assertIsInstance(sounds, list)
        beats = daemon.dsp_pulse_beats(sig, RATE, 0.08)
        self.assertEqual(beats, [])
        hpss_short = daemon.audition_view(sig[:, None], RATE, "percussive")
        self.assertEqual(hpss_short.shape, (sig.size, 1))

        with tempfile.TemporaryDirectory() as folder:
            wav_path = Path(folder) / "tiny.wav"
            write_wav(wav_path, sig, rate=RATE)
            engine = daemon.TempoEngine(backend="dsp")
            res = engine.analyze(wav_path)
            self.assertEqual(res["segments"][0]["t0"], 0.0)
            self.assertAlmostEqual(res["segments"][-1]["t1"], 0.08, places=4)


class ZeroPhaseAuditionTest(unittest.TestCase):
    def test_linear_fft_band_views_do_not_wrap_edges(self):
        pcm = np.zeros((RATE, 2), dtype=np.float64)
        pcm[-1, 0] = 1.0
        pcm[-1, 1] = -1.0
        for view in ("low", "mid", "high"):
            out = daemon.audition_view(pcm, RATE, view)
            self.assertEqual(out.shape, pcm.shape)
            self.assertLess(abs(float(out[0, 0])), 1e-4, f"{view} wrapped ch0: {out[0, 0]}")
            self.assertLess(abs(float(out[0, 1])), 1e-4, f"{view} wrapped ch1: {out[0, 1]}")

    def test_stereo_hpss_preserves_impulse_timestamps_and_channels(self):
        t = np.arange(2 * RATE) / RATE
        left = 0.25 * np.sin(2 * np.pi * 440.0 * t) + click_train([0.5, 1.0, 1.5], 2.0)
        right = 0.25 * np.sin(2 * np.pi * 660.0 * t) + click_train([0.75, 1.25], 2.0)
        stereo = np.column_stack([left, right])

        perc = daemon.audition_view(stereo, RATE, "percussive")
        harm = daemon.audition_view(stereo, RATE, "harmonic")
        self.assertEqual(perc.shape, stereo.shape)
        self.assertEqual(harm.shape, stereo.shape)

        # Left channel impulse at 1.000 s stays at 1.000 s; right channel impulse at 1.250 s stays at 1.250 s.
        l_win = slice(int(0.92 * RATE), int(1.08 * RATE))
        l_peak = int(np.argmax(np.abs(perc[l_win, 0]))) + int(0.92 * RATE)
        self.assertLess(abs(l_peak / RATE - 1.000), 0.005)

        r_win = slice(int(1.17 * RATE), int(1.33 * RATE))
        r_peak = int(np.argmax(np.abs(perc[r_win, 1]))) + int(1.17 * RATE)
        self.assertLess(abs(r_peak / RATE - 1.250), 0.005)


class AnalyzeAndSegmentationTest(unittest.TestCase):
    def test_analyze_detects_break_gaps_and_contiguous_segments(self):
        # Beats in [0.5, 3.5], 4.0 s silence break, then faster beats in [7.8, 11.5].
        part_a = np.arange(0.5, 3.6, 0.5)
        part_b = np.arange(7.8, 11.6, 0.35)
        sig = click_train(np.concatenate([part_a, part_b]), 12.0, rate=RATE)

        with tempfile.TemporaryDirectory() as folder:
            wav_path = Path(folder) / "break_and_pivot.wav"
            write_wav(wav_path, sig, rate=RATE)
            engine = daemon.TempoEngine(backend="dsp")
            res = engine.analyze(wav_path)

            segs = res["segments"]
            self.assertGreaterEqual(len(segs), 3, segs)
            self.assertEqual(segs[0]["t0"], 0.0)
            self.assertAlmostEqual(segs[-1]["t1"], res["durationSec"], places=5)
            for idx in range(len(segs) - 1):
                self.assertEqual(segs[idx]["t1"], segs[idx + 1]["t0"])
                self.assertGreater(segs[idx]["t1"], segs[idx]["t0"])
            self.assertTrue(any(s["regime"] == "break" for s in segs), segs)

            # Break segment should not contain active beats.
            for seg in segs:
                if seg["regime"] == "break":
                    inside = [b for b in res["beats"] if seg["t0"] <= b["timeSec"] < seg["t1"]]
                    self.assertEqual(inside, [], (seg, inside))

    def test_auto_segment_marks_rubato_drift_as_free(self):
        # Expressive accelerando/ritardando IBI drift.
        ibis = [0.62, 0.55, 0.48, 0.42, 0.49, 0.58, 0.66, 0.57, 0.46]
        t_cur = 0.4
        beats = [{"id": "b0", "timeSec": t_cur, "confidence": 0.9, "source": "draft"}]
        for idx, step in enumerate(ibis, start=1):
            t_cur += step
            beats.append({"id": f"b{idx}", "timeSec": round(t_cur, 6), "confidence": 0.9, "source": "draft"})
        segs = daemon.auto_segment_track(beats, 6.0)
        self.assertTrue(any(s["regime"] == "free" for s in segs), segs)


class CpuSuggestSnapsTest(unittest.TestCase):
    def test_verifiable_snap_roles_and_sub_40ms_latency(self):
        duration = 6.0
        n = int(duration * RATE)
        t = np.arange(n) / RATE
        sig = np.zeros(n, dtype=np.float64)

        # 1) Sharp percussive attack at 1.000 s.
        sig += click_train([1.000], duration, rate=RATE)

        # 2) Smooth harmonic vocal/string swell (65 ms cosine ramp, max dE/dt near ~2.032 s).
        s_start = int(round(2.000 * RATE))
        s_ramp = int(round(0.070 * RATE))
        s_hold = int(round(0.250 * RATE))
        env = np.zeros(n, dtype=np.float64)
        ramp = 0.5 * (1.0 - np.cos(np.pi * np.arange(s_ramp) / s_ramp))
        env[s_start : s_start + s_ramp] = ramp
        env[s_start + s_ramp : s_start + s_ramp + s_hold] = 1.0
        env[s_start + s_ramp + s_hold : s_start + s_ramp + s_hold + s_ramp] = ramp[::-1]
        vocal_tone = 0.45 * np.sin(2 * np.pi * 520.0 * t) + 0.25 * np.sin(2 * np.pi * 1040.0 * t)
        sig += env * vocal_tone

        # 3) Constant-amplitude chord change at 3.500 s, followed by abrupt gate release at 4.200 s.
        c_s0 = int(round(3.100 * RATE))
        c_mid = int(round(3.500 * RATE))
        c_end = int(round(4.200 * RATE))
        # Smoothly fade in at 3.100 s so chord at 3.500 s is purely harmonic_change, then hard-cut at 4.200 s!
        chord_a = 0.35 * np.sin(2 * np.pi * 440.0 * t[c_s0:c_mid]) + 0.25 * np.sin(2 * np.pi * 554.37 * t[c_s0:c_mid])
        chord_b = 0.35 * np.sin(2 * np.pi * 659.25 * t[c_mid:c_end]) + 0.25 * np.sin(2 * np.pi * 830.61 * t[c_mid:c_end])
        fade = np.ones(c_mid - c_s0, dtype=np.float64)
        f_len = int(0.05 * RATE)
        fade[:f_len] = np.linspace(0.0, 1.0, f_len)
        sig[c_s0:c_mid] += chord_a * fade
        sig[c_mid:c_end] += chord_b

        with tempfile.TemporaryDirectory() as folder:
            wav_path = Path(folder) / "snaps.wav"
            write_wav(wav_path, sig, rate=RATE)
            engine = daemon.TempoEngine(backend="dsp")
            engine.prepare(wav_path)

            # Query 1: transient_attack near 1.015 s.
            r1 = engine.suggest_snaps(wav_path, time_sec=1.015, window_sec=0.12)
            self.assertLess(r1["elapsedMs"], 40.0, r1)
            roles_1 = [c["role"] for c in r1["candidates"]]
            self.assertIn("transient_attack", roles_1, r1)
            atk = next(c for c in r1["candidates"] if c["role"] == "transient_attack")
            self.assertLess(abs(atk["targetSec"] - 1.000), 0.012, atk)
            self.assertAlmostEqual(atk["deltaMs"], round((atk["targetSec"] - 1.015) * 1000.0, 2), places=2)
            self.assertIsNone(FORBIDDEN_COPY_RE.search(atk["label"]), atk)

            # Query 2: p_center near 2.035 s.
            r2 = engine.suggest_snaps(wav_path, time_sec=2.035, window_sec=0.14)
            self.assertLess(r2["elapsedMs"], 40.0, r2)
            self.assertIn("p_center", [c["role"] for c in r2["candidates"]], r2)

            # Query 3: harmonic_change near 3.510 s.
            r3 = engine.suggest_snaps(wav_path, time_sec=3.510, window_sec=0.14)
            self.assertLess(r3["elapsedMs"], 40.0, r3)
            hc = next((c for c in r3["candidates"] if c["role"] == "harmonic_change"), None)
            self.assertIsNotNone(hc, r3)
            assert hc is not None
            self.assertLess(abs(hc["targetSec"] - 3.500), 0.025, hc)

            # Query 4: release near 4.190 s.
            r4 = engine.suggest_snaps(wav_path, time_sec=4.190, window_sec=0.14)
            self.assertLess(r4["elapsedMs"], 40.0, r4)
            rel = next((c for c in r4["candidates"] if c["role"] == "release"), None)
            self.assertIsNotNone(rel, r4)
            assert rel is not None
            self.assertLess(abs(rel["targetSec"] - 4.200), 0.020, rel)


class StudentTRecomputeAndLruTest(unittest.TestCase):
    def test_student_t_recompute_tolerates_mistap_protects_keep_and_emits_clean_siblings(self):
        # 8 s click track with 0.25 s clicks (ambiguous 240 BPM vs 120 BPM half-time!).
        clicks = np.arange(0.25, 7.8, 0.25)
        amps = [1.0 if i % 2 == 0 else 0.85 for i in range(clicks.size)]
        sig = click_train(clicks, 8.0, amplitudes=amps, rate=RATE)

        with tempfile.TemporaryDirectory() as folder:
            wav_path = Path(folder) / "recompute.wav"
            write_wav(wav_path, sig, rate=RATE)
            engine = daemon.TempoEngine(backend="dsp", max_cached_tracks=3)
            draft = engine.analyze(wav_path)

            # Construct state with:
            # - Segment 0 [0, 3.0) locked with Keep (containing slightly offset beats that MUST NOT be mutated)
            # - Segment 1 [3.0, 8.0) unlocked, with misaligned draft beats (+60 ms late),
            #   consistent user beatGuides at 3.50, 4.00, 4.50, 5.00 PLUS 1 outlier mistap at 4.21!
            #   AND an unbeatRepulsion at 3.75 (repelling the 240 BPM subdivision in favor of 120 BPM!).
            kept_beats = [
                {"id": f"kb_{i}", "timeSec": round(0.50 + i * 0.50 + 0.018, 6), "source": "user", "revision": 1}
                for i in range(5)
            ]
            unlocked_old = [
                {"id": f"ub_{i}", "timeSec": round(3.06 + i * 0.50, 6), "source": "draft", "revision": 1}
                for i in range(9)
            ]
            all_beats = kept_beats + unlocked_old
            revs = {b["id"]: f"1:ev_{b['id']}" for b in all_beats}
            revs["seg_keep"] = "1:ev_seg0"
            revs["seg_open"] = "1:ev_seg1"

            state = {
                "segments": [
                    {"id": "seg_keep", "t0": 0.0, "t1": 3.0, "regime": "auto", "kept": True, "source": "user", "revision": 1},
                    {"id": "seg_open", "t0": 3.0, "t1": 8.0, "regime": "auto", "kept": False, "source": "user", "revision": 1},
                ],
                "beats": all_beats,
                "entityRevisions": revs,
            }
            constraints = {
                "beatGuides": [
                    {"beatId": "g1", "timeSec": 3.500, "toleranceSec": 0.02, "snapFamily": "percussion"},
                    {"beatId": "g2", "timeSec": 4.000, "toleranceSec": 0.02},
                    {"beatId": "g_mistap", "timeSec": 4.190, "toleranceSec": 0.02},
                    {"beatId": "g3", "timeSec": 4.500, "toleranceSec": 0.02},
                    {"beatId": "g4", "timeSec": 5.000, "toleranceSec": 0.02},
                ],
                "unbeatRepulsions": [
                    {"unbeatId": "u1", "timeSec": 3.750, "localIbiSec": 0.5, "repulsionRadiusSec": 0.08},
                ],
                "soundObservations": [],
                "freeIntervals": [],
                "keepLocks": [{"segmentId": "seg_keep", "t0": 0.0, "t1": 3.0}],
            }

            result = engine.recompute(
                {
                    "audioPath": str(wav_path),
                    "scope": "song",
                    "reason": "Align pulse",
                    "generation": 2,
                    "basisSeq": 5,
                    "state": state,
                    "constraints": constraints,
                }
            )
            offers = result["offers"]
            self.assertGreaterEqual(len(offers), 1, result)

            if len(offers) == 2:
                self.assertEqual(offers[0]["batchId"], offers[1]["batchId"])
                self.assertEqual(offers[0]["optionIndex"], 1)
                self.assertEqual(offers[0]["optionCount"], 2)
                self.assertEqual(offers[1]["optionIndex"], 2)
                self.assertEqual(offers[1]["optionCount"], 2)

            primary = offers[0]
            # Verify Keep lock [0, 3.0) is NEVER touched!
            for ws in primary["writeScopes"]:
                self.assertGreaterEqual(ws["t0"], 3.0)
            for b in primary["ops"].get("upsertBeats", []):
                self.assertGreaterEqual(b["timeSec"], 3.0)
                self.assertNotIn(b["id"], {kb["id"] for kb in kept_beats})
            for rid in primary["ops"].get("removeBeatIds", []):
                self.assertNotIn(rid, {kb["id"] for kb in kept_beats})

            # Verify primary beats snap cleanly to 3.50, 4.00, 4.50, 5.00 despite the 4.19 mistap,
            # and avoid placing a beat inside the 3.75 unbeat repulsion!
            final_times = sorted(b["timeSec"] for b in primary["ops"].get("upsertBeats", []))
            for target in (3.50, 4.00, 4.50, 5.00):
                nearest = min(abs(t - target) for t in final_times)
                self.assertLess(nearest, 0.015, (target, final_times))
            self.assertGreater(min(abs(t - 3.75) for t in final_times), 0.10, final_times)

            # Check zero forbidden dev/mock/ID strings in user-facing copy!
            for off in offers:
                self.assertIsNone(FORBIDDEN_COPY_RE.search(off["title"]), off["title"])
                for note in off.get("advisoryNotes", []):
                    self.assertIsNone(FORBIDDEN_COPY_RE.search(note), note)
            _ = draft

    def test_lru_cache_evicts_beyond_max_3_and_stdio_cancel_works(self):
        with tempfile.TemporaryDirectory() as folder:
            engine = daemon.TempoEngine(backend="dsp", max_cached_tracks=3)
            paths = []
            for idx in range(4):
                p = Path(folder) / f"song_{idx}.wav"
                write_wav(p, click_train([0.5, 1.0], 1.5, rate=RATE), rate=RATE)
                paths.append(p)
                engine.prepare(p)
            self.assertEqual(len(engine.cache), 3)
            self.assertNotIn(str(paths[0].resolve()), engine.cache.cached_paths())

            # Subprocess NDJSON stdio roundtrip + cooperative cancel smoke check.
            proc = subprocess.Popen(
                [sys.executable, str(Path(daemon.__file__).resolve()), "--backend", "dsp"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
            )
            try:
                assert proc.stdin is not None and proc.stdout is not None
                proc.stdin.write(json.dumps({"id": "r1", "method": "ping", "params": {}}) + "\n")
                proc.stdin.flush()
                pong = json.loads(proc.stdout.readline())
                self.assertTrue(pong["ok"])
                self.assertTrue(pong["result"]["pong"])

                cancel_ev = threading.Event()
                cancel_ev.set()
                server = daemon.DaemonServer(engine=engine)
                try:
                    with self.assertRaises(daemon.CancelledError):
                        server.dispatch_sync("analyze", {"audioPath": str(paths[1])}, cancel_event=cancel_ev)
                finally:
                    server.close()

                proc.stdin.write(json.dumps({"id": "r_end", "method": "shutdown", "params": {}}) + "\n")
                proc.stdin.flush()
                end_msg = json.loads(proc.stdout.readline())
                self.assertTrue(end_msg["ok"])
            finally:
                for stream in (proc.stdin, proc.stdout, proc.stderr):
                    if stream is not None:
                        try:
                            stream.close()
                        except OSError:
                            pass
                proc.terminate()
                proc.wait(timeout=5)


class AstraDaemonHardeningTest(unittest.TestCase):
    def test_failed_load_retains_zero_inflight_exceptions(self):
        with tempfile.TemporaryDirectory() as folder:
            bad_wav = Path(folder) / "corrupt.wav"
            bad_wav.write_bytes(b"not a valid riff wav file")
            cache = daemon.TrackCache(max_tracks=3)
            with self.assertRaises(Exception):
                cache.get_or_load(bad_wav)
            self.assertEqual(len(cache), 0)
            self.assertEqual(cache._inflight, {})
            self.assertFalse(hasattr(cache, "_inflight_errors"))

    def test_dedicated_snap_pool_never_starves_behind_concurrent_audition_renders(self):
        with tempfile.TemporaryDirectory() as folder:
            wav_path = Path(folder) / "track.wav"
            write_wav(wav_path, click_train([0.5, 1.0, 1.5], 2.0, rate=RATE), rate=RATE)

            proc = subprocess.Popen(
                [sys.executable, str(Path(daemon.__file__).resolve()), "--backend", "dsp"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
            )
            try:
                assert proc.stdin is not None and proc.stdout is not None
                proc.stdin.write(
                    json.dumps({"id": "prep", "method": "prepare", "params": {"audioPath": str(wav_path)}}) + "\n"
                )
                proc.stdin.flush()
                prep_msg = json.loads(proc.stdout.readline())
                self.assertTrue(prep_msg["ok"])

                # Launch 2 heavy HPSS percussive renders on a 25 s synthetic track to occupy both audition_pool workers!
                long_wav = Path(folder) / "long_hpss.wav"
                write_wav(long_wav, click_train(np.arange(0.5, 24.5, 0.5), 25.0, rate=RATE), rate=RATE)
                proc.stdin.write(
                    json.dumps({"id": "prep_long", "method": "prepare", "params": {"audioPath": str(long_wav)}}) + "\n"
                )
                proc.stdin.flush()
                self.assertTrue(json.loads(proc.stdout.readline())["ok"])

                for idx in (1, 2):
                    proc.stdin.write(
                        json.dumps(
                            {
                                "id": f"aud_{idx}",
                                "method": "render_audition",
                                "params": {
                                    "audioPath": str(long_wav),
                                    "startSec": 0.0,
                                    "endSec": 25.0,
                                    "filter": "percussive",
                                    "outputPath": str(Path(folder) / f"out_{idx}.wav"),
                                },
                            }
                        )
                        + "\n"
                    )
                proc.stdin.flush()
                time.sleep(0.03)

                snap_t0 = time.perf_counter()
                proc.stdin.write(
                    json.dumps(
                        {
                            "id": "snap_fast",
                            "method": "suggest_snaps",
                            "params": {"audioPath": str(wav_path), "timeSec": 1.01, "windowSec": 0.12},
                        }
                    )
                    + "\n"
                )
                proc.stdin.flush()

                # Read responses until snap_fast arrives — must arrive BEFORE slow 25s HPSS renders finish!
                received_ids: list[str] = []
                snap_wall_ms = 0.0
                for _ in range(3):
                    msg = json.loads(proc.stdout.readline())
                    received_ids.append(msg["id"])
                    if msg["id"] == "snap_fast":
                        snap_wall_ms = (time.perf_counter() - snap_t0) * 1000.0
                        self.assertTrue(msg["ok"], msg)
                        break

                self.assertEqual(received_ids[0], "snap_fast", received_ids)
                self.assertLess(snap_wall_ms, 120.0, snap_wall_ms)
            finally:
                for stream in (proc.stdin, proc.stdout, proc.stderr):
                    if stream is not None:
                        try:
                            stream.close()
                        except OSError:
                            pass
                proc.terminate()
                proc.wait(timeout=5)

    def test_hypothesis_local_scopes_preserve_unsolved_short_segment_beats_and_split_subsegment_free(self):
        # 20 s track: steady 0.5 s clicks in [0.5, 4.0) and [5.0, 19.5), plus faster rubato clicks in [4.0, 5.0)!
        steady_pre = np.arange(0.5, 4.0, 0.5)
        rubato_free = np.array([4.02, 4.33, 4.66])
        steady_post = np.arange(5.0, 19.6, 0.5)
        sig = click_train(np.concatenate([steady_pre, rubato_free, steady_post]), 20.0, rate=RATE)

        with tempfile.TemporaryDirectory() as folder:
            wav_path = Path(folder) / "sub_free.wav"
            write_wav(wav_path, sig, rate=RATE)
            engine = daemon.TempoEngine(backend="dsp")

            # Include a short 0.25 s intro segment [0, 0.25) with a user beat at 0.12 s that cannot be DP-solved,
            # followed by a 19.75 s Auto segment [0.25, 20.0) containing a 1 s Free span [4.0, 5.0)!
            old_beats = [{"id": "b_user_intro", "timeSec": 0.12, "source": "user", "revision": 1}]
            for idx, bt in enumerate(np.arange(0.56, 19.6, 0.5)):
                old_beats.append({"id": f"b_old_{idx}", "timeSec": round(float(bt), 6), "source": "draft", "revision": 1})

            revs = {b["id"]: f"1:ev_{b['id']}" for b in old_beats}
            revs["seg_short"] = "1:ev_s0"
            revs["seg_auto"] = "1:ev_s1"

            res = engine.recompute(
                {
                    "audioPath": str(wav_path),
                    "scope": "song",
                    "reason": "Test sub-segment Free and short segment safety",
                    "generation": 1,
                    "basisSeq": 2,
                    "state": {
                        "segments": [
                            {"id": "seg_short", "t0": 0.0, "t1": 0.25, "regime": "auto", "kept": False, "source": "user", "revision": 1},
                            {"id": "seg_auto", "t0": 0.25, "t1": 20.0, "regime": "auto", "kept": False, "source": "user", "revision": 1},
                        ],
                        "beats": old_beats,
                        "entityRevisions": revs,
                    },
                    "constraints": {
                        "beatGuides": [
                            {"beatId": "g_rub1", "timeSec": 4.02, "toleranceSec": 0.015},
                            {"beatId": "g_rub2", "timeSec": 4.33, "toleranceSec": 0.015},
                            {"beatId": "g_rub3", "timeSec": 4.66, "toleranceSec": 0.015},
                        ],
                        "unbeatRepulsions": [],
                        "soundObservations": [],
                        "freeIntervals": [{"segmentId": "seg_auto", "spanId": "sp_free_1", "t0": 4.0, "t1": 5.0}],
                        "keepLocks": [],
                    },
                }
            )

            splits = daemon._split_by_free_intervals("seg_auto", 0.25, 20.0, "auto", [(4.0, 5.0)])
            self.assertEqual(
                splits,
                [
                    {"segmentId": "seg_auto", "t0": 0.25, "t1": 4.0, "isFree": False},
                    {"segmentId": "seg_auto", "t0": 4.0, "t1": 5.0, "isFree": True},
                    {"segmentId": "seg_auto", "t0": 5.0, "t1": 20.0, "isFree": False},
                ],
            )

            offers = res["offers"]
            self.assertGreaterEqual(len(offers), 1, res)
            for off in offers:
                # Short unsolved segment [0, 0.25) MUST NOT appear in writeScopes or expectedScopeBeatIds,
                # and b_user_intro MUST NOT be deleted!
                for ws in off["writeScopes"]:
                    self.assertNotEqual(ws["segmentId"], "seg_short", off)
                    self.assertGreaterEqual(ws["t0"], 0.25, off)
                self.assertNotIn("b_user_intro", off.get("expectedScopeBeatIds", []))
                self.assertNotIn("b_user_intro", off["ops"].get("removeBeatIds", []))

            # Inside [4.0, 5.0), Free smoothness tracks the 0.31-0.33 s rubato pulses!
            prim_times = sorted(b["timeSec"] for b in offers[0]["ops"].get("upsertBeats", []))
            for target in (4.02, 4.33, 4.66):
                self.assertLess(min(abs(t - target) for t in prim_times), 0.025, (target, prim_times))

    def test_exact_sample_audition_slice_boundaries(self):
        with tempfile.TemporaryDirectory() as folder:
            wav_path = Path(folder) / "exact.wav"
            total_frames = RATE * 4
            sig = np.sin(2.0 * np.pi * 440.0 * np.arange(total_frames) / RATE)
            write_wav(wav_path, sig, rate=RATE)

            engine = daemon.TempoEngine(backend="dsp")
            out_wav = Path(folder) / "slice.wav"
            t0 = 1.1234567
            t1 = 2.6543219
            rendered = engine.render_span_wav(wav_path, t0, t1, "mix", out_wav)

            expected_start = int(round(t0 * RATE))
            expected_end = int(round(t1 * RATE))
            self.assertEqual(rendered["startSample"], expected_start)
            self.assertEqual(rendered["endSample"], expected_end)
            self.assertEqual(rendered["sampleRate"], RATE)

            with wave.open(str(out_wav), "rb") as wf:
                self.assertEqual(wf.getframerate(), RATE)
                self.assertEqual(wf.getnframes(), expected_end - expected_start)

    def test_track_cache_keys_on_audio_sha256_and_stat_inode_fallback(self):
        import hashlib
        import os

        with tempfile.TemporaryDirectory() as folder:
            wav_path = Path(folder) / "cache_key.wav"
            sig_v1 = click_train(np.array([0.5, 1.0, 1.5, 2.0]), 3.0, rate=RATE)
            sig_v2 = click_train(np.array([0.33, 0.99, 1.65, 2.31]), 3.0, rate=RATE)

            write_wav(wav_path, sig_v1, rate=RATE)
            raw_v1 = wav_path.read_bytes()
            sha_v1 = hashlib.sha256(raw_v1).hexdigest()
            st_v1 = wav_path.stat()

            server = daemon.DaemonServer(engine=daemon.TempoEngine(backend="dsp"))
            try:
                prep1 = server.dispatch_sync(
                    "prepare", {"audioPath": str(wav_path), "audioSha256": sha_v1}
                )
                self.assertEqual(prep1["sampleRate"], RATE)
                an1 = server.dispatch_sync(
                    "analyze", {"audioPath": str(wav_path), "audioSha256": sha_v1}
                )
                snaps1 = server.dispatch_sync(
                    "suggest_snaps",
                    {"audioPath": str(wav_path), "audioSha256": sha_v1, "timeSec": 0.5, "windowSec": 0.1},
                )
                self.assertTrue(len(snaps1["candidates"]) >= 1)

                # Overwrite IN-PLACE with identical byte count AND restore exact (atime_ns, mtime_ns)!
                with open(wav_path, "r+b") as fh:
                    tmp_v2 = Path(folder) / "tmp_v2.wav"
                    write_wav(tmp_v2, sig_v2, rate=RATE)
                    raw_v2 = tmp_v2.read_bytes()
                    tmp_v2.unlink()
                    self.assertEqual(len(raw_v1), len(raw_v2))
                    fh.seek(0)
                    fh.write(raw_v2)
                    fh.flush()
                os.utime(wav_path, ns=(st_v1.st_atime_ns, st_v1.st_mtime_ns))
                sha_v2 = hashlib.sha256(raw_v2).hexdigest()
                self.assertNotEqual(sha_v1, sha_v2)

                # With audioSha256=sha_v2, TrackCache MUST miss sha_v1 and decode v2 PCM!
                snaps_near_v2 = server.dispatch_sync(
                    "suggest_snaps",
                    {"audioPath": str(wav_path), "audioSha256": sha_v2, "timeSec": 0.33, "windowSec": 0.05},
                )
                self.assertTrue(
                    any(abs(c["targetSec"] - 0.33) < 0.03 for c in snaps_near_v2["candidates"]),
                    snaps_near_v2,
                )
                an2 = server.dispatch_sync(
                    "analyze", {"audioPath": str(wav_path), "audioSha256": sha_v2}
                )
                self.assertNotEqual(
                    [b["timeSec"] for b in an1["beats"]],
                    [b["timeSec"] for b in an2["beats"]],
                )

                # Also test fallback key (when audioSha256 is omitted) includes st_ctime_ns & st_ino:
                plain_path = Path(folder) / "plain_stat.wav"
                write_wav(plain_path, sig_v1, rate=RATE)
                st_plain = plain_path.stat()
                entry_a = server.engine.cache.get_or_load(plain_path)

                repl_tmp = Path(folder) / "plain_repl.wav"
                write_wav(repl_tmp, sig_v2, rate=RATE)
                os.utime(repl_tmp, ns=(st_plain.st_atime_ns, st_plain.st_mtime_ns))
                os.replace(repl_tmp, plain_path)
                entry_b = server.engine.cache.get_or_load(plain_path)
                self.assertIsNot(entry_a, entry_b)
                self.assertFalse(np.array_equal(entry_a.pcm, entry_b.pcm))
            finally:
                server.close()

    def test_render_audition_in_memory_without_output_path_writes_zero_files(self):
        import base64
        import io

        with tempfile.TemporaryDirectory() as folder:
            wav_path = Path(folder) / "in_mem.wav"
            t = np.arange(RATE * 3) / RATE
            stereo = np.column_stack(
                [
                    0.2 * np.sin(2.0 * np.pi * 440.0 * t) + click_train([0.5, 1.0, 1.5], 3.0),
                    0.2 * np.sin(2.0 * np.pi * 660.0 * t) + click_train([0.75, 1.25], 3.0),
                ]
            )
            write_wav(wav_path, stereo, rate=RATE)
            before_files = sorted(p.name for p in Path(folder).iterdir())

            server = daemon.DaemonServer(engine=daemon.TempoEngine(backend="dsp"))
            try:
                res = server.dispatch_sync(
                    "render_audition",
                    {
                        "audioPath": str(wav_path),
                        "startSec": 0.25,
                        "endSec": 1.25,
                        "filter": "percussive",
                    },
                )
                self.assertNotIn("outputPath", res)
                self.assertIn("wavBase64", res)
                expected_start = int(round(0.25 * RATE))
                expected_end = int(round(1.25 * RATE))
                self.assertEqual(res["startSample"], expected_start)
                self.assertEqual(res["endSample"], expected_end)
                self.assertEqual(res["sampleRate"], RATE)
                self.assertEqual(res["channels"], 2)

                wav_bytes = base64.b64decode(res["wavBase64"])
                with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
                    self.assertEqual(wf.getframerate(), RATE)
                    self.assertEqual(wf.getnchannels(), 2)
                    self.assertEqual(wf.getnframes(), expected_end - expected_start)

                after_files = sorted(p.name for p in Path(folder).iterdir())
                self.assertEqual(after_files, before_files)
            finally:
                server.close()


if __name__ == "__main__":
    unittest.main()
