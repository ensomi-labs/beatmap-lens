#!/usr/bin/env python3
"""Draft workspace audio helper for the Inspector's local service.

Every time this reports is in source-audio seconds on the original mix, decoded once by ffmpeg
(the canonical host PCM). Three jobs:

``analyze``  Raw BeatThis beats: ``Audio2Frames`` logits on the host PCM, peak-picked directly
             (BeatThis's minimal rule, local maximum over +-70 ms with a positive logit) with a
             parabolic sub-frame refinement and the peak's probability as confidence. No tempo is
             folded, no meter is assumed and no grid is fitted. When BeatThis or its checkpoint
             is unavailable the beats come from a labelled rule (onset autocorrelation) instead.
             Sounds come from global onset-flux peaks of the host PCM's log-Mel envelope,
             independent of the beats, and are experimental.
``audition`` A listening view of a span: the mix, an HPSS percussive or harmonic part, or a low
             (<250 Hz), mid (250-2500 Hz) or high (>2500 Hz) band. Zero-phase filters and an
             STFT that keeps length, so nothing moves in time, but views are for listening only:
             no timestamp is ever taken from them.

Output is one JSON object on stdout.
"""
import argparse
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import wave

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

AUDITION_VIEWS = ("mix", "percussive", "harmonic", "low", "mid", "high")
BEATTHIS_FPS = 50.0
FLUX_HOP_S = 0.01
FLUX_MELS = 64
LOW_HZ = 250.0
HIGH_HZ = 2500.0
#: Context decoded either side of an audition span so filters and the STFT settle before it.
AUDITION_PAD_S = 0.5


def _tool(name):
    path = shutil.which(name)
    if not path:
        raise FileNotFoundError(f"Required system binary not found on PATH: {name}")
    return path


def probe(path):
    """Container facts of the first audio stream."""
    result = subprocess.run(
        [_tool("ffprobe"), "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=codec_name,sample_rate,channels:format=duration",
         "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    )
    payload = json.loads(result.stdout)
    stream = payload["streams"][0]
    return {
        "path": str(Path(path).resolve()),
        "durationS": float(payload["format"]["duration"]),
        "sampleRate": int(stream["sample_rate"]),
        "channels": int(stream["channels"]),
        "codec": stream["codec_name"],
    }


def decode(path, channels, start_s=None, duration_s=None):
    """Float32 frames [N, channels] at the file's own rate, decoded by ffmpeg."""
    command = [_tool("ffmpeg"), "-v", "error", "-nostdin"]
    if start_s is not None:
        command += ["-ss", f"{start_s:.6f}"]
    command += ["-i", str(path)]
    if duration_s is not None:
        command += ["-t", f"{duration_s:.6f}"]
    command += ["-map", "0:a:0", "-f", "f32le", "-acodec", "pcm_f32le", "-"]
    raw = subprocess.run(command, capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype="<f4").reshape(-1, channels).astype(np.float32)


# ---------------------------------------------------------------- raw BeatThis


def pick_beats(beat_logits, fps=BEATTHIS_FPS, half_window=3):
    """Beats from BeatThis frame logits: local maxima over +-half_window frames with logit > 0.

    A plateau keeps its first frame. Each peak is refined by a parabola through its neighbours;
    its confidence is the sigmoid of the peak logit. Times are frame centres (frame j at j / fps).
    """
    logits = np.asarray(beat_logits, dtype=np.float64)
    if logits.size == 0:
        return []
    padded = np.pad(logits, half_window, constant_values=-np.inf)
    local_max = sliding_window_view(padded, 2 * half_window + 1).max(axis=1)
    index = np.flatnonzero((logits >= local_max) & (logits > 0))
    if index.size:
        index = index[np.concatenate(([True], np.diff(index) > half_window))]
    beats = []
    for i in index:
        offset = 0.0
        if 0 < i < logits.size - 1:
            a, b, c = logits[i - 1], logits[i], logits[i + 1]
            curvature = a - 2 * b + c
            if curvature < 0:
                offset = float(np.clip(0.5 * (a - c) / curvature, -0.5, 0.5))
        beats.append({"t": (i + offset) / fps, "conf": float(1.0 / (1.0 + math.exp(-logits[i])))})
    return beats


def beatthis_checkpoint(name):
    """A local checkpoint path, or None when the name is not a file and not in torch's cache."""
    if Path(name).is_file():
        return str(Path(name).resolve())
    import torch

    cached = Path(torch.hub.get_dir()) / "checkpoints" / f"beat_this-{name}.ckpt"
    return str(cached) if cached.is_file() else None


def beatthis_beats(mono, sample_rate, checkpoint, device):
    import torch
    from beat_this.inference import Audio2Frames

    frames = Audio2Frames(checkpoint_path=checkpoint, device=device, float16=False)
    with torch.inference_mode():
        beat_logits, downbeat_logits = frames(mono, sample_rate)
    beats = pick_beats(beat_logits.detach().cpu().numpy())
    downbeat = downbeat_logits.detach().cpu().numpy().astype(np.float64)
    for beat in beats:
        frame = min(int(round(beat["t"] * BEATTHIS_FPS)), downbeat.size - 1)
        # Reported as the raw activation only; no meter or bar is inferred from it.
        beat["downbeatP"] = float(1.0 / (1.0 + math.exp(-downbeat[frame])))
    return beats


# ---------------------------------------------------------------- onset flux


def mel_filters(sample_rate, n_fft, n_mels=FLUX_MELS, fmin=30.0, fmax=None):
    fmax = fmax or sample_rate / 2
    to_mel = lambda hz: 2595.0 * np.log10(1.0 + hz / 700.0)  # noqa: E731
    to_hz = lambda mel: 700.0 * (10 ** (mel / 2595.0) - 1.0)  # noqa: E731
    edges = to_hz(np.linspace(to_mel(fmin), to_mel(fmax), n_mels + 2))
    bins = np.fft.rfftfreq(n_fft, 1.0 / sample_rate)
    lower, centre, upper = edges[:-2, None], edges[1:-1, None], edges[2:, None]
    rising = (bins[None, :] - lower) / np.maximum(centre - lower, 1e-9)
    falling = (upper - bins[None, :]) / np.maximum(upper - centre, 1e-9)
    return np.maximum(0.0, np.minimum(rising, falling))


def _flux_hop(sample_rate, hop_s=FLUX_HOP_S):
    """Exact integer hop in samples and its exact duration in seconds."""
    hop_samples = max(1, int(round(sample_rate * hop_s)))
    return hop_samples, hop_samples / float(sample_rate)


def log_mel(mono, sample_rate, hop_s=FLUX_HOP_S):
    """Log-compressed Mel power with frames centred at k * (hop_samples / sample_rate)."""
    hop, _ = _flux_hop(sample_rate, hop_s)
    n_fft = max(2, 1 << int(round(math.log2(max(2.0, 0.023 * sample_rate)))))
    padded = np.pad(mono.astype(np.float64), n_fft // 2)
    count = 1 + max(0, (padded.size - n_fft) // hop)
    frames = sliding_window_view(padded, n_fft)[: count * hop : hop]
    power = np.abs(np.fft.rfft(frames * np.hanning(n_fft), axis=1)) ** 2
    # macOS Accelerate raises spurious floating-point flags in matmul; the product is finite.
    with np.errstate(all="ignore"):
        mel = power @ mel_filters(sample_rate, n_fft).T
    return np.log1p(1000.0 * mel)


def onset_envelope(mono, sample_rate, hop_s=FLUX_HOP_S):
    mel = log_mel(mono, sample_rate, hop_s)
    flux = np.maximum(0.0, np.diff(mel, axis=0)).mean(axis=1)
    return np.concatenate(([0.0], flux))


def onset_flux_sounds(mono, sample_rate, hop_s=FLUX_HOP_S):
    """Global onset-flux peaks: local maxima over +-30 ms above a +-100 ms moving mean.

    Peaks are found on the envelope over its 99th percentile. Emphasis is a peak's flux over the
    95th percentile of all peaks' flux, clipped to 1; confidence is how far the peak stands above
    its local threshold.
    """
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
    sounds = []
    for i in index:
        offset = 0.0
        if 0 < i < norm.size - 1:
            a, b, c = norm[i - 1], norm[i], norm[i + 1]
            curvature = a - 2 * b + c
            if curvature < 0:
                offset = float(np.clip(0.5 * (a - c) / curvature, -0.5, 0.5))
        sounds.append({
            "t": (i + offset) * actual_hop_s,
            "emphasis": float(min(1.0, norm[i] / emphasis_scale)),
            "conf": float(np.clip((norm[i] - threshold[i]) / max(norm[i], 1e-9), 0.0, 1.0)),
        })
    return sounds


def rule_beats(mono, sample_rate, duration_s, hop_s=FLUX_HOP_S):
    """One steady pulse from the onset envelope's autocorrelation (lags 0.3-1.0 s) and phase.

    Used only when BeatThis is unavailable, and labelled as a rule. Confidence is the normalised
    envelope at each beat.
    """
    _, actual_hop_s = _flux_hop(sample_rate, hop_s)
    flux = onset_envelope(mono, sample_rate, hop_s)
    centred = flux - flux.mean()
    min_lag = max(1, int(round(0.3 / actual_hop_s)))
    max_lag = max(min_lag, int(round(1.0 / actual_hop_s)))
    lags = np.arange(min_lag, max_lag + 1)
    if centred.size <= lags[-1] * 2:
        return []
    corr = np.array([np.dot(centred[:-lag], centred[lag:]) for lag in lags])
    period = int(lags[int(np.argmax(corr))])
    phase = int(np.argmax([flux[p::period].sum() for p in range(period)]))
    peak = float(flux.max()) or 1.0
    return [
        {"t": frame * actual_hop_s, "conf": float(min(1.0, flux[frame] / peak))}
        for frame in range(phase, min(flux.size, int(duration_s / actual_hop_s) + 1), period)
    ]


def analyze(path, checkpoint_name="final0", device="cpu", use_beatthis=True):
    started = time.perf_counter()
    audio = probe(path)
    pcm = decode(path, audio["channels"])
    mono = pcm.mean(axis=1)
    audio["frames"] = int(pcm.shape[0])
    decoded = time.perf_counter()
    beat_provider = {"kind": "model", "name": f"BeatThis {checkpoint_name} (raw, un-folded)"}
    unavailable = None
    if use_beatthis:
        try:
            checkpoint = beatthis_checkpoint(checkpoint_name)
            if checkpoint is None:
                raise FileNotFoundError(f"BeatThis checkpoint '{checkpoint_name}' is not cached locally")
            beat_provider["checkpoint"] = checkpoint
            beats = beatthis_beats(mono, audio["sampleRate"], checkpoint, device)
        except Exception as error:  # noqa: BLE001 - reported as the reason, never hidden
            unavailable = f"{type(error).__name__}: {error}"
    else:
        unavailable = "BeatThis disabled by request"
    if unavailable is not None:
        beat_provider = {
            "kind": "rule",
            "name": "onset autocorrelation (BeatThis unavailable)",
            "note": unavailable,
        }
        beats = rule_beats(mono, audio["sampleRate"], audio["durationS"])
    beaten = time.perf_counter()
    sounds = onset_flux_sounds(mono, audio["sampleRate"])
    return {
        "audio": audio,
        "beats": {"provider": beat_provider, "items": beats},
        "sounds": {
            "provider": {"kind": "rule", "name": "onset-flux (log-Mel)", "experimental": True},
            "items": sounds,
        },
        "seconds": {
            "decode": decoded - started,
            "beats": beaten - decoded,
            "sounds": time.perf_counter() - beaten,
        },
    }


# ---------------------------------------------------------------- audition views


def band_view(pcm, sample_rate, view, order=4):
    """Zero-phase band split: the squared magnitude of an order-4 Butterworth response applied in
    the frequency domain (what a forward-backward filter does), zero-padded to avoid circular
    wrap-around across recording edges, so no sound moves in time."""
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


def _median(values, kernel, axis, rows=96):
    """Running median along ``axis`` of a 2-D array, reflect-padded, in blocks to bound memory."""
    work = np.moveaxis(values, axis, 1).astype(np.float32)
    half = kernel // 2
    padded = np.pad(work, ((0, 0), (half, half)), mode="reflect")
    out = np.empty_like(work)
    for first in range(0, work.shape[0], rows):
        block = sliding_window_view(padded[first : first + rows], kernel, axis=1)
        out[first : first + rows] = np.median(block, axis=-1)
    return np.moveaxis(out, 1, axis)


def hpss_view(pcm, sample_rate, view, kernel=17):
    """Median-filtering HPSS (Fitzgerald) with soft masks on a Hann STFT at 75 % overlap, per
    channel; weighted overlap-add restores the input's length and alignment."""
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
        signal = np.zeros(padded.size)
        weight = np.zeros(padded.size)
        for index, piece in enumerate(pieces):
            start = index * hop
            signal[start : start + n_fft] += piece
            weight[start : start + n_fft] += window**2
        restored = signal / np.maximum(weight, 1e-8)
        out[:, channel] = restored[n_fft : n_fft + pcm.shape[0]]
    return out


def audition_view(pcm, sample_rate, view):
    if view == "mix":
        return pcm.astype(np.float64)
    if view in ("low", "mid", "high"):
        return band_view(pcm.astype(np.float64), sample_rate, view)
    if view in ("percussive", "harmonic"):
        return hpss_view(pcm.astype(np.float64), sample_rate, view)
    raise ValueError(f"Unknown audition view '{view}'; expected one of {AUDITION_VIEWS}")


def write_wav(path, samples, sample_rate):
    pcm16 = (np.clip(samples, -1.0, 1.0) * 32767.0).round().astype("<i2")
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(samples.shape[1])
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(pcm16.tobytes())


def render_audition(path, start_s, end_s, view, out):
    started = time.perf_counter()
    audio = probe(path)
    start = max(0.0, float(start_s))
    end = min(float(end_s), audio["durationS"])
    if end <= start:
        raise ValueError(f"Empty audition span {start_s}-{end_s}")
    lead = min(AUDITION_PAD_S, start)
    pcm = decode(path, audio["channels"], start - lead, end - start + lead + AUDITION_PAD_S)
    rendered = audition_view(pcm, audio["sampleRate"], view)
    first = int(round(lead * audio["sampleRate"]))
    count = int(round((end - start) * audio["sampleRate"]))
    write_wav(out, rendered[first : first + count], audio["sampleRate"])
    return {
        "outputPath": str(Path(out).resolve()),
        "view": view,
        "startS": start,
        "endS": end,
        "sampleRate": audio["sampleRate"],
        "channels": audio["channels"],
        "seconds": time.perf_counter() - started,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    p_analyze = sub.add_parser("analyze", help="Raw BeatThis beats and onset-flux sounds as JSON.")
    p_analyze.add_argument("audio")
    p_analyze.add_argument(
        "--beatthis-checkpoint",
        default=os.environ.get("ENSOMI_BEATTHIS_CHECKPOINT", "final0"),
        help="A checkpoint file, or a BeatThis name looked up in torch's hub cache (default final0).",
    )
    p_analyze.add_argument("--device", default="cpu")
    p_analyze.add_argument("--no-beatthis", action="store_true")
    p_audition = sub.add_parser("audition", help="Render a listening view of a span as WAV.")
    p_audition.add_argument("audio")
    p_audition.add_argument("--start", type=float, required=True)
    p_audition.add_argument("--end", type=float, required=True)
    p_audition.add_argument("--view", choices=AUDITION_VIEWS, required=True)
    p_audition.add_argument("--out", required=True)
    args = parser.parse_args(argv)
    if args.command == "analyze":
        result = analyze(args.audio, args.beatthis_checkpoint, args.device, not args.no_beatthis)
    else:
        result = render_audition(args.audio, args.start, args.end, args.view, args.out)
    json.dump(result, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
