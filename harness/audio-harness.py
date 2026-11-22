#!/usr/bin/env python3
"""CLI for read-only audio inspection (probe/slice) and click-overlay audition."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))

from harness_audio import BAND_FILTERS, LAYOUTS, extract_audio_slice, probe_audio, render_click_audition


def build_parser():
    parser = argparse.ArgumentParser(description="Read-only audio inspection and click audition harness.")
    sub = parser.add_subparsers(dest="command", required=True)

    p_probe = sub.add_parser("probe", help="Inspect audio metadata via ffprobe.")
    p_probe.add_argument("audio", help="Input audio file path.")

    p_slice = sub.add_parser("slice", help="Extract an audio span with optional rate stretch and band filter.")
    p_slice.add_argument("audio", help="Input audio file path.")
    p_slice.add_argument("--out", required=True, help="Output audio path (.mp3/.wav recommended for LLM read_file; also .m4a/.ogg).")
    p_slice.add_argument("--start", type=float, default=0.0, help="Span start in seconds (default: 0).")
    p_slice.add_argument("--end", type=float, default=None, help="Span end in seconds (default: full duration).")
    p_slice.add_argument("--rate", type=float, default=1.0, help="Pitch-preserving playback rate (default: 1.0).")
    p_slice.add_argument("--band", choices=tuple(BAND_FILTERS), default=None, help="Preset frequency band filter.")
    p_slice.add_argument("--lowpass", type=float, default=None, help="Custom low-pass cutoff in Hz.")
    p_slice.add_argument("--highpass", type=float, default=None, help="Custom high-pass cutoff in Hz.")
    p_slice.add_argument("--mono", action="store_true", help="Downmix output to mono.")

    p_aud = sub.add_parser("audition", help="Render candidate timing beats/downbeats as clicks over audio.")
    p_aud.add_argument("audio", help="Input audio file path.")
    p_aud.add_argument("--timing", required=True, help="Candidate timing file (.osu or .json).")
    p_aud.add_argument("--out", required=True, help="Output audio path (.mp3/.wav recommended for LLM read_file; also .m4a/.ogg).")
    p_aud.add_argument("--start", type=float, default=0.0, help="Span start in seconds (default: 0).")
    p_aud.add_argument("--end", type=float, default=None, help="Span end in seconds (default: full duration).")
    p_aud.add_argument("--rate", type=float, default=1.0, help="Pitch-preserving playback rate (default: 1.0).")
    p_aud.add_argument("--layout", choices=LAYOUTS, default="mix", help="Output channel layout (default: mix).")
    p_aud.add_argument("--offset-ms", type=float, default=0.0, help="Shift all clicks by ms (default: 0).")
    p_aud.add_argument("--music-gain-db", type=float, default=-3.0, help="Music gain in dB (default: -3).")
    p_aud.add_argument("--click-gain-db", type=float, default=0.0, help="Click gain in dB (default: 0).")
    p_aud.add_argument("--format", choices=("osu", "json"), default=None, help="Override timing file format.")

    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.command == "probe":
        result = probe_audio(args.audio)
    elif args.command == "slice":
        result = extract_audio_slice(
            args.audio,
            args.out,
            start_s=args.start,
            end_s=args.end,
            rate=args.rate,
            band=args.band,
            lowpass_hz=args.lowpass,
            highpass_hz=args.highpass,
            mono=args.mono,
        )
    else:
        result = render_click_audition(
            args.audio,
            args.timing,
            args.out,
            start_s=args.start,
            end_s=args.end,
            rate=args.rate,
            layout=args.layout,
            offset_ms=args.offset_ms,
            music_gain_db=args.music_gain_db,
            click_gain_db=args.click_gain_db,
            timing_format=args.format,
        )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
