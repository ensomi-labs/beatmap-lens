#!/usr/bin/env python3
"""Persistent warm audio/DSP daemon for the Inspector `/tempo` workspace.

Invariants preserved from verified DSP audits:
  1. Zero ``scipy`` imports (pure NumPy + optional PyTorch/BeatThis + wave/ffmpeg).
  2. Exact sample-rate hop timing: ``time_sec = (sample_offset + frame_idx * hop) / float(sr)``.
  3. Short-clip (< 21 frames) convolution/median guards and linear zero-padded FFT band filters.
  4. Stereo zero-phase HPSS and band audition views (``mix``, ``percussive``, ``harmonic``,
     ``low``, ``mid``, ``high``) preserving exact impulse alignment on the original mix clock.

Concurrency architecture:
  - Bounded LRU PCM track cache (``max_cached_tracks = 3``) keeping native float32 PCM and
    exact-decimated analysis mono in memory well under 1.5 GB RSS.
  - Dedicated CPU ``fast_pool`` for ``suggest_snaps`` (``micro_assist``), ``prepare``,
    ``render_audition``, and ``export_clip`` so an in-flight ``analyze`` or ``recompute`` on
    ``heavy_pool`` / MPS never blocks sub-40 ms snap suggestions.
  - Cooperative ``cancel`` requests by ``requestId`` over NDJSON stdio.
"""

from __future__ import annotations

import argparse
import base64
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
import io
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time
import uuid
import wave

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

AUDITION_FILTERS = ("mix", "percussive", "harmonic", "low", "mid", "high")
SNAP_ROLES = ("transient_attack", "p_center", "harmonic_change", "release")
SNAP_FAMILIES = (
    "percussion",
    "piano_keys",
    "strings_winds",
    "vocal",
    "bass_synth",
    "other",
)

BEATTHIS_FPS = 50.0
FLUX_HOP_S = 0.01
SNAP_HOP_S = 0.0025
FLUX_MELS = 64
LOW_HZ = 250.0
HIGH_HZ = 2500.0
AUDITION_PAD_S = 0.5
BREAK_GAP_SEC = 2.5
MAX_CACHED_TRACKS = 3
MAX_AUDITION_WINDOW_CACHE = 2

# Symmetric 15-tap Hann-windowed sinc half-band FIR for exact 2:1 anti-aliased decimation.
_FIR_IDX = np.arange(-7, 8, dtype=np.float64)
_HALF_BAND_FIR = np.sinc(0.47 * _FIR_IDX) * np.hanning(15)
_HALF_BAND_FIR /= _HALF_BAND_FIR.sum()


class CancelledError(RuntimeError):
    """Raised when a cooperative cancel event aborts an in-flight daemon request."""


def _check_cancel(cancel_event: threading.Event | None) -> None:
    if cancel_event is not None and cancel_event.is_set():
        raise CancelledError("Operation cancelled")


def _tool(name: str) -> str:
    found = shutil.which(name)
    if not found:
        raise FileNotFoundError(f"Required system binary not found on PATH: {name}")
    return found


def _try_wave_probe(path: Path) -> dict | None:
    if path.suffix.lower() != ".wav":
        return None
    try:
        with wave.open(str(path), "rb") as handle:
            if handle.getcomptype() != "NONE" or handle.getsampwidth() not in (2, 4):
                return None
            frames = int(handle.getnframes())
            sr = int(handle.getframerate())
            channels = int(handle.getnchannels())
            if sr <= 0 or channels <= 0:
                return None
            return {
                "path": str(path.resolve()),
                "durationS": frames / float(sr),
                "sampleRate": sr,
                "channels": channels,
                "codec": f"pcm_s{handle.getsampwidth() * 8}le",
                "frames": frames,
                "waveDirect": True,
            }
    except (wave.Error, EOFError, OSError):
        return None


def probe(path: str | Path) -> dict:
    """Read container metadata of the first audio stream."""
    resolved = Path(path).resolve()
    direct = _try_wave_probe(resolved)
    if direct is not None:
        return direct
    result = subprocess.run(
        [
            _tool("ffprobe"),
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=codec_name,sample_rate,channels:format=duration",
            "-of",
            "json",
            str(resolved),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    payload = json.loads(result.stdout)
    stream = payload["streams"][0]
    return {
        "path": str(resolved),
        "durationS": float(payload["format"]["duration"]),
        "sampleRate": int(stream["sample_rate"]),
        "channels": int(stream["channels"]),
        "codec": stream["codec_name"],
        "waveDirect": False,
    }


def decode(
    path: str | Path,
    channels: int,
    start_s: float | None = None,
    duration_s: float | None = None,
) -> np.ndarray:
    """Decode float32 frames [N, channels] at the source file's own sample rate."""
    resolved = Path(path).resolve()
    if resolved.suffix.lower() == ".wav":
        try:
            with wave.open(str(resolved), "rb") as handle:
                sampwidth = handle.getsampwidth()
                if handle.getcomptype() == "NONE" and sampwidth in (2, 4):
                    sr = handle.getframerate()
                    total = handle.getnframes()
                    ch = handle.getnchannels()
                    first = 0 if start_s is None else min(total, max(0, int(round(start_s * sr))))
                    count = (
                        total - first
                        if duration_s is None
                        else min(total - first, max(0, int(round(duration_s * sr))))
                    )
                    handle.setpos(first)
                    raw = handle.readframes(count)
                    if sampwidth == 2:
                        arr = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
                    else:
                        arr = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
                    return arr.reshape(-1, ch)
        except (wave.Error, EOFError, OSError):
            pass

    command = [_tool("ffmpeg"), "-v", "error", "-nostdin"]
    if start_s is not None:
        command += ["-ss", f"{start_s:.6f}"]
    command += ["-i", str(resolved)]
    if duration_s is not None:
        command += ["-t", f"{duration_s:.6f}"]
    command += ["-map", "0:a:0", "-f", "f32le", "-acodec", "pcm_f32le", "-"]
    raw = subprocess.run(command, capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype="<f4").reshape(-1, channels).astype(np.float32)


def _decimate_analysis_mono(mono: np.ndarray, sample_rate: int) -> tuple[np.ndarray, int]:
    """Exact integer 2:1 anti-aliased decimation when sample_rate >= 44100 and even."""
    if sample_rate >= 44100 and sample_rate % 2 == 0 and mono.size >= 32:
        padded = np.pad(mono.astype(np.float64), 7, mode="edge")
        filtered = np.convolve(padded, _HALF_BAND_FIR, mode="valid")
        return filtered[::2].astype(np.float32), sample_rate // 2
    return mono.astype(np.float32, copy=False), sample_rate


def _flux_hop(sample_rate: int, hop_s: float = FLUX_HOP_S) -> tuple[int, float]:
    """Exact integer hop in samples and its exact duration in seconds."""
    hop_samples = max(1, int(round(sample_rate * hop_s)))
    return hop_samples, hop_samples / float(sample_rate)


def mel_filters(
    sample_rate: int,
    n_fft: int,
    n_mels: int = FLUX_MELS,
    fmin: float = 30.0,
    fmax: float | None = None,
) -> np.ndarray:
    fmax_val = fmax or sample_rate / 2.0
    to_mel = lambda hz: 2595.0 * np.log10(1.0 + hz / 700.0)  # noqa: E731
    to_hz = lambda mel: 700.0 * (10.0 ** (mel / 2595.0) - 1.0)  # noqa: E731
    edges = to_hz(np.linspace(to_mel(fmin), to_mel(fmax_val), n_mels + 2))
    bins = np.fft.rfftfreq(n_fft, 1.0 / sample_rate)
    lower, centre, upper = edges[:-2, None], edges[1:-1, None], edges[2:, None]
    rising = (bins[None, :] - lower) / np.maximum(centre - lower, 1e-9)
    falling = (upper - bins[None, :]) / np.maximum(upper - centre, 1e-9)
    return np.maximum(0.0, np.minimum(rising, falling))


def stft_power_and_mel(
    mono: np.ndarray,
    sample_rate: int,
    hop_s: float = FLUX_HOP_S,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, int, float]:
    """Compute STFT power, log-Mel spectrogram, rfft frequencies, hop_samples, and actual_hop_s."""
    hop, actual_hop_s = _flux_hop(sample_rate, hop_s)
    if mono.size == 0:
        empty = np.zeros((0, 2), dtype=np.float64)
        return empty, np.zeros((0, FLUX_MELS), dtype=np.float64), np.zeros(2), hop, actual_hop_s
    n_fft = max(4, 1 << int(round(math.log2(max(4.0, 0.023 * sample_rate)))))
    padded = np.pad(mono.astype(np.float64), n_fft // 2)
    count = 1 + max(0, (padded.size - n_fft) // hop)
    frames = sliding_window_view(padded, n_fft)[: count * hop : hop]
    power = np.abs(np.fft.rfft(frames * np.hanning(n_fft), axis=1)) ** 2
    freqs = np.fft.rfftfreq(n_fft, 1.0 / sample_rate)
    with np.errstate(all="ignore"):
        mel = np.log1p(1000.0 * (power @ mel_filters(sample_rate, n_fft).T))
    return power, mel, freqs, hop, actual_hop_s


def log_mel(mono: np.ndarray, sample_rate: int, hop_s: float = FLUX_HOP_S) -> np.ndarray:
    """Log-compressed Mel power with frames centred at k * (hop_samples / sample_rate)."""
    _, mel, _, _, _ = stft_power_and_mel(mono, sample_rate, hop_s)
    return mel


def onset_envelope(mono: np.ndarray, sample_rate: int, hop_s: float = FLUX_HOP_S) -> np.ndarray:
    mel = log_mel(mono, sample_rate, hop_s)
    if mel.shape[0] == 0:
        return np.zeros(0, dtype=np.float64)
    if mel.shape[0] == 1:
        return np.zeros(1, dtype=np.float64)
    flux = np.maximum(0.0, np.diff(mel, axis=0)).mean(axis=1)
    return np.concatenate(([0.0], flux))


def _parabolic_offset(values: np.ndarray, idx: int) -> float:
    if 0 < idx < values.size - 1:
        a, b, c = float(values[idx - 1]), float(values[idx]), float(values[idx + 1])
        curvature = a - 2.0 * b + c
        if curvature < -1e-12:
            return float(np.clip(0.5 * (a - c) / curvature, -0.5, 0.5))
    return 0.0


def _classify_band_profile(
    low_e: float,
    mid_e: float,
    high_e: float,
    crest: float,
    role: str,
) -> tuple[str, str]:
    """Map (low, mid, high, crest, role) to (SnapFamily, human-readable musical label)."""
    total = max(low_e + mid_e + high_e, 1e-12)
    low_share = low_e / total
    mid_share = mid_e / total
    high_share = high_e / total

    if role == "transient_attack":
        if low_share >= 0.50:
            return "bass_synth", "Bass attack"
        if high_share >= 0.28 or crest >= 3.2:
            return "percussion", "Percussion attack"
        if mid_share >= 0.45:
            return "piano_keys", "Piano attack"
        return "percussion", "Percussion attack"

    if role == "p_center":
        if low_share >= 0.48:
            return "bass_synth", "Bass entry"
        if mid_share >= 0.56 and high_share < 0.24:
            return "vocal", "Vocal swell"
        return "strings_winds", "String swell"

    if role == "harmonic_change":
        if low_share >= 0.50:
            return "bass_synth", "Bass note change"
        if mid_share >= 0.50:
            return "piano_keys", "Chord change"
        return "strings_winds", "Harmony shift"

    # release
    if low_share >= 0.50:
        return "bass_synth", "Bass release"
    if mid_share >= 0.55 and high_share < 0.24:
        return "vocal", "Vocal release"
    return "other", "Gate release"


def compute_track_features(mono: np.ndarray, sample_rate: int, duration_sec: float) -> dict:
    """Compute reusable 10 ms multi-band envelopes and initial SoundAnchors with exact hop timing."""
    power, mel, freqs, hop_samples, actual_hop_s = stft_power_and_mel(mono, sample_rate, FLUX_HOP_S)
    n_frames = mel.shape[0]
    if n_frames == 0:
        return {
            "hop_samples": hop_samples,
            "actual_hop_s": actual_hop_s,
            "onset_env": np.zeros(0, dtype=np.float64),
            "rms_env": np.zeros(0, dtype=np.float64),
            "low_env": np.zeros(0, dtype=np.float64),
            "mid_env": np.zeros(0, dtype=np.float64),
            "high_env": np.zeros(0, dtype=np.float64),
            "sounds": [],
        }

    if n_frames == 1:
        flux = np.zeros(1, dtype=np.float64)
    else:
        flux = np.concatenate(([0.0], np.maximum(0.0, np.diff(mel, axis=0)).mean(axis=1)))

    low_mask = freqs < LOW_HZ
    mid_mask = (freqs >= LOW_HZ) & (freqs <= HIGH_HZ)
    high_mask = freqs > HIGH_HZ

    low_env = np.sqrt(power[:, low_mask].sum(axis=1)) if np.any(low_mask) else np.zeros(n_frames)
    mid_env = np.sqrt(power[:, mid_mask].sum(axis=1)) if np.any(mid_mask) else np.zeros(n_frames)
    high_env = np.sqrt(power[:, high_mask].sum(axis=1)) if np.any(high_mask) else np.zeros(n_frames)
    rms_env = np.sqrt(power.sum(axis=1))

    scale = float(np.percentile(flux, 99)) if flux.size > 0 else 1.0
    if scale <= 1e-12:
        scale = float(flux.max()) or 1.0
    norm = flux / scale

    half_mean = 10
    kernel = np.ones(2 * half_mean + 1, dtype=np.float64) / (2 * half_mean + 1)
    local_mean = np.convolve(np.pad(norm, half_mean, mode="constant"), kernel, mode="valid")
    padded = np.pad(norm, 3, constant_values=-np.inf)
    local_max = sliding_window_view(padded, 7).max(axis=1)
    threshold = local_mean + 0.05
    peaks = np.flatnonzero((norm >= local_max) & (norm > threshold) & (norm > 0.1))
    if peaks.size:
        peaks = peaks[np.concatenate(([True], np.diff(peaks) > 3))]

    strength_scale = float(np.percentile(norm[peaks], 95)) if peaks.size else 1.0
    if strength_scale <= 1e-12:
        strength_scale = 1.0

    sounds: list[dict] = []
    max_t = max(0.0, duration_sec - 1e-5)
    for idx_pos, frame_i in enumerate(peaks):
        offset = _parabolic_offset(norm, int(frame_i))
        t_sec = float(np.clip((int(frame_i) + offset) * actual_hop_s, 0.0, max_t))
        strength = float(np.clip(norm[frame_i] / strength_scale, 0.05, 1.0))

        w0 = max(0, int(frame_i) - 1)
        w1 = min(n_frames, int(frame_i) + 3)
        low_e = float(low_env[w0:w1].mean())
        mid_e = float(mid_env[w0:w1].mean())
        high_e = float(high_env[w0:w1].mean())

        bg = float(local_mean[frame_i]) + 0.05
        crest = float(norm[frame_i] / max(bg, 1e-4))
        role = "transient_attack" if crest >= 2.1 else "p_center"
        sigma_ms = 4.0 if role == "transient_attack" else 12.0
        family, _ = _classify_band_profile(low_e, mid_e, high_e, crest, role)

        sounds.append(
            {
                "id": f"sound_{idx_pos}",
                "timeSec": round(t_sec, 6),
                "strength": round(strength, 4),
                "family": family,
                "role": role,
                "sigmaMs": sigma_ms,
                "source": "draft",
            }
        )

    return {
        "hop_samples": hop_samples,
        "actual_hop_s": actual_hop_s,
        "onset_env": norm,
        "rms_env": rms_env,
        "low_env": low_env,
        "mid_env": mid_env,
        "high_env": high_env,
        "sounds": sounds,
    }


def onset_flux_sounds(mono: np.ndarray, sample_rate: int, hop_s: float = FLUX_HOP_S) -> list[dict]:
    """Global onset-flux peaks with exact hop/sr timestamps."""
    duration_sec = mono.size / float(sample_rate) if sample_rate > 0 else 0.0
    if hop_s == FLUX_HOP_S:
        feats = compute_track_features(mono, sample_rate, duration_sec)
        return feats["sounds"]
    _, actual_hop_s = _flux_hop(sample_rate, hop_s)
    flux = onset_envelope(mono, sample_rate, hop_s)
    if flux.size == 0:
        return []
    scale = float(np.percentile(flux, 99)) or 1.0
    norm = flux / scale
    half_mean = 10
    kernel = np.ones(2 * half_mean + 1, dtype=np.float64) / (2 * half_mean + 1)
    local = np.convolve(np.pad(norm, half_mean, mode="constant"), kernel, mode="valid")
    padded = np.pad(norm, 3, constant_values=-np.inf)
    local_max = sliding_window_view(padded, 7).max(axis=1)
    threshold = local + 0.05
    index = np.flatnonzero((norm >= local_max) & (norm > threshold) & (norm > 0.1))
    if index.size:
        index = index[np.concatenate(([True], np.diff(index) > 3))]
    emphasis_scale = float(np.percentile(norm[index], 95)) if index.size else 1.0
    if emphasis_scale <= 1e-12:
        emphasis_scale = 1.0
    out = []
    for pos, i in enumerate(index):
        offset = _parabolic_offset(norm, int(i))
        out.append(
            {
                "id": f"sound_{pos}",
                "timeSec": round((int(i) + offset) * actual_hop_s, 6),
                "strength": round(float(min(1.0, norm[i] / emphasis_scale)), 4),
                "family": "percussion",
                "role": "transient_attack",
                "sigmaMs": 4.0,
                "source": "draft",
            }
        )
    return out


# ---------------------------------------------------------------- BeatThis & DSP Pulse Tracking


def pick_beats(
    beat_logits: np.ndarray,
    fps: float = BEATTHIS_FPS,
    half_window: int = 3,
    duration_sec: float | None = None,
) -> list[dict]:
    """Raw un-folded BeatThis peak-picking at frame / fps with parabolic sub-frame refinement."""
    logits = np.asarray(beat_logits, dtype=np.float64)
    if logits.size == 0:
        return []
    padded = np.pad(logits, half_window, constant_values=-np.inf)
    local_max = sliding_window_view(padded, 2 * half_window + 1).max(axis=1)
    index = np.flatnonzero((logits >= local_max) & (logits > 0))
    if index.size:
        index = index[np.concatenate(([True], np.diff(index) > half_window))]
    beats: list[dict] = []
    max_t = (duration_sec - 1e-5) if duration_sec and duration_sec > 1e-5 else None
    for pos, i in enumerate(index):
        offset = _parabolic_offset(logits, int(i))
        t_sec = (int(i) + offset) / fps
        if t_sec < 0.0:
            t_sec = 0.0
        if max_t is not None and t_sec >= duration_sec:
            continue
        conf = float(1.0 / (1.0 + math.exp(-float(logits[i]))))
        beats.append(
            {
                "id": f"beat_{pos}",
                "timeSec": round(t_sec, 6),
                "confidence": round(conf, 4),
                "source": "draft",
            }
        )
    return beats


def _active_acoustic_spans(
    onset_env: np.ndarray,
    rms_env: np.ndarray,
    actual_hop_s: float,
) -> list[tuple[int, int]]:
    """Split frame range [0, N) around sustained (> 2.5 s) silent/beatless intervals."""
    n = onset_env.size
    if n == 0:
        return []
    rms_ref = max(
        float(np.percentile(rms_env, 99)) if rms_env.size else 0.0,
        float(rms_env.max()) * 0.25 if rms_env.size else 0.0,
    )
    onset_ref = max(
        float(np.percentile(onset_env, 99)) if onset_env.size else 0.0,
        float(onset_env.max()) * 0.25 if onset_env.size else 0.0,
    )
    if rms_ref <= 1e-9 and onset_ref <= 1e-9:
        return []

    win = max(3, int(round(0.15 / actual_hop_s)))
    kernel = np.ones(win, dtype=np.float64) / win
    smooth_rms = (
        np.convolve(np.pad(rms_env / max(rms_ref, 1e-9), win // 2, mode="edge"), kernel, mode="valid")[:n]
        if rms_ref > 1e-9
        else np.zeros(n, dtype=np.float64)
    )
    smooth_ons = (
        np.convolve(np.pad(onset_env / max(onset_ref, 1e-9), win // 2, mode="edge"), kernel, mode="valid")[:n]
        if onset_ref > 1e-9
        else np.zeros(n, dtype=np.float64)
    )
    silent = (smooth_rms < 0.025) & (smooth_ons < 0.020)

    # Subtract filter dilatation margin (~win//2) from min_break_frames so a true >2.5 s gap is caught cleanly.
    min_break_frames = max(1, int(math.ceil((BREAK_GAP_SEC - 0.16) / actual_hop_s)))
    spans: list[tuple[int, int]] = []
    cur_start: int | None = None
    idx = 0
    while idx < n:
        if silent[idx]:
            run_end = idx + 1
            while run_end < n and silent[run_end]:
                run_end += 1
            if run_end - idx >= min_break_frames:
                if cur_start is not None and idx > cur_start:
                    spans.append((cur_start, idx))
                    cur_start = None
                idx = run_end
                continue
        if cur_start is None:
            cur_start = idx
        idx += 1
    if cur_start is not None and cur_start < n:
        spans.append((cur_start, n))

    # Trim silent lead/tail inside each active span to actual acoustic onset activity.
    trimmed: list[tuple[int, int]] = []
    active_mask = (rms_env > 0.03 * max(rms_ref, 1e-9)) | (onset_env > 0.05 * max(onset_ref, 1e-9))
    for s0, s1 in spans:
        nz = np.flatnonzero(active_mask[s0:s1])
        if nz.size == 0:
            continue
        t0 = max(s0, s0 + int(nz[0]) - 2)
        t1 = min(s1, s0 + int(nz[-1]) + 3)
        if t1 > t0:
            trimmed.append((t0, t1))
    return trimmed


def _dp_track_region(
    flux: np.ndarray,
    actual_hop_s: float,
    period_frames: float,
    tightness: float = 120.0,
) -> list[int]:
    """Ellis-style 1D dynamic-programming beat tracker over a local onset envelope."""
    n = flux.size
    p_int = max(2, int(round(period_frames)))
    if n < p_int:
        return []

    smooth = np.convolve(np.pad(flux, 1, mode="constant"), np.array([0.25, 0.5, 0.25]), mode="valid")
    min_step = max(2, int(round(0.55 * period_frames)))
    max_step = max(min_step + 1, int(round(1.65 * period_frames)))
    steps = np.arange(min_step, max_step + 1, dtype=np.int32)
    penalties = -tightness * (np.log(steps / float(period_frames)) ** 2)

    score = smooth.copy()
    backlink = np.full(n, -1, dtype=np.int32)

    for t in range(min_step, n):
        valid_steps = steps[steps <= t]
        if valid_steps.size == 0:
            continue
        prev_indices = t - valid_steps
        cand_scores = score[prev_indices] + penalties[: valid_steps.size]
        best_pos = int(np.argmax(cand_scores))
        if cand_scores[best_pos] > 0.0:
            score[t] = smooth[t] + float(cand_scores[best_pos])
            backlink[t] = int(prev_indices[best_pos])

    tail_start = max(0, n - int(round(1.5 * period_frames)))
    best_end = tail_start + int(np.argmax(score[tail_start:]))
    if score[best_end] <= 1e-6:
        return []

    chain: list[int] = []
    cur = best_end
    while cur >= 0:
        chain.append(cur)
        cur = int(backlink[cur])
    chain.reverse()

    # Snap each DP beat within +-2 frames to exact local onset peak when present.
    snapped: list[int] = []
    for f_idx in chain:
        lo = max(0, f_idx - 2)
        hi = min(n, f_idx + 3)
        local_best = lo + int(np.argmax(flux[lo:hi]))
        chosen = local_best if flux[local_best] > flux[f_idx] * 1.05 else f_idx
        if not snapped or chosen - snapped[-1] >= min_step:
            snapped.append(chosen)
    return snapped


def dsp_pulse_beats(
    mono: np.ndarray,
    sample_rate: int,
    duration_s: float,
    hop_s: float = FLUX_HOP_S,
    precomputed: dict | None = None,
) -> list[dict]:
    """Deterministic NumPy onset-tempogram DP pulse tracker with exact hop/sr timing."""
    if precomputed is not None and hop_s == FLUX_HOP_S:
        actual_hop_s = float(precomputed["actual_hop_s"])
        flux = np.asarray(precomputed["onset_env"], dtype=np.float64)
        rms_env = np.asarray(precomputed["rms_env"], dtype=np.float64)
    else:
        _, actual_hop_s = _flux_hop(sample_rate, hop_s)
        flux = onset_envelope(mono, sample_rate, hop_s)
        rms_env = flux

    min_lag = max(2, int(round(0.25 / actual_hop_s)))
    max_lag = max(min_lag + 1, int(round(1.05 / actual_hop_s)))
    if flux.size <= max_lag * 2:
        return []

    spans = _active_acoustic_spans(flux, rms_env, actual_hop_s)
    if not spans:
        return []

    peak_flux = float(np.percentile(flux, 98)) if flux.size else 1.0
    if peak_flux <= 1e-12:
        peak_flux = float(flux.max()) or 1.0

    # Partition long active spans into ~8 s tempogram windows if local tempo shifts substantially.
    sub_spans: list[tuple[int, int, float]] = []
    lags = np.arange(min_lag, max_lag + 1, dtype=np.int32)
    # Mild perceptual tempo prior centered near 120 BPM (0.5 s) so octave harmonics don't dominate blindly,
    # while still following genuine fast/slow click trains cleanly.
    lag_sec = lags * actual_hop_s
    prior = np.exp(-0.5 * ((np.log2(lag_sec / 0.5)) / 0.85) ** 2)

    def _estimate_period(seg_flux: np.ndarray) -> float:
        centred = seg_flux - seg_flux.mean()
        usable = lags[lags * 2 < centred.size]
        if usable.size == 0:
            return max(float(min_lag), 0.5 / actual_hop_s)
        corr = np.array([float(np.dot(centred[:-lag], centred[lag:])) for lag in usable])
        weighted = np.maximum(0.0, corr) * prior[: usable.size]
        if float(weighted.max()) <= 1e-12:
            return float(usable[int(np.argmax(corr))])
        best_idx = int(np.argmax(weighted))
        offset = _parabolic_offset(weighted, best_idx)
        return float(usable[best_idx]) + offset

    win_frames = int(round(8.0 / actual_hop_s))
    step_frames = int(round(4.0 / actual_hop_s))
    for s0, s1 in spans:
        length = s1 - s0
        if length < min_lag * 3:
            continue
        if length <= int(round(12.0 / actual_hop_s)):
            sub_spans.append((s0, s1, _estimate_period(flux[s0:s1])))
            continue
        # Estimate windowed periods and split only if tempo changes by > 10%.
        win_periods: list[tuple[int, int, float]] = []
        pos = s0
        while pos < s1:
            w_end = min(s1, pos + win_frames)
            if w_end - pos < max_lag * 2 and win_periods:
                prev_s0, _, prev_p = win_periods[-1]
                win_periods[-1] = (prev_s0, s1, prev_p)
                break
            win_periods.append((pos, w_end, _estimate_period(flux[pos:w_end])))
            if w_end == s1:
                break
            pos += step_frames
        # Coalesce adjacent windows with compatible periods.
        cur_s0, cur_s1, cur_p = win_periods[0]
        for nxt_s0, nxt_s1, nxt_p in win_periods[1:]:
            if abs(nxt_p - cur_p) / max(cur_p, nxt_p) <= 0.10:
                cur_s1 = nxt_s1
                cur_p = _estimate_period(flux[cur_s0:cur_s1])
            else:
                mid_split = (cur_s1 + nxt_s0) // 2
                sub_spans.append((cur_s0, mid_split, cur_p))
                cur_s0, cur_s1, cur_p = mid_split, nxt_s1, nxt_p
        sub_spans.append((cur_s0, cur_s1, cur_p))

    raw_times: list[tuple[float, float]] = []
    max_t = max(0.0, duration_s - 1e-5)
    for s0, s1, period in sub_spans:
        local_flux = flux[s0:s1]
        picked = _dp_track_region(local_flux, actual_hop_s, period)
        for local_i in picked:
            global_i = s0 + local_i
            offset = _parabolic_offset(flux, global_i)
            t_sec = (global_i + offset) * actual_hop_s
            if 0.0 <= t_sec <= max_t:
                local_peak = float(flux[max(0, global_i - 1) : min(flux.size, global_i + 2)].max())
                conf = float(np.clip(0.35 + 0.65 * min(1.0, local_peak / peak_flux), 0.1, 1.0))
                if not raw_times or t_sec - raw_times[-1][0] >= 0.18:
                    raw_times.append((t_sec, conf))

    return [
        {
            "id": f"beat_{idx}",
            "timeSec": round(t_sec, 6),
            "confidence": round(conf, 4),
            "source": "draft",
        }
        for idx, (t_sec, conf) in enumerate(raw_times)
    ]


# ---------------------------------------------------------------- Auto-Segmentation


def auto_segment_track(beats: list[dict], duration_sec: float) -> list[dict]:
    """Partition [0, duration_sec) into contiguous non-overlapping Segments (auto | free | break)."""
    dur = float(duration_sec)
    if dur <= 0.0:
        return []

    times = sorted(float(b["timeSec"]) for b in beats if 0.0 <= float(b["timeSec"]) < dur)
    if not times:
        regime = "break" if dur > BREAK_GAP_SEC else "auto"
        return [
            {
                "id": "seg_0",
                "t0": 0.0,
                "t1": round(dur, 6),
                "regime": regime,
                "kept": False,
                "source": "draft",
            }
        ]

    # 1. Split beat list across > 2.5 s beatless gaps.
    groups: list[list[float]] = [[times[0]]]
    for t in times[1:]:
        if t - groups[-1][-1] > BREAK_GAP_SEC:
            groups.append([t])
        else:
            groups[-1].append(t)

    raw_intervals: list[tuple[float, float, str]] = []
    cursor = 0.0

    for g_idx, grp in enumerate(groups):
        first_b = grp[0]
        last_b = grp[-1]
        local_ibi = float(np.median(np.diff(grp))) if len(grp) >= 2 else 0.5
        local_ibi = float(np.clip(local_ibi, 0.2, 1.0))

        # Leading or inter-group break before first_b.
        if first_b - cursor > BREAK_GAP_SEC:
            break_end = round(first_b, 6)
            if break_end > cursor + 0.05:
                raw_intervals.append((cursor, break_end, "break"))
                cursor = break_end

        # Determine where this active group ends before any subsequent break or track end.
        next_start = groups[g_idx + 1][0] if g_idx + 1 < len(groups) else dur
        has_following_break = (next_start - last_b) > BREAK_GAP_SEC
        if has_following_break:
            group_end = min(next_start - 0.05, last_b + min(local_ibi, 0.5))
            group_end = round(max(last_b + 0.02, group_end), 6)
        else:
            group_end = round(dur if g_idx + 1 == len(groups) else next_start, 6)

        # Detect genuine macro tempo-change pivots or phase resets inside grp (even windows so swing pairs cancel).
        split_points: list[float] = []
        if len(grp) >= 9:
            ibis = np.diff(grp)
            scores = np.zeros(len(grp), dtype=np.float64)
            is_phase_reset = np.zeros(len(grp), dtype=bool)
            for j in range(4, len(grp) - 4):
                left_ibis = ibis[max(0, j - 8) : j]
                right_ibis = ibis[j : min(len(ibis), j + 8)]
                if left_ibis.size < 4 or right_ibis.size < 4:
                    continue
                # Use trimmed/pair-averaged means alongside medians so 2-beat swing grooves never false-split.
                med_l = 0.5 * (float(np.median(left_ibis)) + float(np.mean(left_ibis)))
                med_r = 0.5 * (float(np.median(right_ibis)) + float(np.mean(right_ibis)))
                iqr_l = float(np.percentile(left_ibis, 75) - np.percentile(left_ibis, 25))
                iqr_r = float(np.percentile(right_ibis, 75) - np.percentile(right_ibis, 25))
                diff_abs = abs(med_r - med_l)
                tempo_rel = diff_abs / max(med_l, med_r, 1e-6)
                snr = diff_abs / max(0.5 * (iqr_l + iqr_r), 0.015 * max(med_l, med_r))
                if tempo_rel > 0.11 and snr >= 2.2:
                    scores[j] = tempo_rel

                if j >= 4 and left_ibis.size >= 4:
                    steady_l = float(np.median(ibis[max(0, j - 8) : j - 1]))
                    mad_l = float(np.median(np.abs(ibis[max(0, j - 8) : j - 1] - steady_l)))
                    mad_r = float(np.median(np.abs(right_ibis - med_r)))
                    trans_ibi = float(ibis[j - 1])
                    if (
                        abs(steady_l - med_r) / max(steady_l, med_r, 1e-6) < 0.05
                        and mad_l < 0.03 * steady_l
                        and mad_r < 0.03 * med_r
                        and abs(trans_ibi - steady_l) > 0.28 * steady_l
                    ):
                        is_phase_reset[j] = True
                        scores[j] = max(scores[j], 0.15)

            last_split_t = cursor
            last_split_idx = 0
            for j in range(4, len(grp) - 4):
                if scores[j] <= 0.0:
                    continue
                if scores[j] < scores[j - 1] or scores[j] < scores[j + 1]:
                    continue
                pivot_t = round(grp[j], 6)
                if (
                    j - last_split_idx >= 4
                    and pivot_t - last_split_t >= 2.5
                    and group_end - pivot_t >= 2.5
                ):
                    split_points.append(pivot_t)
                    last_split_t = pivot_t
                    last_split_idx = j

        sub_bounds = [cursor, *split_points, group_end]
        for s_i in range(len(sub_bounds) - 1):
            st0 = sub_bounds[s_i]
            st1 = sub_bounds[s_i + 1]
            if st1 <= st0 + 1e-4:
                continue
            sub_beats = [t for t in grp if st0 - 1e-6 <= t < st1 + 1e-6]
            regime = "auto"
            if len(sub_beats) >= 5:
                sub_ibis = np.diff(sub_beats)
                med = float(np.median(sub_ibis))
                if med > 1e-6:
                    rel_step = np.abs(np.diff(sub_ibis)) / np.maximum(sub_ibis[:-1], 1e-6)
                    iqr_rel = float(np.percentile(sub_ibis, 75) - np.percentile(sub_ibis, 25)) / med
                    if float(np.median(rel_step)) > 0.045 or iqr_rel > 0.08:
                        regime = "free"
            raw_intervals.append((st0, st1, regime))
        cursor = group_end

    if dur - cursor > 1e-4:
        tail_regime = "break" if (dur - times[-1]) > BREAK_GAP_SEC else (raw_intervals[-1][2] if raw_intervals else "auto")
        if tail_regime == "break" and raw_intervals and raw_intervals[-1][2] == "break":
            prev_t0, _, _ = raw_intervals[-1]
            raw_intervals[-1] = (prev_t0, round(dur, 6), "break")
        elif tail_regime != "break" and raw_intervals and (dur - cursor) < 0.5:
            prev_t0, _, prev_reg = raw_intervals[-1]
            raw_intervals[-1] = (prev_t0, round(dur, 6), prev_reg)
        else:
            raw_intervals.append((cursor, round(dur, 6), tail_regime))

    # Enforce exact [0, dur) contiguity and merge degenerate slivers (< 0.2 s).
    cleaned: list[list] = []
    for t0, t1, reg in raw_intervals:
        if t1 <= t0 + 1e-5:
            continue
        if cleaned and (t1 - t0) < 0.20 and reg != "break":
            cleaned[-1][1] = t1
        else:
            cleaned.append([t0, t1, reg])

    if not cleaned:
        cleaned = [[0.0, dur, "auto"]]
    cleaned[0][0] = 0.0
    cleaned[-1][1] = dur
    for idx in range(len(cleaned) - 1):
        mid = round(float(cleaned[idx][1]), 6)
        mid = min(max(mid, float(cleaned[idx][0]) + 1e-4), dur - 1e-4)
        cleaned[idx][1] = mid
        cleaned[idx + 1][0] = mid

    return [
        {
            "id": f"seg_{idx}",
            "t0": float(seg[0]),
            "t1": float(seg[1]),
            "regime": str(seg[2]),
            "kept": False,
            "source": "draft",
        }
        for idx, seg in enumerate(cleaned)
        if float(seg[1]) > float(seg[0])
    ]


# ---------------------------------------------------------------- CPU Fast-Path: suggest_snaps


def _local_median_2d(values: np.ndarray, kernel: int, axis: int) -> np.ndarray:
    if values.size == 0:
        return values.copy()
    work = np.moveaxis(values, axis, 1).astype(np.float32)
    length = work.shape[1]
    if length <= 1 or kernel <= 1:
        return np.moveaxis(work, 1, axis)
    half = min(kernel // 2, length - 1)
    eff_kernel = 2 * half + 1
    pad_mode = "reflect" if length > half else "edge"
    padded = np.pad(work, ((0, 0), (half, half)), mode=pad_mode)
    windows = sliding_window_view(padded, eff_kernel, axis=1)
    med = np.median(windows, axis=-1)
    return np.moveaxis(med, 1, axis)


def suggest_snaps_cpu(
    pcm: np.ndarray,
    sample_rate: int,
    time_sec: float,
    window_sec: float = 0.12,
    cancel_event: threading.Event | None = None,
) -> list[dict]:
    """Pure-NumPy CPU micro-assist snap detector around time_sec (< 40 ms)."""
    _check_cancel(cancel_event)
    total_samples = pcm.shape[0]
    if total_samples == 0 or sample_rate <= 0:
        return []

    duration_sec = total_samples / float(sample_rate)
    win_sec = float(np.clip(window_sec, 0.02, 1.5))
    query_sec = float(np.clip(time_sec, 0.0, duration_sec))
    pad_sec = 0.14

    s0 = max(0, int(round((query_sec - win_sec - pad_sec) * sample_rate)))
    s1 = min(total_samples, int(round((query_sec + win_sec + pad_sec) * sample_rate)))
    if s1 - s0 < 32:
        return []

    local_mono = pcm[s0:s1].mean(axis=1, dtype=np.float64)
    hop_samples = max(1, int(round(sample_rate * SNAP_HOP_S)))
    actual_hop_s = hop_samples / float(sample_rate)
    n_fft = 1024 if sample_rate >= 32000 else 512

    padded = np.pad(local_mono, n_fft // 2)
    n_frames = 1 + max(0, (padded.size - n_fft) // hop_samples)
    if n_frames < 5:
        return []

    frames = sliding_window_view(padded, n_fft)[: n_frames * hop_samples : hop_samples]
    spec = np.fft.rfft(frames * np.hanning(n_fft), axis=1)
    mag = np.abs(spec)
    power = mag**2
    freqs = np.fft.rfftfreq(n_fft, 1.0 / sample_rate)

    _check_cancel(cancel_event)

    # Fast local 2D median HPSS on the compact window spectrogram (~150-250 frames).
    harm_mag = _local_median_2d(mag, kernel=11, axis=0).astype(np.float64)
    perc_mag = _local_median_2d(mag, kernel=11, axis=1).astype(np.float64)
    denom = harm_mag**2 + perc_mag**2 + 1e-18
    perc_power = power * ((perc_mag**2) / denom)
    harm_power = power * ((harm_mag**2) / denom)

    low_mask = (freqs >= 25.0) & (freqs < LOW_HZ)
    mid_mask = (freqs >= LOW_HZ) & (freqs <= HIGH_HZ)
    high_mask = freqs > HIGH_HZ

    low_e = np.sqrt(power[:, low_mask].sum(axis=1) + 1e-18) if np.any(low_mask) else np.zeros(n_frames)
    mid_e = np.sqrt(power[:, mid_mask].sum(axis=1) + 1e-18) if np.any(mid_mask) else np.zeros(n_frames)
    high_e = np.sqrt(power[:, high_mask].sum(axis=1) + 1e-18) if np.any(high_mask) else np.zeros(n_frames)

    rms_total = np.sqrt(power.sum(axis=1) + 1e-18)
    rms_perc = np.sqrt(perc_power.sum(axis=1) + 1e-18)
    rms_harm = np.sqrt(harm_power.sum(axis=1) + 1e-18)

    peak_rms = float(rms_total.max())
    if peak_rms <= 1e-7:
        return []

    # Exact frame timestamps on original mix clock.
    frame_times = (s0 + np.arange(n_frames, dtype=np.float64) * hop_samples) / float(sample_rate)
    in_window = (frame_times >= max(0.0, query_sec - win_sec)) & (
        frame_times <= min(duration_sec, query_sec + win_sec)
    )
    if not np.any(in_window):
        return []

    # 1. Transient attack signal: fast percussive + log-energy positive derivative with high crest.
    log_perc = np.log1p(1000.0 * (rms_perc / peak_rms))
    log_tot = np.log1p(1000.0 * (rms_total / peak_rms))
    perc_flux = np.concatenate(([0.0], np.maximum(0.0, np.diff(log_perc))))
    tot_flux = np.concatenate(([0.0], np.maximum(0.0, np.diff(log_tot))))
    attack_sig = 0.65 * perc_flux + 0.35 * tot_flux

    # 2. P-center signal: Gaussian-smoothed (~30 ms) positive envelope inflection dE/dt on sustained/harmonic swells.
    sigma_frames = max(2.0, 0.014 / actual_hop_s)
    g_half = max(3, int(round(3.0 * sigma_frames)))
    gx = np.arange(-g_half, g_half + 1, dtype=np.float64)
    gauss = np.exp(-0.5 * (gx / sigma_frames) ** 2)
    gauss /= gauss.sum()
    smooth_env = np.convolve(np.pad(rms_total / peak_rms, g_half, mode="edge"), gauss, mode="valid")[:n_frames]
    de_dt = np.gradient(smooth_env)

    # 3. Harmonic change signal: spectral novelty across +-35 ms split window while energy stays sustained.
    h_win = max(3, int(round(0.035 / actual_hop_s)))
    # Restrict to musical pitch frequencies 50..5000 Hz so pitch/chord changes stand out cleanly.
    pitch_mask = (freqs >= 50.0) & (freqs <= 5000.0)
    pitch_spec = harm_mag[:, pitch_mask].astype(np.float64) if np.any(pitch_mask) else harm_mag.astype(np.float64)
    harm_novelty = np.zeros(n_frames, dtype=np.float64)
    sustained_gate = np.zeros(n_frames, dtype=np.float64)
    for k in range(h_win, n_frames - h_win):
        e_left = float(rms_total[k - h_win : k].mean())
        e_right = float(rms_total[k : k + h_win].mean())
        if e_left > 0.14 * peak_rms and e_right > 0.14 * peak_rms:
            # Suppress pure amplitude jumps; require balanced left/right loudness.
            balance = min(e_left, e_right) / max(e_left, e_right, 1e-12)
            if balance >= 0.40:
                v_left = pitch_spec[k - h_win : k].mean(axis=0)
                v_right = pitch_spec[k : k + h_win].mean(axis=0)
                nl = float(np.linalg.norm(v_left))
                nr = float(np.linalg.norm(v_right))
                if nl > 1e-12 and nr > 1e-12:
                    cos_sim = float(np.dot(v_left, v_right) / (nl * nr))
                    harm_novelty[k] = max(0.0, 1.0 - cos_sim) * balance
                    sustained_gate[k] = balance

    # 4. Release signal: sharp negative dE/dt where preceding 35 ms had energy and following 30 ms drops sharply.
    rel_win = max(3, int(round(0.032 / actual_hop_s)))
    release_sig = np.zeros(n_frames, dtype=np.float64)
    neg_grad = np.maximum(0.0, -np.gradient(rms_total / peak_rms))
    for k in range(rel_win, n_frames - rel_win):
        before_e = float(rms_total[k - rel_win : k].mean())
        after_e = float(rms_total[k + 1 : k + 1 + rel_win].mean())
        if before_e > 0.18 * peak_rms and after_e < 0.42 * before_e:
            drop_ratio = 1.0 - (after_e / max(before_e, 1e-12))
            release_sig[k] = neg_grad[k] * drop_ratio

    def _local_peaks(sig: np.ndarray, radius_frames: int, min_val: float) -> list[int]:
        if sig.size == 0 or float(sig.max()) <= min_val:
            return []
        pad_s = np.pad(sig, radius_frames, constant_values=-np.inf)
        lmax = sliding_window_view(pad_s, 2 * radius_frames + 1).max(axis=1)
        cand = np.flatnonzero((sig >= lmax) & (sig > min_val) & in_window)
        if cand.size > 1:
            cand = cand[np.concatenate(([True], np.diff(cand) > radius_frames))]
        return [int(i) for i in cand]

    min_sep_frames = max(2, int(round(0.015 / actual_hop_s)))
    raw_candidates: list[dict] = []

    # Collect transient_attack peaks.
    atk_max = float(attack_sig[in_window].max()) if np.any(in_window) else 0.0
    atk_peaks: list[int] = []
    if atk_max > 0.12:
        for k in _local_peaks(attack_sig, min_sep_frames, max(0.12, 0.25 * atk_max)):
            # Verify sharp rise vs gradual swell: compare 10 ms jump against 50 ms rise.
            pre_k = max(0, k - max(1, int(round(0.012 / actual_hop_s))))
            post_k = min(n_frames - 1, k + max(1, int(round(0.008 / actual_hop_s))))
            perc_share = float(rms_perc[post_k] / max(rms_total[post_k], 1e-12))
            fast_jump = float((rms_total[post_k] - rms_total[pre_k]) / peak_rms)
            if perc_share >= 0.42 or attack_sig[k] >= 0.45:
                offset = _parabolic_offset(attack_sig, k)
                # SpectrogramHann window spreads transient slightly earlier by ~1 frame on step edges; refine to local max |d(energy)|.
                t_sec = float(np.clip((s0 + (k + offset) * hop_samples) / float(sample_rate), 0.0, duration_sec))
                crest = float(attack_sig[k] / max( float(np.median(attack_sig) + 0.05), 1e-4))
                w0, w1 = max(0, k - 1), min(n_frames, k + 3)
                family, label = _classify_band_profile(
                    float(low_e[w0:w1].mean()),
                    float(mid_e[w0:w1].mean()),
                    float(high_e[w0:w1].mean()),
                    crest,
                    "transient_attack",
                )
                salience = float(np.clip(0.35 + 0.65 * min(1.0, attack_sig[k] / max(atk_max, 0.35)) * max(0.5, fast_jump + perc_share), 0.1, 1.0))
                atk_peaks.append(k)
                raw_candidates.append(
                    {
                        "frame": k,
                        "targetSec": t_sec,
                        "family": family,
                        "role": "transient_attack",
                        "sigmaMs": 4.0,
                        "label": label,
                        "salience": salience,
                    }
                )

    # Collect p_center peaks (gradual swells not already explained by an impulsive transient_attack).
    de_max = float(de_dt[in_window].max()) if np.any(in_window) else 0.0
    if de_max > 0.006:
        suppress_frames = max(3, int(round(0.025 / actual_hop_s)))
        for k in _local_peaks(de_dt, min_sep_frames, max(0.006, 0.30 * de_max)):
            if any(abs(k - ak) <= suppress_frames for ak in atk_peaks):
                # Only keep p_center near an attack if harmonic dominance is very strong and percussive attack was weak.
                nearest_ak = min(atk_peaks, key=lambda ak: abs(k - ak))
                if attack_sig[nearest_ak] > 0.38 or float(rms_harm[k] / max(rms_total[k], 1e-12)) < 0.72:
                    continue
            offset = _parabolic_offset(de_dt, k)
            t_sec = float(np.clip((s0 + (k + offset) * hop_samples) / float(sample_rate), 0.0, duration_sec))
            w0, w1 = max(0, k - 2), min(n_frames, k + 4)
            family, label = _classify_band_profile(
                float(low_e[w0:w1].mean()),
                float(mid_e[w0:w1].mean()),
                float(high_e[w0:w1].mean()),
                1.0,
                "p_center",
            )
            salience = float(np.clip(0.30 + 0.65 * (de_dt[k] / max(de_max, 0.02)), 0.1, 0.96))
            raw_candidates.append(
                {
                    "frame": k,
                    "targetSec": t_sec,
                    "family": family,
                    "role": "p_center",
                    "sigmaMs": 12.0,
                    "label": label,
                    "salience": salience,
                }
            )

    # Collect harmonic_change peaks.
    hn_max = float(harm_novelty[in_window].max()) if np.any(in_window) else 0.0
    if hn_max > 0.06:
        for k in _local_peaks(harm_novelty, min_sep_frames, max(0.06, 0.35 * hn_max)):
            if any(abs(k - ak) <= min_sep_frames and attack_sig[ak] > 0.45 for ak in atk_peaks):
                continue
            offset = _parabolic_offset(harm_novelty, k)
            t_sec = float(np.clip((s0 + (k + offset) * hop_samples) / float(sample_rate), 0.0, duration_sec))
            w0, w1 = max(0, k - 3), min(n_frames, k + 3)
            family, label = _classify_band_profile(
                float(low_e[w0:w1].mean()),
                float(mid_e[w0:w1].mean()),
                float(high_e[w0:w1].mean()),
                1.0,
                "harmonic_change",
            )
            salience = float(np.clip(0.30 + 0.68 * min(1.0, harm_novelty[k] / max(hn_max, 0.15)), 0.1, 0.95))
            raw_candidates.append(
                {
                    "frame": k,
                    "targetSec": t_sec,
                    "family": family,
                    "role": "harmonic_change",
                    "sigmaMs": 13.0,
                    "label": label,
                    "salience": salience,
                }
            )

    # Collect release peaks.
    rel_max = float(release_sig[in_window].max()) if np.any(in_window) else 0.0
    if rel_max > 0.010:
        for k in _local_peaks(release_sig, min_sep_frames, max(0.010, 0.35 * rel_max)):
            offset = _parabolic_offset(release_sig, k)
            t_sec = float(np.clip((s0 + (k + offset) * hop_samples) / float(sample_rate), 0.0, duration_sec))
            w0, w1 = max(0, k - rel_win), max(1, k)
            family, label = _classify_band_profile(
                float(low_e[w0:w1].mean()),
                float(mid_e[w0:w1].mean()),
                float(high_e[w0:w1].mean()),
                1.0,
                "release",
            )
            salience = float(np.clip(0.28 + 0.65 * min(1.0, release_sig[k] / max(rel_max, 0.03)), 0.1, 0.92))
            raw_candidates.append(
                {
                    "frame": k,
                    "targetSec": t_sec,
                    "family": family,
                    "role": "release",
                    "sigmaMs": 12.0,
                    "label": label,
                    "salience": salience,
                }
            )

    if not raw_candidates:
        return []

    # Score by salience + Gaussian proximity to query_sec and deduplicate within 8 ms.
    prox_sigma = max(0.015, 0.65 * win_sec)
    for c in raw_candidates:
        dist_s = abs(c["targetSec"] - query_sec)
        prox = math.exp(-0.5 * (dist_s / prox_sigma) ** 2)
        c["rankScore"] = c["salience"] * (0.55 + 0.45 * prox)

    raw_candidates.sort(key=lambda c: (-c["rankScore"], abs(c["targetSec"] - query_sec)))
    deduped: list[dict] = []
    for c in raw_candidates:
        if any(abs(c["targetSec"] - existing["targetSec"]) < 0.008 for existing in deduped):
            continue
        target_sec = round(float(c["targetSec"]), 6)
        delta_ms = round((target_sec - query_sec) * 1000.0, 2)
        tag_us = int(round(target_sec * 10000.0))
        deduped.append(
            {
                "eventId": f"snap_{c['role']}_{tag_us}",
                "targetSec": target_sec,
                "deltaMs": delta_ms,
                "family": c["family"],
                "role": c["role"],
                "sigmaMs": float(c["sigmaMs"]),
                "label": c["label"],
                "salience": round(float(np.clip(c["salience"], 0.05, 1.0)), 4),
            }
        )
        if len(deduped) >= 4:
            break

    deduped.sort(key=lambda c: (-c["salience"], abs(c["deltaMs"])))
    return deduped


# ---------------------------------------------------------------- Student-t Constrained Recompute


def _format_timecode(sec: float) -> str:
    ms_total = max(0, int(round(sec * 1000.0)))
    minutes = ms_total // 60000
    rem = ms_total - minutes * 60000
    seconds = rem // 1000
    millis = rem - seconds * 1000
    return f"{minutes}:{seconds:02d}.{millis:03d}"


def _subtract_locks(
    t0: float,
    t1: float,
    locks: list[tuple[float, float]],
) -> list[tuple[float, float]]:
    intervals = [(t0, t1)]
    for l0, l1 in locks:
        nxt: list[tuple[float, float]] = []
        for a, b in intervals:
            if l1 <= a + 1e-6 or l0 >= b - 1e-6:
                nxt.append((a, b))
                continue
            if a < l0 - 1e-6:
                nxt.append((a, l0))
            if b > l1 + 1e-6:
                nxt.append((l1, b))
        intervals = nxt
        if not intervals:
            break
    return [(a, b) for a, b in intervals if b - a > 0.05]


def _student_t_attraction(delta_sec: np.ndarray | float, sigma_sec: float, nu: float = 2.0) -> np.ndarray | float:
    """Heavy-tailed Student-t kernel: strong local pull within +-sigma_sec, saturating on mistap outliers."""
    scaled_sq = (np.asarray(delta_sec) / max(sigma_sec, 1e-4)) ** 2
    return (1.0 + scaled_sq / nu) ** (-(nu + 1.0) / 2.0)


def _build_cue_potential(
    grid_times: np.ndarray,
    onset_at_grid: np.ndarray,
    guides: list[dict],
    repulsions: list[dict],
    sound_obs: list[dict],
    family_salience_at_grid: dict[str, np.ndarray],
) -> np.ndarray:
    """Combine acoustic onset salience with heavy-tailed Student-t user beat guides & unbeat repulsions."""
    # Base acoustic onset potential in [0, 1].
    pot = 0.55 * onset_at_grid.copy()

    # Boost family-specific envelope if user snapped any guide to a family.
    preferred_families = [g.get("snapFamily") for g in guides if g.get("snapFamily") in family_salience_at_grid]
    if preferred_families:
        fam = preferred_families[0]
        pot = 0.35 * onset_at_grid + 0.35 * family_salience_at_grid[fam]

    # Soft sound observation cues.
    for obs in sound_obs:
        t_obs = float(obs["timeSec"])
        sigma_s = max(0.006, float(obs.get("sigmaMs", 12.0)) / 1000.0)
        weight = 0.75 * float(obs.get("strength", 0.8))
        pot += weight * _student_t_attraction(grid_times - t_obs, sigma_s, nu=3.0)

    # Heavy-tailed Student-t beatGuides: strong local attraction, bounded tail on mistaps!
    for guide in guides:
        t_g = float(guide["timeSec"])
        tol = max(0.012, float(guide.get("toleranceSec", 0.02)))
        pot += 2.4 * _student_t_attraction(grid_times - t_g, tol, nu=2.0)

    # Smooth period-scaled UnbeatCue repulsion.
    for rep in repulsions:
        t_u = float(rep["timeSec"])
        rad = max(0.020, float(rep.get("repulsionRadiusSec", 0.05)))
        pot -= 2.2 * _student_t_attraction(grid_times - t_u, 0.55 * rad, nu=2.0)

    return pot


def _candidate_periods(
    onset_slice: np.ndarray,
    actual_hop_s: float,
    existing_beats: list[float],
    guides: list[dict],
) -> list[float]:
    """Generate distinct musical period candidates (fundamental, guide-implied, half/double)."""
    candidates: list[float] = []

    if len(existing_beats) >= 2:
        ibis = np.diff(sorted(existing_beats))
        valid = ibis[(ibis >= 0.18) & (ibis <= 1.5)]
        if valid.size > 0:
            candidates.append(float(np.median(valid)))

    # Robust pairwise inter-guide period estimates (resilient to 1 outlier mistap!).
    guide_times = sorted(float(g["timeSec"]) for g in guides)
    if len(guide_times) >= 2:
        implied: list[float] = []
        for i in range(len(guide_times)):
            for j in range(i + 1, min(len(guide_times), i + 6)):
                span = guide_times[j] - guide_times[i]
                for k_div in range(1, 7):
                    cand_p = span / float(k_div)
                    if 0.22 <= cand_p <= 1.15:
                        # Score consistency against ALL guides via Student-t!
                        score_p = sum(
                            float(_student_t_attraction(((gt - guide_times[i] + 0.5 * cand_p) % cand_p) - 0.5 * cand_p, 0.02, nu=2.0))
                            for gt in guide_times
                        )
                        if score_p >= max(1.8, 0.55 * len(guide_times)):
                            implied.append((score_p, cand_p))
        if implied:
            implied.sort(key=lambda item: -item[0])
            candidates.append(implied[0][1])

    # Acoustic autocorrelation peak(s).
    min_lag = max(2, int(round(0.24 / actual_hop_s)))
    max_lag = max(min_lag + 1, int(round(1.10 / actual_hop_s)))
    if onset_slice.size > max_lag * 2:
        centred = onset_slice - onset_slice.mean()
        lags = np.arange(min_lag, max_lag + 1, dtype=np.int32)
        corr = np.array([float(np.dot(centred[:-lag], centred[lag:])) for lag in lags])
        if float(corr.max()) > 1e-9:
            top_idx = int(np.argmax(corr))
            ac_p = (float(lags[top_idx]) + _parabolic_offset(corr, top_idx)) * actual_hop_s
            candidates.append(ac_p)

    if not candidates:
        candidates.append(0.5)

    # Expand with half-time (2*T) and double-time (0.5*T) within [0.22, 1.20] s.
    expanded: list[float] = []
    for base_p in candidates:
        for mult in (1.0, 0.5, 2.0):
            p = base_p * mult
            if 0.22 <= p <= 1.20:
                if not any(abs(p - ep) / max(p, ep) < 0.035 for ep in expanded):
                    expanded.append(p)
    return expanded


def _solve_pulse_for_period(
    t0: float,
    t1: float,
    grid_times: np.ndarray,
    potential: np.ndarray,
    onset_at_grid: np.ndarray,
    period_sec: float,
    guides: list[dict],
    repulsions: list[dict],
    is_free: bool,
) -> dict | None:
    """Find best DP pulse chain (plus optional competing phase) for period_sec on [t0, t1)."""
    if grid_times.size < 4:
        return None
    dt = float(grid_times[1] - grid_times[0])
    p_frames = period_sec / dt
    if p_frames < 3.0:
        return None

    tightness = 22.0 if is_free else 95.0
    min_step = max(2, int(round((0.52 if is_free else 0.72) * p_frames)))
    max_step = max(min_step + 1, int(round((1.75 if is_free else 1.35) * p_frames)))
    steps = np.arange(min_step, max_step + 1, dtype=np.int32)
    step_penalties = -tightness * (np.log(steps / p_frames) ** 2)

    n = potential.size
    # Phase search + DP refinement: test 16 seed phases in the first period to uncover both
    # primary phase and any strong off-beat / alternate-phase competitor.
    first_window = min(n, max(4, int(round(1.25 * p_frames))))
    dp_score = potential.copy()
    back = np.full(n, -1, dtype=np.int32)

    for idx in range(min_step, n):
        valid = steps[steps <= idx]
        if valid.size == 0:
            continue
        prev = idx - valid
        cand = dp_score[prev] + step_penalties[: valid.size]
        best_j = int(np.argmax(cand))
        dp_score[idx] = potential[idx] + float(cand[best_j])
        back[idx] = int(prev[best_j])

    tail_lo = max(0, n - first_window)
    if tail_lo >= n:
        return None
    best_end = tail_lo + int(np.argmax(dp_score[tail_lo:]))

    chain: list[int] = []
    cur = best_end
    while cur >= 0:
        chain.append(cur)
        cur = int(back[cur])
    chain.reverse()

    if len(chain) < 2:
        return None

    # Sub-frame parabolic refinement on positive potential / onset peaks.
    beat_times: list[float] = []
    confs: list[float] = []
    pot_peak = max(float(np.percentile( np.maximum(0.0, potential), 95)), 0.5)
    for f_i in chain:
        offset = _parabolic_offset(potential, f_i)
        bt = float(grid_times[0] + (f_i + offset) * dt)
        if t0 <= bt < t1 - 1e-5:
            if not beat_times or bt - beat_times[-1] >= 0.15:
                beat_times.append(round(bt, 6))
                c_val = float(np.clip(0.45 + 0.50 * (max(0.0, float(potential[f_i])) / pot_peak), 0.25, 0.99))
                confs.append(round(c_val, 4))

    if len(beat_times) < 2:
        return None

    bt_arr = np.asarray(beat_times, dtype=np.float64)

    # Evaluate musical objective normalized per beat + Student-t guide satisfaction.
    interp_pot = np.interp(bt_arr, grid_times, potential)
    per_beat_acoustic = float(np.mean(interp_pot))

    guide_score = 0.0
    for g in guides:
        gt = float(g["timeSec"])
        if t0 - 0.05 <= gt <= t1 + 0.05:
            nearest_d = float(np.min(np.abs(bt_arr - gt)))
            tol = max(0.012, float(g.get("toleranceSec", 0.02)))
            guide_score += 2.2 * float(_student_t_attraction(nearest_d, tol, nu=2.0))

    rep_penalty = 0.0
    for rep in repulsions:
        ut = float(rep["timeSec"])
        if t0 - 0.05 <= ut <= t1 + 0.05:
            nearest_d = float(np.min(np.abs(bt_arr - ut)))
            rad = max(0.020, float(rep.get("repulsionRadiusSec", 0.05)))
            rep_penalty += 2.0 * float(_student_t_attraction(nearest_d, 0.55 * rad, nu=2.0))

    ibis = np.diff(bt_arr)
    eff_period = float(np.median(ibis)) if ibis.size > 0 else period_sec
    total_score = per_beat_acoustic + guide_score - rep_penalty
    return {
        "beatTimes": beat_times,
        "confidences": confs,
        "periodSec": eff_period,
        "bpm": round(60.0 / max(eff_period, 1e-4), 1),
        "score": total_score,
        "kind": "primary",
    }


def _solve_alternate_phase(
    t0: float,
    t1: float,
    grid_times: np.ndarray,
    potential: np.ndarray,
    primary_beats: list[float],
    period_sec: float,
    guides: list[dict],
    repulsions: list[dict],
) -> dict | None:
    """Evaluate half-period (off-beat) phase hypothesis to see if phase is genuinely ambiguous."""
    if len(primary_beats) < 2 or period_sec < 0.25:
        return None
    shift = 0.5 * period_sec
    shifted: list[float] = []
    # Include an earlier shifted beat before primary_beats[0] if inside [t0, t1).
    first_cand = primary_beats[0] - shift
    if first_cand >= t0:
        shifted.append(first_cand)
    for bt in primary_beats:
        cand = bt + shift
        if t0 <= cand < t1 - 1e-5:
            shifted.append(cand)
    if len(shifted) < 2:
        return None

    dt = float(grid_times[1] - grid_times[0])
    search_r = max(2, int(round(0.045 / dt)))
    snapped_times: list[float] = []
    confs: list[float] = []
    pot_peak = max(float(np.percentile(np.maximum(0.0, potential), 95)), 0.5)
    for st in shifted:
        center_i = int(np.clip(round((st - grid_times[0]) / dt), 0, grid_times.size - 1))
        lo = max(0, center_i - search_r)
        hi = min(grid_times.size, center_i + search_r + 1)
        best_i = lo + int(np.argmax(potential[lo:hi]))
        bt = float(grid_times[0] + (best_i + _parabolic_offset(potential, best_i)) * dt)
        if t0 <= bt < t1 - 1e-5 and (not snapped_times or bt - snapped_times[-1] >= 0.15):
            snapped_times.append(round(bt, 6))
            c_val = float(np.clip(0.45 + 0.50 * (max(0.0, float(potential[best_i])) / pot_peak), 0.25, 0.99))
            confs.append(round(c_val, 4))

    if len(snapped_times) < 2:
        return None
    bt_arr = np.asarray(snapped_times, dtype=np.float64)
    per_beat_acoustic = float(np.mean(np.interp(bt_arr, grid_times, potential)))
    guide_score = sum(
        2.2 * float(_student_t_attraction(float(np.min(np.abs(bt_arr - float(g["timeSec"])))), max(0.012, float(g.get("toleranceSec", 0.02))), nu=2.0))
        for g in guides
        if t0 - 0.05 <= float(g["timeSec"]) <= t1 + 0.05
    )
    rep_penalty = sum(
        2.0 * float(_student_t_attraction(float(np.min(np.abs(bt_arr - float(r["timeSec"])))), 0.55 * max(0.020, float(r.get("repulsionRadiusSec", 0.05))), nu=2.0))
        for r in repulsions
        if t0 - 0.05 <= float(r["timeSec"]) <= t1 + 0.05
    )
    eff_period = float(np.median(np.diff(bt_arr)))
    return {
        "beatTimes": snapped_times,
        "confidences": confs,
        "periodSec": eff_period,
        "bpm": round(60.0 / max(eff_period, 1e-4), 1),
        "score": per_beat_acoustic + guide_score - rep_penalty,
        "kind": "offbeat_phase",
    }


def _describe_hypothesis_title(
    hyp: dict,
    existing_beats: list[dict],
    option_role: str | None = None,
) -> str:
    """Produce a concise, 100% clean musical title with zero internal IDs or dev jargon."""
    new_times = np.asarray(hyp["beatTimes"], dtype=np.float64)
    bpm = int(round(hyp["bpm"]))
    old_times = np.asarray(sorted(float(b["timeSec"]) for b in existing_beats), dtype=np.float64)

    if old_times.size >= 2 and new_times.size >= 2:
        old_p = float(np.median(np.diff(old_times)))
        new_p = float(hyp["periodSec"])
        ratio = old_p / max(new_p, 1e-6)
        if 1.75 <= ratio <= 2.25:
            return f"Double-time pulse ({bpm} BPM)"
        if 0.44 <= ratio <= 0.57:
            return f"Half-time pulse ({bpm} BPM)"
        if abs(ratio - 1.0) <= 0.08:
            # Same tempo: check systematic phase shift vs offbeat flip.
            deltas = []
            for nt in new_times:
                idx = int(np.argmin(np.abs(old_times - nt)))
                deltas.append((nt - old_times[idx]) * 1000.0)
            med_ms = int(round(float(np.median(deltas))))
            if abs(med_ms) >= int(round(0.32 * new_p * 1000.0)):
                return f"Shift pulse to alternate phase ({bpm} BPM)"
            if abs(med_ms) >= 2:
                sign = "+" if med_ms > 0 else ""
                return f"Align pulse to attacks ({sign}{med_ms} ms)"
            return f"Refine local beat timing ({bpm} BPM)"
        return f"Track local tempo ({bpm} BPM)"

    if option_role == "alternate":
        return f"Alternate pulse grid ({bpm} BPM)"
    return f"Establish pulse grid ({bpm} BPM)"


def _build_ops_for_hypothesis(
    hyp: dict,
    scope_beats: list[dict],
    entity_revisions: dict[str, str],
    generation: int,
    opt_idx: int,
    write_scopes: list[dict],
) -> tuple[dict, dict[str, str]] | None:
    """Map proposed beatTimes onto existing scope beats (move within +-85 ms, else upsert/remove)."""
    new_times: list[float] = hyp["beatTimes"]
    confs: list[float] = hyp["confidences"]

    def _in_scopes(t_val: float) -> bool:
        return any(float(ws["t0"]) <= t_val < float(ws["t1"]) for ws in write_scopes)

    # Filter strictly to write_scopes!
    filtered_pairs = [(t, c) for t, c in zip(new_times, confs) if _in_scopes(t)]
    if not filtered_pairs:
        return None

    sorted_old = sorted(
        [b for b in scope_beats if _in_scopes(float(b["timeSec"]))],
        key=lambda b: float(b["timeSec"]),
    )

    used_old: set[str] = set()
    upsert_beats: list[dict] = []
    expected_revs: dict[str, str] = {}
    meaningful_change = False

    for pos, (nt, conf) in enumerate(filtered_pairs):
        best_old = None
        best_dist = 0.085
        for ob in sorted_old:
            oid = str(ob["id"])
            if oid in used_old:
                continue
            dist = abs(float(ob["timeSec"]) - nt)
            if dist <= best_dist:
                best_dist = dist
                best_old = ob
        if best_old is not None:
            oid = str(best_old["id"])
            used_old.add(oid)
            if oid in entity_revisions:
                expected_revs[oid] = str(entity_revisions[oid])
            if abs(float(best_old["timeSec"]) - nt) >= 0.0015:
                meaningful_change = True
                upsert_beats.append(
                    {
                        "id": oid,
                        "timeSec": nt,
                        "confidence": conf,
                        "source": "offer",
                    }
                )
        else:
            meaningful_change = True
            upsert_beats.append(
                {
                    "id": f"offer_b_g{generation}_o{opt_idx}_{pos}",
                    "timeSec": nt,
                    "confidence": conf,
                    "source": "offer",
                }
            )

    remove_ids: list[str] = []
    for ob in sorted_old:
        oid = str(ob["id"])
        if oid not in used_old:
            meaningful_change = True
            remove_ids.append(oid)
            if oid in entity_revisions:
                expected_revs[oid] = str(entity_revisions[oid])

    if not meaningful_change:
        return None

    ops: dict = {}
    if upsert_beats:
        ops["upsertBeats"] = upsert_beats
    if remove_ids:
        ops["removeBeatIds"] = remove_ids
    return ops, expected_revs


def _split_by_free_intervals(
    seg_id: str,
    u0: float,
    u1: float,
    seg_regime: str,
    free_intervals: list[tuple[float, float]],
) -> list[dict]:
    """Split an unlocked segment interval [u0, u1) at Free span boundaries so Auto smoothness stays intact outside Free."""
    if seg_regime == "free":
        return [{"segmentId": seg_id, "t0": round(u0, 6), "t1": round(u1, 6), "isFree": True}]

    raw_cuts = [u0, u1]
    for f_lo, f_hi in free_intervals:
        if u0 + 1e-6 < f_lo < u1 - 1e-6:
            raw_cuts.append(f_lo)
        if u0 + 1e-6 < f_hi < u1 - 1e-6:
            raw_cuts.append(f_hi)
    raw_cuts.sort()

    dedup_cuts: list[float] = []
    for c in raw_cuts:
        if not dedup_cuts or c - dedup_cuts[-1] > 1e-6:
            dedup_cuts.append(c)

    slices: list[dict] = []
    for c0, c1 in zip(dedup_cuts[:-1], dedup_cuts[1:]):
        if c1 <= c0 + 1e-4:
            continue
        mid = 0.5 * (c0 + c1)
        sub_free = any(f_lo <= mid < f_hi for f_lo, f_hi in free_intervals)
        slices.append(
            {
                "segmentId": seg_id,
                "t0": round(c0, 6),
                "t1": round(c1, 6),
                "isFree": sub_free,
            }
        )
    return slices


def _coalesce_write_scopes(raw_scopes: list[dict]) -> list[dict]:
    """Merge adjacent solved writeScopes belonging to the same parent segmentId."""
    if not raw_scopes:
        return []
    ordered = sorted(raw_scopes, key=lambda ws: (float(ws["t0"]), float(ws["t1"]), str(ws["segmentId"])))
    merged: list[dict] = [
        {
            "segmentId": str(ordered[0]["segmentId"]),
            "t0": round(float(ordered[0]["t0"]), 6),
            "t1": round(float(ordered[0]["t1"]), 6),
        }
    ]
    for ws in ordered[1:]:
        prev = merged[-1]
        seg_id = str(ws["segmentId"])
        t0 = round(float(ws["t0"]), 6)
        t1 = round(float(ws["t1"]), 6)
        if prev["segmentId"] == seg_id and abs(float(prev["t1"]) - t0) <= 1e-5:
            prev["t1"] = max(float(prev["t1"]), t1)
        else:
            merged.append({"segmentId": seg_id, "t0": t0, "t1": t1})
    return merged


def recompute_constrained(
    track: "TrackEntry",
    scope: dict | str,
    reason: str,
    generation: int,
    basis_seq: int,
    state: dict,
    constraints: dict,
    provider_id: str,
    provider_kind: str,
    cancel_event: threading.Event | None = None,
) -> dict:
    """Student-t soft-cue constrained pulse recompute producing validated PatchOffers."""
    _check_cancel(cancel_event)
    feats = track.get_features()
    duration_sec = track.duration_sec
    if duration_sec <= 0.0 or feats["onset_env"].size == 0:
        return {"offers": []}

    segments = list(state.get("segments") or [])
    if not segments:
        segments = [
            {
                "id": "seg_0",
                "t0": 0.0,
                "t1": duration_sec,
                "regime": "auto",
                "kept": False,
                "source": "draft",
                "revision": 1,
            }
        ]

    req_t0 = 0.0 if scope == "song" else max(0.0, float(scope["t0"]))
    req_t1 = duration_sec if scope == "song" else min(duration_sec, float(scope["t1"]))
    if req_t1 <= req_t0 + 1e-4:
        return {"offers": []}

    keep_locks = [
        (float(lk["t0"]), float(lk["t1"]))
        for lk in (constraints.get("keepLocks") or [])
        if float(lk["t1"]) > float(lk["t0"])
    ]
    free_intervals = [
        (float(fi["t0"]), float(fi["t1"]))
        for fi in (constraints.get("freeIntervals") or [])
        if float(fi["t1"]) > float(fi["t0"])
    ]

    # Build unlocked candidate solve intervals inside non-break, non-kept segment slices,
    # splitting Auto segments at Free span boundaries so smoothness relaxes ONLY inside Free spans!
    solve_intervals: list[dict] = []
    skipped_keep_ranges: list[tuple[float, float]] = []
    for seg in segments:
        st0 = max(req_t0, float(seg["t0"]))
        st1 = min(req_t1, float(seg["t1"]))
        if st1 <= st0 + 1e-4:
            continue
        seg_regime = str(seg.get("regime") or "auto")
        if seg_regime == "break":
            continue
        if seg.get("kept"):
            skipped_keep_ranges.append((st0, st1))
            continue
        overlapping_locks = [
            (max(st0, l0), min(st1, l1))
            for l0, l1 in keep_locks
            if l1 > st0 + 1e-6 and l0 < st1 - 1e-6
        ]
        if overlapping_locks:
            skipped_keep_ranges.extend(overlapping_locks)
        for u0, u1 in _subtract_locks(st0, st1, overlapping_locks):
            for sub in _split_by_free_intervals(str(seg["id"]), u0, u1, seg_regime, free_intervals):
                sub["parentT0"] = float(seg["t0"])
                sub["parentT1"] = float(seg["t1"])
                solve_intervals.append(sub)

    if not solve_intervals:
        return {"offers": []}

    all_beats = list(state.get("beats") or [])
    entity_revisions: dict[str, str] = dict(state.get("entityRevisions") or {})
    guides = list(constraints.get("beatGuides") or [])
    repulsions = list(constraints.get("unbeatRepulsions") or [])
    sound_obs = list(constraints.get("soundObservations") or [])

    actual_hop_s = float(feats["actual_hop_s"])
    onset_env = feats["onset_env"]
    n_frames = onset_env.size
    frame_grid = np.arange(n_frames, dtype=np.float64) * actual_hop_s

    # Normalized family salience envelopes for snapFamily-aware guide attraction.
    low_norm = feats["low_env"] / max(float(np.percentile(feats["low_env"], 98)) if n_frames else 1.0, 1e-9)
    mid_norm = feats["mid_env"] / max(float(np.percentile(feats["mid_env"], 98)) if n_frames else 1.0, 1e-9)
    high_norm = feats["high_env"] / max(float(np.percentile(feats["high_env"], 98)) if n_frames else 1.0, 1e-9)
    family_salience = {
        "bass_synth": np.clip(np.concatenate(([0.0], np.maximum(0.0, np.diff(low_norm)))) * 3.0, 0.0, 1.0),
        "percussion": np.clip(onset_env * 0.7 + np.concatenate(([0.0], np.maximum(0.0, np.diff(high_norm)))) * 1.5, 0.0, 1.0),
        "piano_keys": np.clip(np.concatenate(([0.0], np.maximum(0.0, np.diff(mid_norm)))) * 2.5, 0.0, 1.0),
        "vocal": np.clip(mid_norm, 0.0, 1.0) * 0.5,
        "strings_winds": np.clip(mid_norm * 0.6 + high_norm * 0.4, 0.0, 1.0) * 0.5,
    }

    # Solve pulse per unlocked interval and record ONLY intervals that each hypothesis actually solved!
    primary_beats_all: list[float] = []
    primary_confs_all: list[float] = []
    primary_periods: list[float] = []
    primary_scores: list[float] = []
    primary_raw_scopes: list[dict] = []

    alt_beats_all: list[float] = []
    alt_confs_all: list[float] = []
    alt_periods: list[float] = []
    alt_scores: list[float] = []
    alt_raw_scopes: list[dict] = []
    has_close_alternative = False

    for ws in solve_intervals:
        _check_cancel(cancel_event)
        w0 = float(ws["t0"])
        w1 = float(ws["t1"])
        f0 = max(0, int(math.floor(w0 / actual_hop_s)))
        f1 = min(n_frames, int(math.ceil(w1 / actual_hop_s)) + 1)
        if f1 - f0 < 6:
            continue

        sub_grid = frame_grid[f0:f1]
        sub_onset = onset_env[f0:f1]
        sub_fam = {k: v[f0:f1] for k, v in family_salience.items()}
        ws_guides = [g for g in guides if w0 - 0.1 <= float(g["timeSec"]) <= w1 + 0.1]
        ws_reps = [r for r in repulsions if w0 - 0.1 <= float(r["timeSec"]) <= w1 + 0.1]
        ws_obs = [o for o in sound_obs if w0 - 0.1 <= float(o["timeSec"]) <= w1 + 0.1]
        ws_old_times = [float(b["timeSec"]) for b in all_beats if w0 <= float(b["timeSec"]) < w1]
        if len(ws_old_times) < 2:
            p0 = float(ws.get("parentT0", w0))
            p1 = float(ws.get("parentT1", w1))
            period_hint_times = [float(b["timeSec"]) for b in all_beats if p0 <= float(b["timeSec"]) < p1]
        else:
            period_hint_times = ws_old_times

        pot = _build_cue_potential(sub_grid, sub_onset, ws_guides, ws_reps, ws_obs, sub_fam)
        is_free = bool(ws["isFree"])

        periods = _candidate_periods(sub_onset, actual_hop_s, period_hint_times, ws_guides)
        hyps: list[dict] = []
        for p_sec in periods:
            solved = _solve_pulse_for_period(w0, w1, sub_grid, pot, sub_onset, p_sec, ws_guides, ws_reps, is_free)
            if solved is not None:
                hyps.append(solved)

        if not hyps:
            continue
        hyps.sort(key=lambda h: -h["score"])
        best = hyps[0]

        # Also check off-beat phase competitor at best period.
        alt_phase = _solve_alternate_phase(
            w0, w1, sub_grid, pot, best["beatTimes"], best["periodSec"], ws_guides, ws_reps
        )
        if alt_phase is not None:
            hyps.append(alt_phase)
            hyps.sort(key=lambda h: -h["score"])
            best = hyps[0]

        scope_slice = {"segmentId": str(ws["segmentId"]), "t0": round(w0, 6), "t1": round(w1, 6)}
        primary_beats_all.extend(best["beatTimes"])
        primary_confs_all.extend(best["confidences"])
        primary_periods.append(best["periodSec"])
        primary_scores.append(best["score"])
        primary_raw_scopes.append(scope_slice)

        # Pick best distinct musical alternative (either half/double tempo or alternate phase) if within competitive range.
        chosen_alt = None
        best_arr = np.asarray(best["beatTimes"], dtype=np.float64)
        for cand in hyps[1:]:
            cand_arr = np.asarray(cand["beatTimes"], dtype=np.float64)
            # Check that cand actually differs meaningfully from best!
            tempo_diff = abs(cand["periodSec"] - best["periodSec"]) / max(cand["periodSec"], best["periodSec"])
            mean_nearest = float(np.mean([np.min(np.abs(best_arr - ct)) for ct in cand_arr]))
            if tempo_diff > 0.15 or mean_nearest > 0.045:
                # Competitive if score is within 45% of best (or positive when best is modest).
                if cand["score"] >= best["score"] - max(0.35, 0.42 * abs(best["score"])):
                    chosen_alt = cand
                    break

        if chosen_alt is not None:
            has_close_alternative = True
            alt_beats_all.extend(chosen_alt["beatTimes"])
            alt_confs_all.extend(chosen_alt["confidences"])
            alt_periods.append(chosen_alt["periodSec"])
            alt_scores.append(chosen_alt["score"])
            alt_raw_scopes.append(scope_slice)
        else:
            alt_beats_all.extend(best["beatTimes"])
            alt_confs_all.extend(best["confidences"])
            alt_periods.append(best["periodSec"])
            alt_scores.append(best["score"])
            alt_raw_scopes.append(scope_slice)

    if not primary_beats_all or not primary_raw_scopes:
        return {"offers": []}

    prim_write_scopes = _coalesce_write_scopes(primary_raw_scopes)
    prim_scope_beats = [
        b
        for b in all_beats
        if any(float(ws["t0"]) <= float(b["timeSec"]) < float(ws["t1"]) for ws in prim_write_scopes)
    ]
    prim_expected_scope_beat_ids = sorted(str(b["id"]) for b in prim_scope_beats)

    # Check passive advisory notes (e.g. outlier mistap saturation or adjacent Keep offset).
    advisories: list[str] = []
    prim_arr = np.asarray(primary_beats_all, dtype=np.float64)
    for g in guides:
        gt = float(g["timeSec"])
        if any(float(ws["t0"]) <= gt < float(ws["t1"]) for ws in prim_write_scopes):
            dist_ms = float(np.min(np.abs(prim_arr - gt))) * 1000.0
            if dist_ms > 35.0:
                advisories.append(
                    f"Treated isolated tap near {_format_timecode(gt)} ({int(round(dist_ms))} ms off pulse) as a soft outlier."
                )
                break

    if skipped_keep_ranges:
        k0, k1 = skipped_keep_ranges[0]
        locked_beats = sorted(
            float(b["timeSec"]) for b in all_beats if k0 <= float(b["timeSec"]) < k1
        )
        if locked_beats and prim_arr.size >= 2:
            med_p = float(np.median(primary_periods)) if primary_periods else 0.5
            # Estimate phase offset at boundary against locked beats.
            ref_b = prim_arr[0]
            offsets_ms = [
                (((lb - ref_b + 0.5 * med_p) % med_p) - 0.5 * med_p) * 1000.0
                for lb in locked_beats[:6]
            ]
            off_ms = int(round(float(np.median(offsets_ms))))
            if abs(off_ms) >= 5:
                sign = "+" if off_ms > 0 else ""
                advisories.append(
                    f"Preserves locked Keep section at {_format_timecode(k0)}–{_format_timecode(k1)} untouched ({sign}{off_ms} ms offset noted)."
                )
            else:
                advisories.append(
                    f"Preserves locked Keep section at {_format_timecode(k0)}–{_format_timecode(k1)} without changes."
                )

    read_scope = "song" if scope == "song" else {"t0": round(req_t0, 6), "t1": round(req_t1, 6)}
    batch_id = f"batch_g{generation}_s{basis_seq}"

    primary_hyp = {
        "beatTimes": primary_beats_all,
        "confidences": primary_confs_all,
        "periodSec": float(np.median(primary_periods)),
        "bpm": round(60.0 / max(float(np.median(primary_periods)), 1e-4), 1),
    }
    prim_built = _build_ops_for_hypothesis(
        primary_hyp, prim_scope_beats, entity_revisions, generation, 1, prim_write_scopes
    )
    prim_scope_kind = (
        "cross_region"
        if scope == "song" or len({ws["segmentId"] for ws in prim_write_scopes}) > 1
        else "local"
    )

    alt_built = None
    alt_hyp = None
    alt_write_scopes: list[dict] = []
    alt_scope_beats: list[dict] = []
    alt_expected_scope_beat_ids: list[str] = []
    alt_scope_kind = prim_scope_kind
    if has_close_alternative and alt_beats_all and alt_raw_scopes:
        alt_write_scopes = _coalesce_write_scopes(alt_raw_scopes)
        alt_scope_beats = [
            b
            for b in all_beats
            if any(float(ws["t0"]) <= float(b["timeSec"]) < float(ws["t1"]) for ws in alt_write_scopes)
        ]
        alt_expected_scope_beat_ids = sorted(str(b["id"]) for b in alt_scope_beats)
        alt_scope_kind = (
            "cross_region"
            if scope == "song" or len({ws["segmentId"] for ws in alt_write_scopes}) > 1
            else "local"
        )
        alt_hyp = {
            "beatTimes": alt_beats_all,
            "confidences": alt_confs_all,
            "periodSec": float(np.median(alt_periods)),
            "bpm": round(60.0 / max(float(np.median(alt_periods)), 1e-4), 1),
        }
        alt_built = _build_ops_for_hypothesis(
            alt_hyp, alt_scope_beats, entity_revisions, generation, 2, alt_write_scopes
        )

    offers: list[dict] = []
    if prim_built is not None and alt_built is not None and alt_hyp is not None:
        prim_ops, prim_revs = prim_built
        alt_ops, alt_revs = alt_built
        prim_title = _describe_hypothesis_title(primary_hyp, prim_scope_beats, "primary")
        alt_title = _describe_hypothesis_title(alt_hyp, alt_scope_beats, "alternate")
        if alt_title == prim_title:
            alt_title = f"Alternate phase alignment ({int(round(alt_hyp['bpm']))} BPM)"

        offers.append(
            {
                "id": f"offer_g{generation}_s{basis_seq}_1",
                "batchId": batch_id,
                "providerId": provider_id,
                "providerKind": provider_kind,
                "generation": generation,
                "basisSeq": basis_seq,
                "expectedRevisions": prim_revs,
                "expectedScopeBeatIds": prim_expected_scope_beat_ids,
                "writeScopes": prim_write_scopes,
                "readScope": read_scope,
                "scopeKind": prim_scope_kind,
                "optionIndex": 1,
                "optionCount": 2,
                "title": prim_title,
                "advisoryNotes": advisories,
                "ops": prim_ops,
            }
        )
        offers.append(
            {
                "id": f"offer_g{generation}_s{basis_seq}_2",
                "batchId": batch_id,
                "providerId": provider_id,
                "providerKind": provider_kind,
                "generation": generation,
                "basisSeq": basis_seq,
                "expectedRevisions": alt_revs,
                "expectedScopeBeatIds": alt_expected_scope_beat_ids,
                "writeScopes": alt_write_scopes,
                "readScope": read_scope,
                "scopeKind": alt_scope_kind,
                "optionIndex": 2,
                "optionCount": 2,
                "title": alt_title,
                "advisoryNotes": advisories,
                "ops": alt_ops,
            }
        )
    elif prim_built is not None:
        prim_ops, prim_revs = prim_built
        offers.append(
            {
                "id": f"offer_g{generation}_s{basis_seq}_1",
                "batchId": batch_id,
                "providerId": provider_id,
                "providerKind": provider_kind,
                "generation": generation,
                "basisSeq": basis_seq,
                "expectedRevisions": prim_revs,
                "expectedScopeBeatIds": prim_expected_scope_beat_ids,
                "writeScopes": prim_write_scopes,
                "readScope": read_scope,
                "scopeKind": prim_scope_kind,
                "title": _describe_hypothesis_title(primary_hyp, prim_scope_beats, "primary"),
                "advisoryNotes": advisories,
                "ops": prim_ops,
            }
        )
    elif alt_built is not None and alt_hyp is not None:
        alt_ops, alt_revs = alt_built
        offers.append(
            {
                "id": f"offer_g{generation}_s{basis_seq}_1",
                "batchId": batch_id,
                "providerId": provider_id,
                "providerKind": provider_kind,
                "generation": generation,
                "basisSeq": basis_seq,
                "expectedRevisions": alt_revs,
                "expectedScopeBeatIds": alt_expected_scope_beat_ids,
                "writeScopes": alt_write_scopes,
                "readScope": read_scope,
                "scopeKind": alt_scope_kind,
                "title": _describe_hypothesis_title(alt_hyp, alt_scope_beats, "alternate"),
                "advisoryNotes": advisories,
                "ops": alt_ops,
            }
        )

    return {"batchId": batch_id, "offers": offers}


# ---------------------------------------------------------------- Zero-Phase Stereo Audition & Clip Export


def band_views_all(
    pcm: np.ndarray,
    sample_rate: int,
    order: int = 4,
    cancel_event: threading.Event | None = None,
) -> dict[str, np.ndarray]:
    """Compute all three zero-phase FFT band views ('low', 'mid', 'high') in float32 from one rfft."""
    length = pcm.shape[0]
    if length == 0:
        empty = pcm.astype(np.float32, copy=True)
        return {"low": empty, "mid": empty.copy(), "high": empty.copy()}
    _check_cancel(cancel_event)
    pad = max(1024, int(round(0.25 * sample_rate)))
    n_fft = 1 << (length + 2 * pad - 1).bit_length()
    freqs = np.fft.rfftfreq(n_fft, 1.0 / sample_rate)
    lp_low = 1.0 / (1.0 + (freqs / LOW_HZ) ** (2 * order))
    lp_high = 1.0 / (1.0 + (freqs / HIGH_HZ) ** (2 * order))
    with np.errstate(divide="ignore"):
        hp_low = 1.0 / (1.0 + (LOW_HZ / freqs) ** (2 * order))
        hp_high = 1.0 / (1.0 + (HIGH_HZ / freqs) ** (2 * order))
    gains = {
        "low": lp_low,
        "mid": hp_low * lp_high,
        "high": hp_high,
    }
    spec = np.fft.rfft(pcm.astype(np.float64, copy=False), n=n_fft, axis=0)
    out: dict[str, np.ndarray] = {}
    for name, gain in gains.items():
        _check_cancel(cancel_event)
        arr = np.fft.irfft(spec * gain[:, None], n=n_fft, axis=0)[:length].astype(np.float32)
        arr.setflags(write=False)
        out[name] = arr
    return out


def band_view(pcm: np.ndarray, sample_rate: int, view: str, order: int = 4) -> np.ndarray:
    """Zero-phase Butterworth-squared frequency response on linear zero-padded FFT (no edge wrap)."""
    length = pcm.shape[0]
    if length == 0:
        return pcm.astype(np.float64, copy=True)
    pad = max(1024, int(round(0.25 * sample_rate)))
    n_fft = 1 << (length + 2 * pad - 1).bit_length()
    freqs = np.fft.rfftfreq(n_fft, 1.0 / sample_rate)
    lowpass = lambda cutoff: 1.0 / (1.0 + (freqs / cutoff) ** (2 * order))  # noqa: E731
    with np.errstate(divide="ignore"):
        highpass = lambda cutoff: 1.0 / (1.0 + (cutoff / freqs) ** (2 * order))  # noqa: E731
        gain = {
            "low": lambda: lowpass(LOW_HZ),
            "mid": lambda: highpass(LOW_HZ) * lowpass(HIGH_HZ),
            "high": lambda: highpass(HIGH_HZ),
        }[view]()
    filtered = np.fft.irfft(np.fft.rfft(pcm, n=n_fft, axis=0) * gain[:, None], n=n_fft, axis=0)
    return filtered[:length]


def _median(values: np.ndarray, kernel: int, axis: int, rows: int = 96) -> np.ndarray:
    """Running median along axis of a 2-D array, safe for short (< kernel) clips."""
    if values.size == 0:
        return values.copy()
    work = np.moveaxis(values, axis, 1).astype(np.float32)
    length = work.shape[1]
    if length <= 1 or kernel <= 1:
        return np.moveaxis(work, 1, axis)
    half = min(kernel // 2, length - 1)
    eff_kernel = 2 * half + 1
    pad_mode = "reflect" if length > half else "edge"
    padded = np.pad(work, ((0, 0), (half, half)), mode=pad_mode)
    out = np.empty_like(work)
    for first in range(0, work.shape[0], rows):
        block = sliding_window_view(padded[first : first + rows], eff_kernel, axis=1)
        out[first : first + rows] = np.median(block, axis=-1)
    return np.moveaxis(out, 1, axis)


def hpss_views_both(
    pcm: np.ndarray,
    sample_rate: int,
    kernel: int = 17,
    cancel_event: threading.Event | None = None,
) -> dict[str, np.ndarray]:
    """Compute both 'percussive' and 'harmonic' float32 views from one STFT + median pass per channel."""
    if pcm.shape[0] == 0:
        empty = pcm.astype(np.float32, copy=True)
        return {"percussive": empty, "harmonic": empty.copy()}
    n_fft = 2048 if sample_rate > 32000 else 1024
    hop = n_fft // 4
    window = np.hanning(n_fft)
    win_sq = window**2
    n_samples, n_channels = pcm.shape
    out_perc = np.zeros((n_samples, n_channels), dtype=np.float32)
    out_harm = np.zeros((n_samples, n_channels), dtype=np.float32)
    pcm_f64 = pcm.astype(np.float64, copy=False)

    padded_len = n_samples + 2 * n_fft + hop
    frame_count = 1 + max(0, (padded_len - n_fft) // hop)
    weight = np.zeros(padded_len, dtype=np.float64)
    for index in range(frame_count):
        start = index * hop
        weight[start : start + n_fft] += win_sq
    denom_weight = np.maximum(weight, 1e-8)

    for channel in range(n_channels):
        _check_cancel(cancel_event)
        padded = np.pad(pcm_f64[:, channel], (n_fft, n_fft + hop))
        frames = sliding_window_view(padded, n_fft)[::hop]
        spec = np.fft.rfft(frames * window, axis=1)
        _check_cancel(cancel_event)
        magnitude = np.abs(spec)
        harmonic = _median(magnitude, kernel, axis=0)
        _check_cancel(cancel_event)
        percussive = _median(magnitude, kernel, axis=1)
        _check_cancel(cancel_event)

        h2 = harmonic**2
        p2 = percussive**2
        mask_perc = p2 / (p2 + h2 + 1e-12)
        mask_harm = h2 / (h2 + p2 + 1e-12)

        for dst, mask in ((out_perc, mask_perc), (out_harm, mask_harm)):
            _check_cancel(cancel_event)
            pieces = np.fft.irfft(spec * mask, n=n_fft, axis=1) * window
            signal = np.zeros(padded.size, dtype=np.float64)
            for index, piece in enumerate(pieces):
                start = index * hop
                signal[start : start + n_fft] += piece
            restored = signal / denom_weight
            dst[:, channel] = restored[n_fft : n_fft + n_samples].astype(np.float32)

    out_perc.setflags(write=False)
    out_harm.setflags(write=False)
    return {"percussive": out_perc, "harmonic": out_harm}


def hpss_view(pcm: np.ndarray, sample_rate: int, view: str, kernel: int = 17) -> np.ndarray:
    """Fitzgerald soft-mask HPSS on Hann STFT at 75% overlap per channel; preserves exact length & phase."""
    if pcm.shape[0] == 0:
        return pcm.astype(np.float64, copy=True)
    n_fft = 2048 if sample_rate > 32000 else 1024
    hop = n_fft // 4
    window = np.hanning(n_fft)
    out = np.zeros_like(pcm, dtype=np.float64)
    for channel in range(pcm.shape[1]):
        padded = np.pad(pcm[:, channel], (n_fft, n_fft + hop))
        frames = sliding_window_view(padded, n_fft)[::hop]
        spec = np.fft.rfft(frames * window, axis=1)
        magnitude = np.abs(spec)
        harmonic = _median(magnitude, kernel, axis=0)
        percussive = _median(magnitude, kernel, axis=1)
        keep, other = (percussive, harmonic) if view == "percussive" else (harmonic, percussive)
        mask = keep**2 / (keep**2 + other**2 + 1e-12)
        pieces = np.fft.irfft(spec * mask, n=n_fft, axis=1) * window
        signal = np.zeros(padded.size, dtype=np.float64)
        weight = np.zeros(padded.size, dtype=np.float64)
        for index, piece in enumerate(pieces):
            start = index * hop
            signal[start : start + n_fft] += piece
            weight[start : start + n_fft] += window**2
        restored = signal / np.maximum(weight, 1e-8)
        out[:, channel] = restored[n_fft : n_fft + pcm.shape[0]]
    return out


def audition_view(pcm: np.ndarray, sample_rate: int, view: str) -> np.ndarray:
    if view == "mix":
        return pcm.astype(np.float64)
    if view in ("low", "mid", "high"):
        return band_view(pcm.astype(np.float64), sample_rate, view)
    if view in ("percussive", "harmonic"):
        return hpss_view(pcm.astype(np.float64), sample_rate, view)
    raise ValueError(f"Unknown audition filter '{view}'; expected one of {AUDITION_FILTERS}")


def encode_wav_bytes(samples: np.ndarray, sample_rate: int) -> bytes:
    pcm16 = (np.clip(samples, -1.0, 1.0) * 32767.0).round().astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as handle:
        handle.setnchannels(samples.shape[1])
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(pcm16.tobytes())
    return buf.getvalue()


def write_wav_atomic(path: str | Path, samples: np.ndarray, sample_rate: int) -> str:
    target = Path(path).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.parent / f".{target.name}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp.wav"
    wav_bytes = encode_wav_bytes(samples, sample_rate)
    try:
        tmp.write_bytes(wav_bytes)
        os.replace(tmp, target)
    except Exception:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass
        raise
    return str(target)


# ---------------------------------------------------------------- Bounded LRU Cache & Warm Daemon


@dataclass
class TrackEntry:
    path: str
    mtime_ns: int
    size_bytes: int
    sample_rate: int
    channels: int
    duration_sec: float
    pcm: np.ndarray
    mono_analysis: np.ndarray
    analysis_sr: int
    ctime_ns: int = 0
    ino: int = 0
    audio_sha256: str | None = None
    cache_key: tuple = ()
    feature_lock: threading.Lock = field(default_factory=threading.Lock)
    _features: dict | None = None

    @property
    def mono_native(self) -> np.ndarray:
        if self.channels == 1:
            return self.pcm[:, 0]
        return self.pcm.mean(axis=1, dtype=np.float32)

    def get_features(self) -> dict:
        if self._features is not None:
            return self._features
        with self.feature_lock:
            if self._features is None:
                self._features = compute_track_features(
                    self.mono_analysis, self.analysis_sr, self.duration_sec
                )
            return self._features


@dataclass
class _InflightLoad:
    event: threading.Event = field(default_factory=threading.Event)
    entry: TrackEntry | None = None
    error: Exception | None = None


class TrackCache:
    """Thread-safe bounded LRU track PCM cache (max_cached_tracks = 3)."""

    def __init__(self, max_tracks: int = MAX_CACHED_TRACKS) -> None:
        self.max_tracks = max(1, int(max_tracks))
        self._lock = threading.Lock()
        self._entries: OrderedDict[tuple, TrackEntry] = OrderedDict()
        self._inflight: dict[tuple, _InflightLoad] = {}

    @staticmethod
    def _make_key(
        resolved: Path,
        st: os.stat_result,
        audio_sha256: str | None = None,
    ) -> tuple:
        norm_sha = str(audio_sha256).strip().lower() if audio_sha256 else ""
        if norm_sha:
            return (str(resolved), norm_sha)
        return (str(resolved), st.st_size, st.st_mtime_ns, st.st_ctime_ns, st.st_ino)

    def __len__(self) -> int:
        with self._lock:
            return len(self._entries)

    def cached_paths(self) -> list[str]:
        with self._lock:
            return [entry.path for entry in self._entries.values()]

    def peek(
        self,
        audio_path: str | Path,
        audio_sha256: str | None = None,
    ) -> TrackEntry | None:
        resolved = Path(audio_path).resolve()
        try:
            st = resolved.stat()
        except OSError:
            return None
        key = self._make_key(resolved, st, audio_sha256)
        with self._lock:
            entry = self._entries.get(key)
            if entry is not None:
                self._entries.move_to_end(key)
            return entry

    def get_or_load(
        self,
        audio_path: str | Path,
        cancel_event: threading.Event | None = None,
        audio_sha256: str | None = None,
    ) -> TrackEntry:
        _check_cancel(cancel_event)
        resolved = Path(audio_path).resolve()
        st = resolved.stat()
        norm_sha = str(audio_sha256).strip().lower() if audio_sha256 else None
        key = self._make_key(resolved, st, norm_sha)

        while True:
            with self._lock:
                existing = self._entries.get(key)
                if existing is not None:
                    self._entries.move_to_end(key)
                    return existing
                inflight = self._inflight.get(key)
                if inflight is None:
                    inflight = _InflightLoad()
                    self._inflight[key] = inflight
                    is_loader = True
                else:
                    is_loader = False

            if not is_loader:
                while not inflight.event.wait(timeout=0.05):
                    _check_cancel(cancel_event)
                if inflight.entry is not None:
                    with self._lock:
                        if key in self._entries:
                            self._entries.move_to_end(key)
                    return inflight.entry
                if inflight.error is not None and not isinstance(inflight.error, CancelledError):
                    raise inflight.error
                continue

            try:
                info = probe(resolved)
                _check_cancel(cancel_event)
                pcm = decode(resolved, info["channels"])
                _check_cancel(cancel_event)
                sr = int(info["sampleRate"])
                ch = int(info["channels"])
                duration_sec = pcm.shape[0] / float(sr) if pcm.shape[0] > 0 else float(info["durationS"])
                mono_nat = pcm[:, 0] if ch == 1 else pcm.mean(axis=1, dtype=np.float32)
                mono_an, an_sr = _decimate_analysis_mono(mono_nat, sr)
                entry = TrackEntry(
                    path=str(resolved),
                    mtime_ns=st.st_mtime_ns,
                    size_bytes=st.st_size,
                    sample_rate=sr,
                    channels=ch,
                    duration_sec=duration_sec,
                    pcm=pcm,
                    mono_analysis=mono_an,
                    analysis_sr=an_sr,
                    ctime_ns=st.st_ctime_ns,
                    ino=st.st_ino,
                    audio_sha256=norm_sha,
                    cache_key=key,
                )
                with self._lock:
                    self._entries[key] = entry
                    self._entries.move_to_end(key)
                    while len(self._entries) > self.max_tracks:
                        self._entries.popitem(last=False)
                    self._inflight.pop(key, None)
                    inflight.entry = entry
                    inflight.event.set()
                return entry
            except Exception as exc:
                with self._lock:
                    self._inflight.pop(key, None)
                    inflight.error = exc
                    inflight.event.set()
                raise


@dataclass
class _InflightAuditionGroup:
    event: threading.Event = field(default_factory=threading.Event)
    views: dict[str, np.ndarray] | None = None
    error: Exception | None = None


class AuditionWindowCache:
    """Thread-safe bounded 2-window filter slice cache reusing HPSS and FFT band decompositions."""

    def __init__(self, max_windows: int = MAX_AUDITION_WINDOW_CACHE) -> None:
        self.max_windows = max(1, int(max_windows))
        self._lock = threading.Lock()
        self._entries: OrderedDict[tuple, dict[str, np.ndarray]] = OrderedDict()
        self._inflight: dict[tuple, _InflightAuditionGroup] = {}

    def __len__(self) -> int:
        with self._lock:
            return len(self._entries)

    def keys(self) -> list[tuple]:
        with self._lock:
            return list(self._entries.keys())

    def get_or_compute(
        self,
        win_key: tuple,
        sub_pcm: np.ndarray,
        sample_rate: int,
        filter_name: str,
        cancel_event: threading.Event | None = None,
    ) -> np.ndarray:
        _check_cancel(cancel_event)
        group = "hpss" if filter_name in ("percussive", "harmonic") else "band"
        inflight_key = (win_key, group)

        while True:
            with self._lock:
                existing_win = self._entries.get(win_key)
                if existing_win is not None:
                    self._entries.move_to_end(win_key)
                    cached_arr = existing_win.get(filter_name)
                    if cached_arr is not None:
                        return cached_arr
                inflight = self._inflight.get(inflight_key)
                if inflight is None:
                    inflight = _InflightAuditionGroup()
                    self._inflight[inflight_key] = inflight
                    is_worker = True
                else:
                    is_worker = False

            if not is_worker:
                while not inflight.event.wait(timeout=0.05):
                    _check_cancel(cancel_event)
                if inflight.views is not None and filter_name in inflight.views:
                    with self._lock:
                        if win_key in self._entries:
                            self._entries.move_to_end(win_key)
                    return inflight.views[filter_name]
                if inflight.error is not None and not isinstance(inflight.error, CancelledError):
                    raise inflight.error
                continue

            try:
                if group == "hpss":
                    computed = hpss_views_both(sub_pcm, sample_rate, cancel_event=cancel_event)
                else:
                    computed = band_views_all(sub_pcm, sample_rate, cancel_event=cancel_event)
                _check_cancel(cancel_event)
                with self._lock:
                    bucket = self._entries.get(win_key)
                    if bucket is None:
                        bucket = {}
                        self._entries[win_key] = bucket
                    bucket.update(computed)
                    self._entries.move_to_end(win_key)
                    while len(self._entries) > self.max_windows:
                        self._entries.popitem(last=False)
                    self._inflight.pop(inflight_key, None)
                    inflight.views = computed
                    inflight.event.set()
                return computed[filter_name]
            except Exception as exc:
                with self._lock:
                    self._inflight.pop(inflight_key, None)
                    inflight.error = exc
                    inflight.event.set()
                raise


class TempoEngine:
    """Stateful warm engine holding bounded PCM LRU cache and optional BeatThis checkpoint."""

    def __init__(
        self,
        max_cached_tracks: int = MAX_CACHED_TRACKS,
        backend: str | None = None,
        checkpoint_name: str | None = None,
        device: str | None = None,
        max_audition_windows: int = MAX_AUDITION_WINDOW_CACHE,
    ) -> None:
        self.cache = TrackCache(max_tracks=max_cached_tracks)
        self._track_cache = self.cache
        self.audition_window_cache = AuditionWindowCache(max_windows=max_audition_windows)
        self._audition_window_cache = self.audition_window_cache
        self.backend = (backend or os.environ.get("TEMPO_ANALYZER_BACKEND") or "auto").strip().lower()
        self.checkpoint_name = checkpoint_name or os.environ.get("ENSOMI_BEATTHIS_CHECKPOINT", "final0")
        self.requested_device = device or os.environ.get("ENSOMI_BEATTHIS_DEVICE")
        self._model_lock = threading.Lock()
        self._beatthis_model = None
        self._beatthis_device: str | None = None
        self._beatthis_checked = False
        self._beatthis_available = False

    def _resolve_beatthis(self):
        if self.backend == "dsp":
            return None, None
        with self._model_lock:
            if self._beatthis_checked:
                return self._beatthis_model, self._beatthis_device
            self._beatthis_checked = True
            try:
                import torch
                from beat_this.inference import Audio2Frames

                ckpt_path: str | None = None
                cand = Path(self.checkpoint_name)
                if cand.is_file():
                    ckpt_path = str(cand.resolve())
                else:
                    hub_ckpt = Path(torch.hub.get_dir()) / "checkpoints" / f"beat_this-{self.checkpoint_name}.ckpt"
                    if hub_ckpt.is_file():
                        ckpt_path = str(hub_ckpt)
                if ckpt_path is None:
                    return None, None

                dev = self.requested_device or ("mps" if torch.backends.mps.is_available() else "cpu")
                self._beatthis_model = Audio2Frames(checkpoint_path=ckpt_path, device=dev, float16=False)
                self._beatthis_device = dev
                self._beatthis_available = True
                return self._beatthis_model, self._beatthis_device
            except Exception:
                self._beatthis_model = None
                self._beatthis_available = False
                return None, None

    def provider_kind(self) -> str:
        if self.backend == "dsp":
            return "rule"
        model, _ = self._resolve_beatthis()
        return "model" if model is not None else "rule"

    def prepare(
        self,
        audio_path: str | Path,
        cancel_event: threading.Event | None = None,
        audio_sha256: str | None = None,
    ) -> dict:
        entry = self.cache.get_or_load(
            audio_path, cancel_event=cancel_event, audio_sha256=audio_sha256
        )
        return {
            "audioPath": entry.path,
            "durationSec": round(entry.duration_sec, 6),
            "sampleRate": entry.sample_rate,
            "channels": entry.channels,
            "providerKind": "rule" if self.backend == "dsp" else self.provider_kind(),
        }

    def analyze(
        self,
        audio_path: str | Path,
        use_beatthis: bool | None = None,
        cancel_event: threading.Event | None = None,
        audio_sha256: str | None = None,
    ) -> dict:
        started = time.perf_counter()
        entry = self.cache.get_or_load(
            audio_path, cancel_event=cancel_event, audio_sha256=audio_sha256
        )
        _check_cancel(cancel_event)
        feats = entry.get_features()
        _check_cancel(cancel_event)

        allow_bt = (self.backend != "dsp") if use_beatthis is None else (bool(use_beatthis) and self.backend != "dsp")
        beats: list[dict] | None = None
        used_kind = "rule"

        if allow_bt:
            model, _ = self._resolve_beatthis()
            if model is not None:
                try:
                    import torch

                    with self._model_lock, torch.inference_mode():
                        _check_cancel(cancel_event)
                        beat_logits, _ = model(entry.mono_native, entry.sample_rate)
                        logits_np = beat_logits.detach().cpu().numpy()
                    beats = pick_beats(logits_np, fps=BEATTHIS_FPS, duration_sec=entry.duration_sec)
                    used_kind = "model"
                except CancelledError:
                    raise
                except Exception:
                    beats = None

        if beats is None:
            beats = dsp_pulse_beats(
                entry.mono_analysis,
                entry.analysis_sr,
                entry.duration_sec,
                precomputed=feats,
            )
            used_kind = "rule"

        _check_cancel(cancel_event)
        segments = auto_segment_track(beats, entry.duration_sec)
        return {
            "audioPath": entry.path,
            "durationSec": round(entry.duration_sec, 6),
            "sampleRate": entry.sample_rate,
            "channels": entry.channels,
            "providerKind": used_kind,
            "segments": segments,
            "beats": beats,
            "sounds": feats["sounds"],
            "elapsedSec": round(time.perf_counter() - started, 4),
        }

    def suggest_snaps(
        self,
        audio_path: str | Path,
        time_sec: float,
        window_sec: float = 0.12,
        cancel_event: threading.Event | None = None,
        audio_sha256: str | None = None,
    ) -> dict:
        """Dedicated CPU fast-path over cached PCM (or localized window decode if uncached)."""
        started = time.perf_counter()
        _check_cancel(cancel_event)
        entry = self.cache.peek(audio_path, audio_sha256=audio_sha256)
        if entry is not None:
            candidates = suggest_snaps_cpu(
                entry.pcm,
                entry.sample_rate,
                time_sec=float(time_sec),
                window_sec=float(window_sec),
                cancel_event=cancel_event,
            )
        else:
            # Fast localized window decode if track has not finished full caching yet.
            info = probe(audio_path)
            sr = int(info["sampleRate"])
            ch = int(info["channels"])
            dur = float(info["durationS"])
            win = float(np.clip(window_sec, 0.02, 1.5))
            q_sec = float(np.clip(time_sec, 0.0, dur))
            lead = max(0.0, q_sec - win - 0.16)
            span = min(dur - lead, 2.0 * (win + 0.16))
            sub_pcm = decode(audio_path, ch, start_s=lead, duration_s=span)
            local_cands = suggest_snaps_cpu(
                sub_pcm,
                sr,
                time_sec=q_sec - lead,
                window_sec=win,
                cancel_event=cancel_event,
            )
            candidates = []
            for c in local_cands:
                abs_t = round(min(dur, max(0.0, float(c["targetSec"]) + lead)), 6)
                tag_us = int(round(abs_t * 10000.0))
                candidates.append(
                    {
                        **c,
                        "eventId": f"snap_{c['role']}_{tag_us}",
                        "targetSec": abs_t,
                        "deltaMs": round((abs_t - q_sec) * 1000.0, 2),
                    }
                )
        return {
            "candidates": candidates,
            "elapsedMs": round((time.perf_counter() - started) * 1000.0, 3),
        }

    def recompute(
        self,
        params: dict,
        cancel_event: threading.Event | None = None,
    ) -> dict:
        started = time.perf_counter()
        audio_sha = params.get("audioSha256") or params.get("audio_sha256")
        entry = self.cache.get_or_load(
            params["audioPath"],
            cancel_event=cancel_event,
            audio_sha256=str(audio_sha) if audio_sha else None,
        )
        res = recompute_constrained(
            track=entry,
            scope=params.get("scope", "song"),
            reason=str(params.get("reason", "User requested recompute")),
            generation=int(params.get("generation", 1)),
            basis_seq=int(params.get("basisSeq", 0)),
            state=dict(params.get("state") or {}),
            constraints=dict(params.get("constraints") or {}),
            provider_id=str(params.get("providerId", "ensomi-tempo-daemon")),
            provider_kind=str(params.get("providerKind") or self.provider_kind()),
            cancel_event=cancel_event,
        )
        res["elapsedMs"] = round((time.perf_counter() - started) * 1000.0, 3)
        return res

    def render_span_wav(
        self,
        audio_path: str | Path,
        start_s: float,
        end_s: float,
        filter_name: str,
        output_path: str | Path | None = None,
        cancel_event: threading.Event | None = None,
        audio_sha256: str | None = None,
    ) -> dict:
        started = time.perf_counter()
        if filter_name not in AUDITION_FILTERS:
            raise ValueError(f"Unknown audition filter '{filter_name}'; expected one of {AUDITION_FILTERS}")

        _check_cancel(cancel_event)
        entry = self.cache.get_or_load(
            audio_path, cancel_event=cancel_event, audio_sha256=audio_sha256
        )
        sr = int(entry.sample_rate)
        ch = int(entry.channels)
        total_samples = int(entry.pcm.shape[0])
        if total_samples <= 0:
            raise ValueError(f"Empty audio file: {audio_path}")

        start_sample = max(0, min(total_samples, int(round(max(0.0, float(start_s)) * sr))))
        end_sample = max(0, min(total_samples, int(round(max(0.0, float(end_s)) * sr))))
        if end_sample <= start_sample:
            raise ValueError(f"Empty span {start_s}-{end_s}")

        pad_samples = int(round(AUDITION_PAD_S * sr))
        i0 = max(0, start_sample - pad_samples)
        i1 = min(total_samples, end_sample + pad_samples)
        sub_pcm = entry.pcm[i0:i1]
        actual_lead_samples = start_sample - i0
        exact_count = end_sample - start_sample

        _check_cancel(cancel_event)
        if filter_name == "mix":
            trimmed = entry.pcm[start_sample:end_sample]
        else:
            track_key = entry.cache_key or (entry.path, entry.size_bytes, entry.mtime_ns)
            win_key = (track_key, i0, i1, sr)
            rendered = self.audition_window_cache.get_or_compute(
                win_key,
                sub_pcm,
                sr,
                filter_name,
                cancel_event=cancel_event,
            )
            _check_cancel(cancel_event)
            trimmed = rendered[actual_lead_samples : actual_lead_samples + exact_count]
        base_meta = {
            "filter": filter_name,
            "startSec": round(start_sample / float(sr), 9),
            "endSec": round(end_sample / float(sr), 9),
            "startSample": int(start_sample),
            "endSample": int(end_sample),
            "sampleRate": sr,
            "channels": ch,
            "elapsedSec": round(time.perf_counter() - started, 4),
        }
        if output_path is None or (isinstance(output_path, str) and not output_path.strip()):
            wav_bytes = encode_wav_bytes(trimmed, sr)
            return {
                "wavBase64": base64.b64encode(wav_bytes).decode("ascii"),
                **base_meta,
            }
        written = write_wav_atomic(output_path, trimmed, sr)
        return {
            "outputPath": written,
            **base_meta,
        }


# ---------------------------------------------------------------- Persistent NDJSON Stdio Server


class DaemonServer:
    """Persistent NDJSON JSON-RPC server with isolated snap_pool, audition_pool, fast_pool, and heavy_pool."""

    def __init__(self, engine: TempoEngine | None = None) -> None:
        self.engine = engine or TempoEngine()
        self._snap_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="tempo-snap")
        self._audition_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="tempo-audition")
        self._fast_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="tempo-fast")
        self._heavy_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="tempo-heavy")
        self._write_lock = threading.Lock()
        self._cancel_lock = threading.Lock()
        self._active: dict[str, threading.Event] = {}

    def close(self) -> None:
        with self._cancel_lock:
            for ev in self._active.values():
                ev.set()
            self._active.clear()
        self._snap_pool.shutdown(wait=False, cancel_futures=True)
        self._audition_pool.shutdown(wait=False, cancel_futures=True)
        self._fast_pool.shutdown(wait=False, cancel_futures=True)
        self._heavy_pool.shutdown(wait=False, cancel_futures=True)

    def dispatch_sync(self, method: str, params: dict, cancel_event: threading.Event | None = None) -> dict:
        raw_sha = params.get("audioSha256") or params.get("audio_sha256")
        audio_sha = str(raw_sha) if raw_sha else None
        if method == "ping":
            return {
                "pong": True,
                "providerKind": self.engine.provider_kind(),
                "cachedTracks": len(self.engine.cache),
            }
        if method == "prepare":
            return self.engine.prepare(
                params["audioPath"], cancel_event=cancel_event, audio_sha256=audio_sha
            )
        if method == "analyze":
            return self.engine.analyze(
                params["audioPath"],
                use_beatthis=params.get("useBeatThis"),
                cancel_event=cancel_event,
                audio_sha256=audio_sha,
            )
        if method == "suggest_snaps":
            return self.engine.suggest_snaps(
                params["audioPath"],
                time_sec=float(params["timeSec"]),
                window_sec=float(params.get("windowSec", 0.12)),
                cancel_event=cancel_event,
                audio_sha256=audio_sha,
            )
        if method == "recompute":
            return self.engine.recompute(params, cancel_event=cancel_event)
        if method == "render_audition":
            raw_out = params.get("outputPath")
            return self.engine.render_span_wav(
                params["audioPath"],
                start_s=float(params["startSec"]),
                end_s=float(params["endSec"]),
                filter_name=str(params.get("filter", "mix")),
                output_path=str(raw_out) if raw_out else None,
                cancel_event=cancel_event,
                audio_sha256=audio_sha,
            )
        if method == "export_clip":
            return self.engine.render_span_wav(
                params["audioPath"],
                start_s=float(params["startSec"]),
                end_s=float(params["endSec"]),
                filter_name=str(params.get("filter", "mix")),
                output_path=params["outputPath"],
                cancel_event=cancel_event,
                audio_sha256=audio_sha,
            )
        raise ValueError(f"Unknown daemon method: {method}")

    def serve_stdio(self) -> int:
        # Reserve actual fd 1 exclusively for NDJSON responses so third-party prints go to stderr.
        out_fd = os.dup(sys.stdout.fileno())
        protocol_out = os.fdopen(out_fd, "w", buffering=1, encoding="utf-8")
        sys.stdout = sys.stderr

        def send(payload: dict) -> None:
            line = json.dumps(payload, separators=(",", ":")) + "\n"
            with self._write_lock:
                protocol_out.write(line)
                protocol_out.flush()

        def run_task(req_id: str, method: str, params: dict, cancel_ev: threading.Event) -> None:
            try:
                result = self.dispatch_sync(method, params, cancel_event=cancel_ev)
                if cancel_ev.is_set():
                    send(
                        {
                            "id": req_id,
                            "ok": False,
                            "cancelled": True,
                            "error": {"code": "CANCELLED", "message": "Request cancelled"},
                        }
                    )
                else:
                    send({"id": req_id, "ok": True, "result": result})
            except CancelledError:
                send(
                    {
                        "id": req_id,
                        "ok": False,
                        "cancelled": True,
                        "error": {"code": "CANCELLED", "message": "Request cancelled"},
                    }
                )
            except Exception as exc:  # noqa: BLE001
                send(
                    {
                        "id": req_id,
                        "ok": False,
                        "error": {"code": type(exc).__name__, "message": str(exc)},
                    }
                )
            finally:
                with self._cancel_lock:
                    self._active.pop(req_id, None)

        try:
            while True:
                raw_line = sys.stdin.readline()
                if not raw_line:
                    break
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError as exc:
                    send({"id": None, "ok": False, "error": {"code": "BAD_JSON", "message": str(exc)}})
                    continue

                req_id = str(msg.get("id") or "")
                method = str(msg.get("method") or "")
                params = dict(msg.get("params") or {})

                if method == "shutdown":
                    if req_id:
                        send({"id": req_id, "ok": True, "result": {"closed": True}})
                    break

                if method == "cancel":
                    target_id = str(params.get("targetId") or params.get("requestId") or "")
                    cancelled = False
                    with self._cancel_lock:
                        ev = self._active.get(target_id)
                        if ev is not None:
                            ev.set()
                            cancelled = True
                    if req_id:
                        send({"id": req_id, "ok": True, "result": {"cancelled": cancelled, "targetId": target_id}})
                    continue

                cancel_ev = threading.Event()
                if req_id:
                    with self._cancel_lock:
                        self._active[req_id] = cancel_ev

                if method == "suggest_snaps":
                    pool = self._snap_pool
                elif method in ("render_audition", "export_clip"):
                    pool = self._audition_pool
                elif method in ("ping", "prepare"):
                    pool = self._fast_pool
                else:
                    pool = self._heavy_pool
                pool.submit(run_task, req_id, method, params, cancel_ev)
        finally:
            self.close()
            try:
                protocol_out.close()
            except OSError:
                pass
        return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Persistent warm audio/DSP daemon for /tempo.")
    parser.add_argument("--backend", choices=("auto", "dsp"), default=None)
    parser.add_argument("--max-cached-tracks", type=int, default=MAX_CACHED_TRACKS)
    parser.add_argument("--checkpoint", default=None)
    parser.add_argument("--device", default=None)
    args = parser.parse_args(argv)

    engine = TempoEngine(
        max_cached_tracks=args.max_cached_tracks,
        backend=args.backend,
        checkpoint_name=args.checkpoint,
        device=args.device,
    )
    server = DaemonServer(engine=engine)
    return server.serve_stdio()


if __name__ == "__main__":
    sys.exit(main())
