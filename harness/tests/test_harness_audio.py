"""Deterministic unit tests for harness_audio and audio-harness CLI using synthetic WAV fixtures."""
from array import array
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import wave

HARNESS_DIR = Path(__file__).resolve().parents[1]
if str(HARNESS_DIR) not in sys.path:
    sys.path.insert(0, str(HARNESS_DIR))

import harness_audio as ha


def _write_synth_wav(path, duration_s, freqs_amps, sample_rate=44100, channels=1):
    n_frames = int(round(duration_s * sample_rate))
    samples = array("h", [0]) * (n_frames * channels)
    for i in range(n_frames):
        t = i / sample_rate
        val = sum(amp * math.sin(2.0 * math.pi * freq * t) for freq, amp in freqs_amps)
        ival = max(-32767, min(32767, int(round(val * 32767.0))))
        for c in range(channels):
            samples[i * channels + c] = ival
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(samples.tobytes())


def _goertzel_magnitude(samples, target_hz, sample_rate):
    k = int(round(0.5 + (len(samples) * target_hz) / sample_rate))
    omega = (2.0 * math.pi * k) / len(samples)
    coeff = 2.0 * math.cos(omega)
    s_prev = 0.0
    s_prev2 = 0.0
    for x in samples:
        s = x + coeff * s_prev - s_prev2
        s_prev2 = s_prev
        s_prev = s
    power = s_prev2 * s_prev2 + s_prev * s_prev - coeff * s_prev * s_prev2
    return math.sqrt(max(0.0, power)) / len(samples)


def _find_click_onsets_s(samples, sample_rate, threshold=5000, refractory_s=0.1):
    onsets = []
    min_gap = int(round(refractory_s * sample_rate))
    i = 0
    n = len(samples)
    while i < n:
        if abs(samples[i]) >= threshold:
            onsets.append(i / sample_rate)
            i += min_gap
        else:
            i += 1
    return onsets


class HarnessAudioTest(unittest.TestCase):
    def test_probe_audio(self):
        with tempfile.TemporaryDirectory() as tmp:
            wav_path = Path(tmp) / "tone.wav"
            _write_synth_wav(wav_path, duration_s=2.0, freqs_amps=[(440.0, 0.4)], channels=2)
            info = ha.probe_audio(wav_path)
            self.assertAlmostEqual(info["durationS"], 2.0, delta=0.01)
            self.assertEqual(info["sampleRate"], 44100)
            self.assertEqual(info["channels"], 2)
            self.assertEqual(info["codec"], "pcm_s16le")

    def test_extract_audio_slice_span_rate_and_m4a(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            src = tmp_dir / "src.wav"
            _write_synth_wav(src, duration_s=4.0, freqs_amps=[(440.0, 0.3)])

            out_slow = tmp_dir / "slow.wav"
            meta = ha.extract_audio_slice(src, out_slow, start_s=1.0, end_s=2.5, rate=0.75)
            self.assertAlmostEqual(meta["outputDurationS"], 2.0, delta=0.05)
            self.assertEqual(meta["filters"], ["atempo=0.750000"])
            self.assertEqual(meta["timeMapping"]["sourceOriginS"], 1.0)

            out_chain = tmp_dir / "chain.wav"
            meta_chain = ha.extract_audio_slice(src, out_chain, start_s=0.0, end_s=1.0, rate=0.25)
            self.assertEqual(meta_chain["filters"], ["atempo=0.5", "atempo=0.500000"])
            self.assertAlmostEqual(meta_chain["outputDurationS"], 4.0, delta=0.1)

            out_m4a = tmp_dir / "clip.m4a"
            meta_m4a = ha.extract_audio_slice(src, out_m4a, start_s=0.5, end_s=2.0, mono=True)
            probed = ha.probe_audio(out_m4a)
            self.assertEqual(probed["channels"], 1)
            self.assertAlmostEqual(meta_m4a["outputDurationS"], 1.5, delta=0.08)

    def test_extract_audio_slice_band_filters(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            src = tmp_dir / "dual.wav"
            _write_synth_wav(src, duration_s=1.0, freqs_amps=[(100.0, 0.35), (5000.0, 0.35)])

            low_wav = tmp_dir / "low.wav"
            high_wav = tmp_dir / "high.wav"
            ha.extract_audio_slice(src, low_wav, band="low")
            ha.extract_audio_slice(src, high_wav, band="high")

            low_samples, _, sr, _ = ha._read_pcm16_wav(low_wav)
            high_samples, _, _, _ = ha._read_pcm16_wav(high_wav)
            # Skip initial filter transient (first 0.1s).
            low_mid = low_samples[int(0.1 * sr):int(0.9 * sr)]
            high_mid = high_samples[int(0.1 * sr):int(0.9 * sr)]

            self.assertGreater(_goertzel_magnitude(low_mid, 100.0, sr), 5.0 * _goertzel_magnitude(low_mid, 5000.0, sr))
            self.assertGreater(_goertzel_magnitude(high_mid, 5000.0, sr), 5.0 * _goertzel_magnitude(high_mid, 100.0, sr))

    def test_parse_timing_osu_red_lines_meter_and_resets(self):
        osu_text = "\n".join([
            "osu file format v14",
            "[TimingPoints]",
            "// 120 BPM in 3/4 from 0 ms",
            "0,500,3,2,1,60,1,0",
            "// inherited green line must be ignored",
            "500,-100,3,2,1,60,0,0",
            "// tempo & meter change at 1300 ms (before beat 4), resetting bar",
            "1300,250,4,2,1,60,1,0",
            "[HitObjects]",
            "64,192,0,1,0,0:0:0:0:",
        ])
        with tempfile.TemporaryDirectory() as tmp:
            osu_path = Path(tmp) / "chart.osu"
            osu_path.write_text(osu_text, encoding="utf-8")
            events = ha.parse_timing_events(osu_path, end_s=2.4)
            times = [round(ev["timeS"], 3) for ev in events]
            downbeats = [round(ev["timeS"], 3) for ev in events if ev["isDownbeat"]]
            self.assertEqual(times, [0.0, 0.5, 1.0, 1.3, 1.55, 1.8, 2.05, 2.3])
            self.assertEqual(downbeats, [0.0, 1.3, 2.3])

    def test_parse_timing_json_schemas(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)

            p1 = tmp_dir / "lists.json"
            p1.write_text(json.dumps({"beats": [0.5, 1.0, 1.5, 2.0], "downbeats": [0.5, 2.0]}), encoding="utf-8")
            e1 = ha.parse_timing_events(p1, end_s=3.0)
            self.assertEqual([ev["timeS"] for ev in e1], [0.5, 1.0, 1.5, 2.0])
            self.assertEqual([ev["isDownbeat"] for ev in e1], [True, False, False, True])

            p2 = tmp_dir / "events.json"
            p2.write_text(json.dumps([
                {"time_ms": 500, "beat_in_bar": 1},
                {"time_ms": 1000, "beat_in_bar": 2},
            ]), encoding="utf-8")
            e2 = ha.parse_timing_events(p2, end_s=2.0)
            self.assertEqual([(ev["timeS"], ev["isDownbeat"]) for ev in e2], [(0.5, True), (1.0, False)])

            p3 = tmp_dir / "segments.json"
            p3.write_text(json.dumps({"segments": [{"start_s": 0.25, "bpm": 120.0, "meter": 2}]}), encoding="utf-8")
            e3 = ha.parse_timing_events(p3, end_s=1.5)
            self.assertEqual([(ev["timeS"], ev["isDownbeat"]) for ev in e3], [
                (0.25, True), (0.75, False), (1.25, True),
            ])

    def test_render_click_audition_sample_accuracy_rate_and_offset(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            src = tmp_dir / "silence.wav"
            _write_synth_wav(src, duration_s=3.0, freqs_amps=[])
            timing = tmp_dir / "beats.json"
            timing.write_text(json.dumps({"beats": [0.5, 1.0, 1.5, 2.0], "downbeats": [0.5, 1.5]}), encoding="utf-8")

            # Rate 1.0 over [0.25, 2.25) -> expected elapsed clicks at 0.25, 0.75, 1.25, 1.75
            out1 = tmp_dir / "clicks1.wav"
            m1 = ha.render_click_audition(src, timing, out1, start_s=0.25, end_s=2.25, layout="clicks_only")
            self.assertEqual(m1["beatCount"], 4)
            self.assertEqual(m1["downbeatCount"], 2)
            s1, ch, sr, _ = ha._read_pcm16_wav(out1)
            self.assertEqual(ch, 1)
            onsets1 = _find_click_onsets_s(s1, sr)
            expected1 = [0.25, 0.75, 1.25, 1.75]
            self.assertEqual(len(onsets1), len(expected1))
            for got, exp in zip(onsets1, expected1):
                self.assertLessEqual(abs(got - exp), 0.001)

            # Downbeat peak amplitude must exceed regular beat peak amplitude.
            win = int(0.025 * sr)
            db_peak = max(abs(x) for x in s1[int(0.25 * sr):int(0.25 * sr) + win])
            beat_peak = max(abs(x) for x in s1[int(0.75 * sr):int(0.75 * sr) + win])
            self.assertGreater(db_peak, beat_peak * 1.25)

            # Rate 0.75 + offset +50ms over [0.25, 2.25) -> source shifted 0.55, 1.05, 1.55, 2.05
            out2 = tmp_dir / "clicks2.wav"
            ha.render_click_audition(
                src, timing, out2, start_s=0.25, end_s=2.25, rate=0.75, offset_ms=50.0, layout="clicks_only"
            )
            s2, _, sr2, _ = ha._read_pcm16_wav(out2)
            onsets2 = _find_click_onsets_s(s2, sr2)
            expected2 = [(t + 0.05 - 0.25) / 0.75 for t in [0.5, 1.0, 1.5, 2.0]]
            self.assertEqual(len(onsets2), len(expected2))
            for got, exp in zip(onsets2, expected2):
                self.assertLessEqual(abs(got - exp), 0.001)

    def test_render_click_audition_split_channel_isolation(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            src = tmp_dir / "tone.wav"
            _write_synth_wav(src, duration_s=1.0, freqs_amps=[(220.0, 0.3)])
            timing = tmp_dir / "empty.json"
            timing.write_text(json.dumps({"beats": []}), encoding="utf-8")

            out_split = tmp_dir / "split_music_only.wav"
            ha.render_click_audition(src, timing, out_split, layout="split")
            samples, ch, _, _ = ha._read_pcm16_wav(out_split)
            self.assertEqual(ch, 2)
            left = samples[0::2]
            right = samples[1::2]
            self.assertGreater(max(abs(x) for x in left), 3000)
            self.assertEqual(max(abs(x) for x in right), 0)

            silent = tmp_dir / "silent.wav"
            _write_synth_wav(silent, duration_s=1.0, freqs_amps=[])
            timing2 = tmp_dir / "one.json"
            timing2.write_text(json.dumps({"beats": [0.5], "downbeats": [0.5]}), encoding="utf-8")
            out_split2 = tmp_dir / "split_click_only.wav"
            ha.render_click_audition(silent, timing2, out_split2, layout="split")
            samples2, ch2, _, _ = ha._read_pcm16_wav(out_split2)
            self.assertEqual(ch2, 2)
            self.assertEqual(max(abs(x) for x in samples2[0::2]), 0)
            self.assertGreater(max(abs(x) for x in samples2[1::2]), 15000)

    def test_cli_smoke_probe_slice_and_audition_m4a(self):
        cli = str(HARNESS_DIR / "audio-harness.py")
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            src = tmp_dir / "src.wav"
            _write_synth_wav(src, duration_s=2.0, freqs_amps=[(330.0, 0.25)], channels=2)
            timing = tmp_dir / "t.json"
            timing.write_text(json.dumps({"segments": [{"start_s": 0.0, "bpm": 120.0, "meter": 4}]}), encoding="utf-8")

            p1 = subprocess.run([sys.executable, cli, "probe", str(src)], capture_output=True, text=True, check=True)
            self.assertAlmostEqual(json.loads(p1.stdout)["durationS"], 2.0, delta=0.01)

            sliced = tmp_dir / "sliced.m4a"
            p2 = subprocess.run(
                [sys.executable, cli, "slice", str(src), "--out", str(sliced), "--start", "0.2", "--end", "1.2"],
                capture_output=True, text=True, check=True,
            )
            self.assertAlmostEqual(json.loads(p2.stdout)["outputDurationS"], 1.0, delta=0.08)

            aud = tmp_dir / "aud.m4a"
            p3 = subprocess.run(
                [sys.executable, cli, "audition", str(src), "--timing", str(timing), "--out", str(aud),
                 "--start", "0.0", "--end", "2.0", "--layout", "mix"],
                capture_output=True, text=True, check=True,
            )
            aud_meta = json.loads(p3.stdout)
            self.assertEqual(aud_meta["beatCount"], 4)
            self.assertEqual(aud_meta["downbeatCount"], 1)
            self.assertEqual(ha.probe_audio(aud)["channels"], 2)


if __name__ == "__main__":
    unittest.main()
