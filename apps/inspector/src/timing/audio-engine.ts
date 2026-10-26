import { clickTimes, heardSourceMs, type PlaybackAnchor } from "./output-clock";

/** How far ahead a start is scheduled, so its context time is known exactly. */
const scheduleLeadS = 0.03;
/** Mark clicks are scheduled this far ahead, topped up at this interval. */
const clickLookaheadS = 0.2;
const clickIntervalMs = 25;

/**
 * A 2 kHz tick at full level on its first sample, decaying with a 2 ms time constant over 12 ms,
 * so what is heard starts exactly at the mark.
 */
export function clickSamples(sampleRate: number): Float32Array<ArrayBuffer> {
  return Float32Array.from({ length: Math.round(sampleRate * 0.012) }, (_, index) => {
    const t = index / sampleRate;
    return 0.5 * Math.cos(2 * Math.PI * 2000 * t) * Math.exp(-t / 0.002);
  });
}

/**
 * One `AudioContext` at the recording's own rate. Each play is a new `AudioBufferSourceNode`
 * (loops and stops scheduled on the node, sample exact) into a loudness gain and a volume gain,
 * then the destination. Nothing else is in the music's path: no compressor, limiter or analyser.
 * When the listener turns them on, clicks at their own beats are separate sources, scheduled on
 * the same context clock and mixed in after the loudness gain.
 */
export class TimingAudioEngine {
  readonly context: AudioContext;
  private readonly loudness: GainNode;
  private readonly volume: GainNode;
  private buffer: AudioBuffer | undefined;
  private source: AudioBufferSourceNode | undefined;
  private anchor: PlaybackAnchor | undefined;
  private frozenMs = 0;
  /** Bumped by every play and stop, so only the latest call can start a source. */
  private playToken = 0;
  /** The token of a play waiting for the context to resume, or 0. */
  private resuming = 0;
  private clickBuffer: AudioBuffer | undefined;
  /** Source times to click at, or null while clicks are off. */
  private clickBeatsMs: number[] | null = null;
  private clicks: { node: AudioBufferSourceNode; atS: number }[] = [];
  /** Context time up to which clicks are scheduled. */
  private clickedUntilS = 0;
  private clickTimer: ReturnType<typeof setInterval> | undefined;
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

  /** A play is waiting for the context to resume; a stop cancels it. */
  get starting(): boolean {
    return this.resuming !== 0;
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

  /**
   * Starts at `fromMs` (the caller applies pre-roll); loops `loop` or stops at `endMs`. Resolves
   * false without starting when a stop or a later play came while the context resumed, so two
   * quick presses never leave an untracked source playing.
   */
  async play(options: {
    fromMs: number;
    endMs: number;
    rate: number;
    loop: { startMs: number; endMs: number } | null;
  }): Promise<boolean> {
    const buffer = this.buffer;
    if (!buffer) throw new Error("The audio is not loaded yet.");
    this.stop();
    const token = ++this.playToken;
    this.resuming = token;
    try {
      await this.context.resume();
    } finally {
      if (this.resuming === token) this.resuming = 0;
    }
    if (token !== this.playToken) return false;
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
    this.clickedUntilS = 0;
    this.syncClicks();
    return true;
  }

  /**
   * The source time heard at `nowMs` (performance clock; an event's `timeStamp` works), or
   * undefined when nothing plays. While the context is suspended the transport freezes at the
   * last position.
   */
  position(offsetMs: number, nowMs = performance.now()): number | undefined {
    const anchor = this.anchor;
    if (!anchor) return undefined;
    if (this.context.state !== "running") return this.frozenMs;
    this.frozenMs = heardSourceMs(anchor, this.context.getOutputTimestamp(), nowMs, offsetMs);
    return this.frozenMs;
  }

  /**
   * Clicks at these source times while playing, or none for null. A change takes effect from now:
   * clicks not yet sounding are rescheduled, so a nudged or new mark is heard on the next pass.
   */
  setClicks(beatsMs: readonly number[] | null) {
    this.clickBeatsMs = beatsMs ? [...beatsMs] : null;
    const now = this.context.currentTime;
    this.clicks = this.clicks.filter((click) => {
      if (click.atS <= now) return true;
      click.node.stop();
      click.node.disconnect();
      return false;
    });
    this.clickedUntilS = Math.min(this.clickedUntilS, now);
    this.syncClicks();
  }

  /**
   * Stops at once, without a fade, and cancels a play waiting to start; returns the position that
   * was being heard. Stopping when nothing plays does nothing else.
   */
  stop(offsetMs = 0): number | undefined {
    this.playToken++;
    this.resuming = 0;
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
    for (const click of this.clicks) {
      click.node.stop();
      click.node.disconnect();
    }
    this.clicks = [];
    this.syncClicks();
  }

  /** Runs the click scheduler while a source plays with clicks on, and stops it otherwise. */
  private syncClicks() {
    const active = Boolean(this.anchor && this.clickBeatsMs?.length);
    if (active && this.clickTimer === undefined) {
      this.clickTimer = setInterval(() => this.scheduleClicks(), clickIntervalMs);
    } else if (!active && this.clickTimer !== undefined) {
      clearInterval(this.clickTimer);
      this.clickTimer = undefined;
    }
    if (active) this.scheduleClicks();
  }

  private scheduleClicks() {
    const anchor = this.anchor;
    const beats = this.clickBeatsMs;
    if (!anchor || !beats?.length) return;
    const now = this.context.currentTime;
    const fromS = Math.max(now, this.clickedUntilS);
    const toS = now + clickLookaheadS;
    if (toS <= fromS) return;
    this.clickBuffer ??= this.newClickBuffer();
    for (const atS of clickTimes(anchor, beats, fromS, toS)) {
      const node = new AudioBufferSourceNode(this.context, { buffer: this.clickBuffer });
      node.connect(this.volume);
      node.start(atS);
      this.clicks.push({ node, atS });
    }
    this.clickedUntilS = toS;
    // Clicks that have sounded are dropped; the click buffer lasts 12 ms.
    this.clicks = this.clicks.filter((click) => click.atS > now - 0.05);
  }

  private newClickBuffer(): AudioBuffer {
    const samples = clickSamples(this.context.sampleRate);
    const buffer = new AudioBuffer({
      numberOfChannels: 1,
      length: samples.length,
      sampleRate: this.context.sampleRate,
    });
    buffer.copyToChannel(samples, 0);
    return buffer;
  }
}
