import { heardSourceMs, type PlaybackAnchor } from "./output-clock";

/** How far ahead a start is scheduled, so its context time is known exactly. */
const scheduleLeadS = 0.03;

/**
 * One `AudioContext` at the recording's own rate. Each play is a new `AudioBufferSourceNode`
 * (loops and stops scheduled on the node, sample exact) into a loudness gain and a volume gain,
 * then the destination. Nothing else is in the path: no compressor, limiter or analyser.
 */
export class TimingAudioEngine {
  readonly context: AudioContext;
  private readonly loudness: GainNode;
  private readonly volume: GainNode;
  private buffer: AudioBuffer | undefined;
  private source: AudioBufferSourceNode | undefined;
  private anchor: PlaybackAnchor | undefined;
  private frozenMs = 0;
  onEnded: ((positionMs: number) => void) | undefined;

  constructor(sampleRate: number) {
    const context = new AudioContext({ sampleRate, latencyHint: "interactive" });
    if (context.sampleRate !== sampleRate) {
      void context.close();
      throw new Error(
        `The browser opened audio at ${context.sampleRate} Hz, not ${sampleRate} Hz.`,
      );
    }
    this.context = context;
    this.loudness = new GainNode(context);
    this.volume = new GainNode(context);
    this.loudness.connect(this.volume).connect(context.destination);
  }

  get sampleRate(): number {
    return this.context.sampleRate;
  }

  get playing(): boolean {
    return Boolean(this.source);
  }

  get loaded(): AudioBuffer | undefined {
    return this.buffer;
  }

  /** Copies each channel into a buffer of the context's rate; the samples are not converted. */
  load(channels: Float32Array[], frames: number): AudioBuffer {
    this.stop();
    const buffer = new AudioBuffer({
      numberOfChannels: channels.length,
      length: frames,
      sampleRate: this.context.sampleRate,
    });
    channels.forEach((data, channel) => {
      buffer.copyToChannel(data as Float32Array<ArrayBuffer>, channel);
    });
    this.buffer = buffer;
    return buffer;
  }

  /** Starts at `fromMs` (the caller applies pre-roll); loops `loop` or stops at `endMs`. */
  async play(options: {
    fromMs: number;
    endMs: number;
    rate: number;
    loop: { startMs: number; endMs: number } | null;
  }): Promise<void> {
    const buffer = this.buffer;
    if (!buffer) throw new Error("The audio is not loaded yet.");
    this.stop();
    await this.context.resume();
    const source = new AudioBufferSourceNode(this.context, {
      buffer,
      playbackRate: options.rate,
      loop: Boolean(options.loop),
      ...(options.loop
        ? { loopStart: options.loop.startMs / 1000, loopEnd: options.loop.endMs / 1000 }
        : {}),
    });
    source.connect(this.loudness);
    const when = this.context.currentTime + scheduleLeadS;
    source.start(when, options.fromMs / 1000);
    if (!options.loop)
      source.stop(when + Math.max(0, options.endMs - options.fromMs) / 1000 / options.rate);
    const anchor: PlaybackAnchor = {
      startCtxS: when,
      startSourceMs: options.fromMs,
      rate: options.rate,
      loop: options.loop,
      endMs: options.endMs,
    };
    source.onended = () => {
      if (this.source !== source) return;
      this.frozenMs = anchor.endMs;
      this.release();
      this.onEnded?.(anchor.endMs);
    };
    this.source = source;
    this.anchor = anchor;
    this.frozenMs = options.fromMs;
  }

  /**
   * The source time heard now, or undefined when nothing plays. While the context is suspended
   * the transport freezes at the last position.
   */
  position(offsetMs: number): number | undefined {
    const anchor = this.anchor;
    if (!anchor) return undefined;
    if (this.context.state !== "running") return this.frozenMs;
    this.frozenMs = heardSourceMs(
      anchor,
      this.context.getOutputTimestamp(),
      performance.now(),
      offsetMs,
    );
    return this.frozenMs;
  }

  /** Stops at once, without a fade; returns the position that was being heard. */
  stop(offsetMs = 0): number | undefined {
    const heard = this.position(offsetMs);
    if (this.source) {
      this.source.onended = null;
      this.source.stop();
    }
    this.release();
    return heard;
  }

  setVolume(value: number) {
    this.volume.gain.value = value;
  }

  /** Attenuation only: positive gains are not applied. */
  setLoudnessDb(db: number) {
    this.loudness.gain.value = 10 ** (Math.min(0, db) / 20);
  }

  latencies(): { base_latency_ms: number | null; output_latency_ms: number | null } {
    const { baseLatency, outputLatency } = this.context;
    return {
      base_latency_ms: Number.isFinite(baseLatency) ? baseLatency * 1000 : null,
      output_latency_ms: Number.isFinite(outputLatency) ? outputLatency * 1000 : null,
    };
  }

  async close() {
    this.stop();
    this.buffer = undefined;
    await this.context.close();
  }

  private release() {
    this.source?.disconnect();
    this.source = undefined;
    this.anchor = undefined;
  }
}
