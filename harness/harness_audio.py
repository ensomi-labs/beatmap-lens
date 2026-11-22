"""Read-only audio inspection (slice/rate/filter) and click-overlay audition rendering."""
from array import array
import json
import math
from pathlib import Path
import shutil
import subprocess
import tempfile
import wave


SAMPLE_RATE = 44100
BAND_FILTERS = {
    "low": ["lowpass=f=200"],
    "mid": ["highpass=f=200", "lowpass=f=2500"],
    "high": ["highpass=f=2500"],
}
LAYOUTS = ("mix", "split", "clicks_only")


def _require_tool(name):
    path = shutil.which(name)
    if not path:
        raise FileNotFoundError(f"Required system binary not found on PATH: {name}")
    return path


def _run(cmd):
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise RuntimeError(f"Command failed ({result.returncode}): {' '.join(cmd)}\n{detail}")
    return result


def _db_to_linear(db):
    return 10.0 ** (float(db) / 20.0)


def _atempo_filters(rate):
    rate = float(rate)
    if not math.isfinite(rate) or rate <= 0:
        raise ValueError(f"rate must be positive and finite, got {rate}")
    if math.isclose(rate, 1.0, rel_tol=1e-9, abs_tol=1e-9):
        return []
    filters = []
    remaining = rate
    while remaining < 0.5:
        filters.append("atempo=0.5")
        remaining /= 0.5
    while remaining > 2.0:
        filters.append("atempo=2.0")
        remaining /= 2.0
    filters.append(f"atempo={remaining:.6f}")
    return filters


def _build_audio_filters(rate=1.0, band=None, lowpass_hz=None, highpass_hz=None):
    filters = []
    if band is not None:
        if band not in BAND_FILTERS:
            raise ValueError(f"Unsupported band '{band}'; expected one of {tuple(BAND_FILTERS)}")
        filters.extend(BAND_FILTERS[band])
    if highpass_hz is not None:
        hp = float(highpass_hz)
        if not math.isfinite(hp) or hp <= 0:
            raise ValueError(f"highpass_hz must be positive, got {highpass_hz}")
        filters.append(f"highpass=f={hp:g}")
    if lowpass_hz is not None:
        lp = float(lowpass_hz)
        if not math.isfinite(lp) or lp <= 0:
            raise ValueError(f"lowpass_hz must be positive, got {lowpass_hz}")
        filters.append(f"lowpass=f={lp:g}")
    filters.extend(_atempo_filters(rate))
    return filters


def _encoder_args(output_path):
    suffix = Path(output_path).suffix.lower()
    if suffix == ".wav":
        return ["-c:a", "pcm_s16le"]
    if suffix in (".m4a", ".mp4", ".aac"):
        return ["-c:a", "aac", "-b:a", "128k"]
    if suffix == ".mp3":
        return ["-c:a", "libmp3lame", "-q:a", "2"]
    if suffix in (".ogg", ".opus"):
        return ["-c:a", "libopus", "-b:a", "96k"]
    raise ValueError(f"Unsupported output audio extension: '{suffix}'")


def probe_audio(audio_path):
    """Return basic container/stream metadata for an audio file via ffprobe."""
    ffprobe = _require_tool("ffprobe")
    source = Path(audio_path).resolve()
    result = _run([
        ffprobe, "-v", "error",
        "-select_streams", "a:0",
        "-show_entries", "stream=codec_name,sample_rate,channels,duration",
        "-show_entries", "format=duration",
        "-of", "json",
        str(source),
    ])
    payload = json.loads(result.stdout)
    streams = payload.get("streams") or []
    if not streams:
        raise ValueError(f"No audio stream found in {source}")
    stream = streams[0]
    raw_duration = payload.get("format", {}).get("duration") or stream.get("duration")
    if raw_duration is None:
        raise ValueError(f"Unable to determine duration for {source}")
    return {
        "path": str(source),
        "durationS": float(raw_duration),
        "sampleRate": int(stream["sample_rate"]),
        "channels": int(stream["channels"]),
        "codec": str(stream["codec_name"]),
    }


def _resolve_span(source_duration_s, start_s, end_s):
    start = float(start_s)
    if not math.isfinite(start) or start < 0:
        raise ValueError(f"start_s must be >= 0, got {start_s}")
    end = source_duration_s if end_s is None else min(float(end_s), source_duration_s)
    if not math.isfinite(end) or end <= start:
        raise ValueError(f"Invalid span [{start}, {end}] for duration {source_duration_s:.3f}s")
    return start, end


def extract_audio_slice(
    audio_path,
    output_path,
    *,
    start_s=0.0,
    end_s=None,
    rate=1.0,
    band=None,
    lowpass_hz=None,
    highpass_hz=None,
    mono=False,
):
    """Extract an audio span with optional pitch-preserving rate scaling and frequency filtering."""
    ffmpeg = _require_tool("ffmpeg")
    info = probe_audio(audio_path)
    start, end = _resolve_span(info["durationS"], start_s, end_s)
    filters = _build_audio_filters(rate=rate, band=band, lowpass_hz=lowpass_hz, highpass_hz=highpass_hz)

    trim_filter = f"atrim=start={start:.6f}:end={end:.6f},asetpts=PTS-STARTPTS"
    all_filters = [trim_filter, *filters]

    out_path = Path(output_path).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        ffmpeg, "-y", "-v", "error",
        "-i", str(Path(audio_path).resolve()),
        "-vn",
        "-af", ",".join(all_filters),
    ]
    if mono:
        cmd.extend(["-ac", "1"])
    cmd.extend(_encoder_args(out_path))
    cmd.append(str(out_path))
    _run(cmd)

    out_info = probe_audio(out_path)
    return {
        "outputPath": str(out_path),
        "sourcePath": info["path"],
        "startS": start,
        "endS": end,
        "sourceDurationS": info["durationS"],
        "outputDurationS": out_info["durationS"],
        "rate": float(rate),
        "band": band,
        "filters": filters,
        "mono": bool(mono),
        "timeMapping": {
            "formula": "elapsed_s = (source_s - start_s) / rate",
            "sourceOriginS": start,
            "rate": float(rate),
        },
    }


def _expand_segments(segments, end_s):
    ordered = sorted(segments, key=lambda seg: seg["startS"])
    events = []
    for index, seg in enumerate(ordered):
        start_s = seg["startS"]
        beat_s = seg["beatLengthS"]
        meter = seg["meter"]
        if beat_s <= 0:
            raise ValueError(f"Segment beat length must be positive, got {beat_s}")
        if start_s > end_s:
            break
        next_start = ordered[index + 1]["startS"] if index + 1 < len(ordered) else None
        limit_s = min(end_s, next_start - 1e-6) if next_start is not None else end_s
        step = 0
        while True:
            t_s = start_s + step * beat_s
            if t_s > limit_s + 1e-9:
                break
            beat_in_bar = (step % meter) + 1
            events.append({"timeS": t_s, "isDownbeat": beat_in_bar == 1, "beatInBar": beat_in_bar})
            step += 1
    return events


def _parse_osu_timing(text, end_s):
    lines = text.splitlines()
    has_header = any(line.strip() == "[TimingPoints]" for line in lines)
    in_section = not has_header
    red_lines = []
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("//"):
            continue
        if line.startswith("[") and line.endswith("]"):
            if in_section and has_header:
                break
            in_section = (line == "[TimingPoints]")
            continue
        if not in_section:
            continue
        parts = [part.strip() for part in line.split(",")]
        if len(parts) < 2:
            continue
        time_ms = float(parts[0])
        beat_length_ms = float(parts[1])
        uninherited = True if len(parts) < 7 else (int(parts[6]) == 1)
        if not uninherited or beat_length_ms <= 0:
            continue
        meter = int(parts[2]) if len(parts) >= 3 and int(parts[2]) > 0 else 4
        red_lines.append({
            "startS": time_ms / 1000.0,
            "beatLengthS": beat_length_ms / 1000.0,
            "meter": meter,
        })
    if not red_lines:
        raise ValueError("No uninherited timing points (red lines) found in .osu input")
    return _expand_segments(red_lines, end_s)


def _read_time_s(item):
    if "time_s" in item:
        return float(item["time_s"])
    if "timeS" in item:
        return float(item["timeS"])
    if "time_ms" in item:
        return float(item["time_ms"]) / 1000.0
    if "timeMs" in item:
        return float(item["timeMs"]) / 1000.0
    raise ValueError(f"Timing event missing time field: {item}")


def _parse_json_timing(data, end_s):
    if isinstance(data, dict) and "segments" in data:
        segments = []
        for seg in data["segments"]:
            if "start_s" in seg:
                start_s = float(seg["start_s"])
            elif "startS" in seg:
                start_s = float(seg["startS"])
            elif "start_ms" in seg:
                start_s = float(seg["start_ms"]) / 1000.0
            else:
                start_s = float(seg["time_ms"]) / 1000.0
            if "bpm" in seg:
                beat_s = 60.0 / float(seg["bpm"])
            elif "beat_length_ms" in seg:
                beat_s = float(seg["beat_length_ms"]) / 1000.0
            else:
                beat_s = float(seg["beatLengthMs"]) / 1000.0
            meter = int(seg.get("meter", 4))
            segments.append({"startS": start_s, "beatLengthS": beat_s, "meter": meter})
        return _expand_segments(segments, end_s)

    if isinstance(data, list) or (isinstance(data, dict) and "events" in data):
        raw_events = data if isinstance(data, list) else data["events"]
        events = []
        for item in raw_events:
            t_s = _read_time_s(item)
            if t_s > end_s + 1e-9:
                continue
            beat_in_bar = item.get("beat_in_bar", item.get("beatInBar"))
            if "is_downbeat" in item:
                is_downbeat = bool(item["is_downbeat"])
            elif "isDownbeat" in item:
                is_downbeat = bool(item["isDownbeat"])
            else:
                is_downbeat = (beat_in_bar == 1)
            events.append({
                "timeS": t_s,
                "isDownbeat": is_downbeat,
                "beatInBar": int(beat_in_bar) if beat_in_bar is not None else (1 if is_downbeat else 2),
            })
        return sorted(events, key=lambda ev: ev["timeS"])

    if isinstance(data, dict):
        if "beats" in data:
            beats = [float(t) for t in data["beats"]]
            downbeats = [float(t) for t in data.get("downbeats", [])]
        elif "beats_ms" in data or "beatsMs" in data:
            raw_beats = data.get("beats_ms", data.get("beatsMs", []))
            raw_dbs = data.get("downbeats_ms", data.get("downbeatsMs", []))
            beats = [float(t) / 1000.0 for t in raw_beats]
            downbeats = [float(t) / 1000.0 for t in raw_dbs]
        else:
            raise ValueError("Unsupported JSON timing schema")

        events = []
        matched_dbs = set()
        for t_s in beats:
            if t_s > end_s + 1e-9:
                continue
            match = next((i for i, db in enumerate(downbeats) if abs(db - t_s) <= 0.005), None)
            if match is not None:
                matched_dbs.add(match)
            events.append({"timeS": t_s, "isDownbeat": match is not None, "beatInBar": 1 if match is not None else 2})
        for i, db in enumerate(downbeats):
            if i not in matched_dbs and db <= end_s + 1e-9:
                events.append({"timeS": db, "isDownbeat": True, "beatInBar": 1})
        return sorted(events, key=lambda ev: ev["timeS"])

    raise ValueError("Unsupported JSON timing structure")


def parse_timing_events(timing_path, *, end_s, timing_format=None):
    """Parse candidate beat/downbeat events from a .osu file or JSON timing file."""
    path = Path(timing_path).resolve()
    fmt = timing_format
    if fmt is None:
        ext = path.suffix.lower()
        if ext == ".osu":
            fmt = "osu"
        elif ext == ".json":
            fmt = "json"
        else:
            raise ValueError(f"Cannot infer timing format from '{ext}'; pass timing_format='osu' or 'json'")
    text = path.read_text(encoding="utf-8")
    if fmt == "osu":
        return _parse_osu_timing(text, float(end_s))
    if fmt == "json":
        return _parse_json_timing(json.loads(text), float(end_s))
    raise ValueError(f"Unsupported timing_format '{fmt}'")


def _make_click_wave(freq_hz, amplitude, duration_s=0.022, sample_rate=SAMPLE_RATE):
    length = max(1, int(round(duration_s * sample_rate)))
    attack_n = max(1, int(round(0.0005 * sample_rate)))
    tau = 0.0045
    samples = array("f", [0.0]) * length
    two_pi_f = 2.0 * math.pi * freq_hz
    for i in range(length):
        t = i / sample_rate
        env = (i / attack_n) if i < attack_n else math.exp(-(t - attack_n / sample_rate) / tau)
        tone = math.sin(two_pi_f * t) + 0.35 * math.sin(2.0 * two_pi_f * t)
        samples[i] = amplitude * env * (tone / 1.35)
    return samples


def _read_pcm16_wav(path):
    with wave.open(str(path), "rb") as wf:
        channels = wf.getnchannels()
        sample_rate = wf.getframerate()
        n_frames = wf.getnframes()
        raw = wf.readframes(n_frames)
    samples = array("h")
    samples.frombytes(raw)
    return samples, channels, sample_rate, n_frames


def _write_pcm16_wav(path, samples, channels, sample_rate=SAMPLE_RATE):
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(samples.tobytes())


def _clamp_i16(value):
    ival = int(round(value))
    if ival > 32767:
        return 32767
    if ival < -32767:
        return -32767
    return ival


def render_click_audition(
    audio_path,
    timing_path,
    output_path,
    *,
    start_s=0.0,
    end_s=None,
    rate=1.0,
    layout="mix",
    offset_ms=0.0,
    music_gain_db=-3.0,
    click_gain_db=0.0,
    timing_format=None,
):
    """Render candidate timing beats/downbeats as sharp synthesized clicks over an audio span.

    When rate != 1.0, music is time-stretched first and clicks are synthesized afterward at exact
    scaled sample positions so click transients remain sample-accurate without atempo smearing.
    """
    if layout not in LAYOUTS:
        raise ValueError(f"Unsupported layout '{layout}'; expected one of {LAYOUTS}")
    ffmpeg = _require_tool("ffmpeg")
    info = probe_audio(audio_path)
    start, end = _resolve_span(info["durationS"], start_s, end_s)
    rate_f = float(rate)
    if not math.isfinite(rate_f) or rate_f <= 0:
        raise ValueError(f"rate must be positive and finite, got {rate}")

    offset_s = float(offset_ms) / 1000.0
    events = parse_timing_events(
        timing_path,
        end_s=end + abs(offset_s) + 1.0,
        timing_format=timing_format,
    )
    rendered = []
    for ev in events:
        shifted_s = ev["timeS"] + offset_s
        if start <= shifted_s < end:
            rendered.append({
                "sourceS": shifted_s,
                "elapsedS": (shifted_s - start) / rate_f,
                "isDownbeat": ev["isDownbeat"],
            })

    out_path = Path(output_path).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    music_gain = _db_to_linear(music_gain_db)
    click_gain = _db_to_linear(click_gain_db)

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        if layout == "clicks_only":
            n_frames = max(1, int(round((end - start) / rate_f * SAMPLE_RATE)))
            music_samples = None
            music_channels = 0
        else:
            music_wav = tmp / "music.wav"
            music_channels = 1 if layout == "split" else 2
            atempo = _atempo_filters(rate_f)
            music_filters = [f"atrim=start={start:.6f}:end={end:.6f}", "asetpts=PTS-STARTPTS", *atempo]
            cmd = [
                ffmpeg, "-y", "-v", "error",
                "-i", info["path"],
                "-vn",
                "-af", ",".join(music_filters),
                "-ar", str(SAMPLE_RATE),
                "-ac", str(music_channels),
                "-c:a", "pcm_s16le",
                str(music_wav),
            ]
            _run(cmd)
            music_samples, music_channels, _, n_frames = _read_pcm16_wav(music_wav)

        click_buf = array("f", [0.0]) * n_frames
        downbeat_wave = _make_click_wave(1600.0, 0.90 * click_gain)
        beat_wave = _make_click_wave(900.0, 0.62 * click_gain)
        for item in rendered:
            idx = int(round(item["elapsedS"] * SAMPLE_RATE))
            if idx < 0 or idx >= n_frames:
                continue
            wave_data = downbeat_wave if item["isDownbeat"] else beat_wave
            end_idx = min(n_frames, idx + len(wave_data))
            for k in range(end_idx - idx):
                click_buf[idx + k] += wave_data[k]

        mixed_wav = tmp / "audition.wav"
        if layout == "clicks_only":
            pcm = array("h", (_clamp_i16(sample * 32767.0) for sample in click_buf))
            _write_pcm16_wav(mixed_wav, pcm, channels=1)
        elif layout == "split":
            pcm = array("h", [0]) * (n_frames * 2)
            for i in range(n_frames):
                pcm[2 * i] = _clamp_i16(music_samples[i] * music_gain)
                pcm[2 * i + 1] = _clamp_i16(click_buf[i] * 32767.0)
            _write_pcm16_wav(mixed_wav, pcm, channels=2)
        else:
            pcm = array("h", [0]) * (n_frames * 2)
            for i in range(n_frames):
                click_val = click_buf[i] * 32767.0
                pcm[2 * i] = _clamp_i16(music_samples[2 * i] * music_gain + click_val)
                pcm[2 * i + 1] = _clamp_i16(music_samples[2 * i + 1] * music_gain + click_val)
            _write_pcm16_wav(mixed_wav, pcm, channels=2)

        if out_path.suffix.lower() == ".wav":
            shutil.copyfile(mixed_wav, out_path)
        else:
            _run([
                ffmpeg, "-y", "-v", "error",
                "-i", str(mixed_wav),
                *_encoder_args(out_path),
                str(out_path),
            ])

    return {
        "outputPath": str(out_path),
        "sourcePath": info["path"],
        "timingPath": str(Path(timing_path).resolve()),
        "startS": start,
        "endS": end,
        "outputDurationS": n_frames / SAMPLE_RATE,
        "rate": rate_f,
        "layout": layout,
        "offsetMs": float(offset_ms),
        "musicGainDb": float(music_gain_db),
        "clickGainDb": float(click_gain_db),
        "beatCount": len(rendered),
        "downbeatCount": sum(1 for item in rendered if item["isDownbeat"]),
        "firstClickSourceS": rendered[0]["sourceS"] if rendered else None,
        "lastClickSourceS": rendered[-1]["sourceS"] if rendered else None,
        "firstClickElapsedS": rendered[0]["elapsedS"] if rendered else None,
        "lastClickElapsedS": rendered[-1]["elapsedS"] if rendered else None,
    }
