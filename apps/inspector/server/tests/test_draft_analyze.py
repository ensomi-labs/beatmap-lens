"""Draft helper: raw beat picking, onset-flux sounds and audition views on synthetic audio."""
from pathlib import Path
import tempfile
import unittest
import wave

import numpy as np

import draft_analyze as draft

RATE = 44100


def click_train(times_s, duration_s, amplitudes=None, rate=RATE):
    signal = np.zeros(int(duration_s * rate))
    burst = np.exp(-np.arange(int(0.03 * rate)) / (0.004 * rate))
    noise = np.random.default_rng(0).standard_normal(burst.size)
    for index, t in enumerate(times_s):
        start = int(round(t * rate))
        gain = 1.0 if amplitudes is None else amplitudes[index]
        end = min(signal.size, start + burst.size)
        signal[start:end] += 0.6 * gain * (burst * noise)[: end - start]
    return signal


def write_mono(path, signal, rate=RATE):
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes((np.clip(signal, -1, 1) * 32767).astype("<i2").tobytes())


class PickBeatsTest(unittest.TestCase):
    def test_peaks_keep_their_own_tempo_and_sub_frame_position(self):
        # 240 BPM: a raw pick keeps it; nothing folds it into a reading range.
        frames = np.arange(500)
        times = np.arange(0.11, 9.9, 0.25)
        logits = -6 + np.zeros(frames.size)
        for t in times:
            logits = np.maximum(logits, 4 - ((frames / 50.0 - t) * 50.0) ** 2 * 2)
        beats = draft.pick_beats(logits)
        self.assertEqual(len(beats), len(times))
        self.assertTrue(np.allclose([b["t"] for b in beats], times, atol=0.004))
        self.assertAlmostEqual(float(np.median(np.diff([b["t"] for b in beats]))), 0.25, places=3)
        self.assertTrue(all(0.5 < b["conf"] <= 1.0 for b in beats))

    def test_negative_logits_give_no_beats(self):
        self.assertEqual(draft.pick_beats(np.full(100, -1.0)), [])


class OnsetFluxTest(unittest.TestCase):
    def test_finds_clicks_globally_with_emphasis(self):
        times = [0.5, 0.9, 1.37, 2.0, 2.61, 3.2]
        amplitudes = [1.0, 0.3, 1.0, 0.3, 1.0, 0.3]
        sounds = draft.onset_flux_sounds(click_train(times, 4.0, amplitudes), RATE)
        found = [s["t"] for s in sounds]
        self.assertEqual(len(found), len(times))
        self.assertTrue(np.allclose(found, times, atol=0.015), found)
        loud = [s["emphasis"] for s, a in zip(sounds, amplitudes) if a == 1.0]
        soft = [s["emphasis"] for s, a in zip(sounds, amplitudes) if a < 1.0]
        self.assertGreater(min(loud), max(soft))
        self.assertTrue(all(0.0 <= s["emphasis"] <= 1.0 for s in sounds))

    def test_rule_pulse_follows_the_click_period(self):
        times = np.arange(0.2, 9.8, 0.5)
        beats = draft.rule_beats(click_train(times, 10.0), RATE, 10.0)
        self.assertAlmostEqual(float(np.median(np.diff([b["t"] for b in beats]))), 0.5, places=2)


class AuditionViewTest(unittest.TestCase):
    def test_bands_split_low_and_high(self):
        t = np.arange(RATE) / RATE
        low, high = np.sin(2 * np.pi * 100 * t), np.sin(2 * np.pi * 5000 * t)
        mix = (0.4 * (low + high))[:, None]
        energy = lambda x, ref: float(np.dot(x[:, 0], ref) ** 2)  # noqa: E731
        low_view = draft.audition_view(mix, RATE, "low")
        high_view = draft.audition_view(mix, RATE, "high")
        self.assertGreater(energy(low_view, low), 100 * energy(low_view, high))
        self.assertGreater(energy(high_view, high), 100 * energy(high_view, low))
        self.assertEqual(low_view.shape, mix.shape)

    def test_hpss_separates_clicks_from_a_tone_without_moving_them(self):
        t = np.arange(2 * RATE) / RATE
        tone = 0.2 * np.sin(2 * np.pi * 440 * t)
        clicks = click_train([0.5, 1.0, 1.5], 2.0)
        mix = (tone + clicks)[:, None]
        percussive = draft.audition_view(mix, RATE, "percussive")[:, 0]
        harmonic = draft.audition_view(mix, RATE, "harmonic")[:, 0]
        self.assertEqual(percussive.size, mix.shape[0])
        click_zone = np.abs(clicks) > 0.01
        self.assertGreater(
            np.abs(percussive[click_zone]).mean() / np.abs(percussive[~click_zone]).mean(),
            np.abs(harmonic[click_zone]).mean() / np.abs(harmonic[~click_zone]).mean(),
        )
        peak = int(np.argmax(np.abs(percussive[int(0.9 * RATE) : int(1.1 * RATE)]))) + int(0.9 * RATE)
        self.assertLess(abs(peak / RATE - 1.0), 0.006)

    @unittest.skipUnless(draft.shutil.which("ffmpeg"), "ffmpeg is not on PATH")
    def test_render_writes_the_span_at_the_source_rate(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "clicks.wav"
            write_mono(source, click_train([0.5, 1.0, 1.5, 2.0], 3.0))
            result = draft.render_audition(source, 0.75, 1.75, "percussive", Path(folder) / "p.wav")
            with wave.open(result["outputPath"]) as handle:
                self.assertEqual(handle.getframerate(), RATE)
                self.assertEqual(handle.getnframes(), RATE)
            analysis = draft.analyze(source, use_beatthis=False)
            self.assertEqual(analysis["beats"]["provider"]["kind"], "rule")
            self.assertTrue(analysis["sounds"]["provider"]["experimental"])
            self.assertEqual(len(analysis["sounds"]["items"]), 4)


if __name__ == "__main__":
    unittest.main()
