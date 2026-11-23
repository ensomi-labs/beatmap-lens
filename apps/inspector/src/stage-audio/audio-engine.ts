import { type ClockLine, OutputClock, type PlaybackAnchor, sourceAtContext } from "./clock";
import { motionAt, type PlayheadMotion, planMotion } from "./display";
import { heardSourceMs } from "./input";
import { clickTimes, clickWindow, frameOf, frameTime, planPlay } from "./transport";

/** How far ahead a start is scheduled, so its context time is known exactly. */
const scheduleLeadS = 0.03;
/** How far ahead a seamless buffer swap cross-schedules stop/start on an integer frame. */
const swapLeadS = 0.02;
/**
 * Mark clicks are scheduled this far ahead, topped up at this interval: the main thread may stall
 * for most of a second without losing one.
 */
const clickLookaheadS = 1;
const clickIntervalMs = 100;
/**
 * A click due sooner than this may already be in the block the audio thread renders: a change
 * leaves it alone, and the scheduler never starts one that close (it would sound late).
 */
const clickMarginMinimumS = 0.02;

/**
 * A 2 kHz tick at full scale on its first sample, decaying with a 5 ms time constant over 25 ms,
 * so what is heard starts exactly at the mark and carries over a loud mix. The click volume scales
 * it.
 */
export function clickSamples(sampleRate: number): Float32Array<ArrayBuffer> {
  return Float32Array.from({ length: Math.round(sampleRate * 0.025) }, (_, index) => {
    const t = index / sampleRate;
    return Math.cos(2 * Math.PI * 2000 * t) * Math.exp(-t / 0.005);
  });
}

/**
 * The Web Audio side of the Timing engine. One `AudioContext` at the recording's own rate. Each
 * play is a new `AudioBufferSourceNode` (start, loop and stop planned on whole frames by
 * `transport.ts`) into a loudness gain and a volume gain, then the destination. Nothing else is in
 * the music's path: no compressor, limiter or analyser. When the listener turns them on, clicks at
 * their own beats are separate sources, scheduled on the same context clock, through their own
 * click gain into the volume gain: the click volume sets their level against the music, the volume
 * sets both.
 *
 * The engine feeds the output stamps into the clock model (`clock.ts`) and answers the display
 * path (`motion`, `shownAt`) and the input path (`heardAt`) from it and the playing anchor.
 */
export class TimingAudioEngine {
  readonly context: AudioContext;
  private readonly loudness: GainNode;
  private readonly volume: GainNode;
  private readonly clickLevel: GainNode;
  private readonly clock = new OutputClock();
  private buffer: AudioBuffer | undefined;
  private source: AudioBufferSourceNode | undefined;
  private sourceStartCtxS = 0;
  private retiringSources: { node: AudioBufferSourceNode; untilS: number }[] = [];
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
    // A suspension or a device change breaks the relation between the clocks.
    context.addEventListener("statechange", () => this.clock.reset());
    this.loudness = new GainNode(context);
    this.volume = new GainNode(context);
    this.loudness.connect(this.volume).connect(context.destination);
    this.clickLevel = new GainNode(context);
    this.clickLevel.connect(this.volume);
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

  /** Copies each channel into a new buffer at the context's rate without altering playback. */
  createBuffer(channels: Float32Array[], frames: number): AudioBuffer {
    const buffer = new AudioBuffer({
      numberOfChannels: channels.length,
      length: frames,
      sampleRate: this.context.sampleRate,
    });
    channels.forEach((data, channel) => {
      buffer.copyToChannel(data as Float32Array<ArrayBuffer>, channel);
    });
    return buffer;
  }

  /** Copies each channel into a buffer of the context's rate; the samples are not converted. */
  load(channels: Float32Array[], frames: number): AudioBuffer {
    this.stop();
    const buffer = this.createBuffer(channels, frames);
    this.buffer = buffer;
    return buffer;
  }

  /** Stops playback immediately and drops any loaded buffer. */
  unload(): void {
    this.stop();
    this.buffer = undefined;
  }

  /**
   * Seamlessly replaces `this.buffer` with `nextBuffer`. While playing, schedules the old
   * `AudioBufferSourceNode` to stop and the new `AudioBufferSourceNode` to start at the exact same
   * sample-aligned `swapContextTime = ctx.currentTime + 0.020` without interrupting transport,
   * resetting `playing`, or creating an undefined `heardAt()` window.
   */
  swapBuffer(nextBuffer: AudioBuffer): void {
    this.buffer = nextBuffer;
    const oldSource = this.source;
    const anchor = this.anchor;
    if (!oldSource || !anchor) return;

    const sr = this.context.sampleRate;
    const nowS = this.context.currentTime;
    this.retiringSources = this.retiringSources.filter((item) => {
      if (item.untilS <= nowS) {
        item.node.disconnect();
        return false;
      }
      return true;
    });

    const swapFrame = Math.ceil((nowS + swapLeadS) * sr - 1e-6);
    const rawSwapS = frameTime(swapFrame, sr);
    const whenS = rawSwapS <= anchor.startCtxS ? anchor.startCtxS : rawSwapS;
    const sourceOffsetMs = sourceAtContext(anchor, whenS);
    if (!anchor.loop && sourceOffsetMs >= anchor.endMs) {
      return;
    }

    const offsetFrame = frameOf(sourceOffsetMs, sr);
    const offsetS = frameTime(offsetFrame, sr);

    let loopStartS: number | null = null;
    let loopEndS: number | null = null;
    if (anchor.loop) {
      const loopStart = frameOf(anchor.loop.startMs, sr);
      const loopEnd = Math.max(loopStart + 1, frameOf(anchor.loop.endMs, sr));
      loopStartS = frameTime(loopStart, sr);
      loopEndS = frameTime(loopEnd, sr);
    }
    const endFrame = frameOf(anchor.endMs, sr);
    const stopS = anchor.loop
      ? null
      : whenS + Math.max(0, endFrame - offsetFrame) / sr / anchor.rate;

    oldSource.onended = null;
    if (whenS <= this.sourceStartCtxS) {
      oldSource.stop();
      oldSource.disconnect();
    } else {
      oldSource.stop(whenS);
      this.retiringSources.push({ node: oldSource, untilS: whenS });
    }

    const nextSource = new AudioBufferSourceNode(this.context, {
      buffer: nextBuffer,
      playbackRate: anchor.rate,
      loop: loopStartS !== null,
      ...(loopStartS !== null && loopEndS !== null
        ? { loopStart: loopStartS, loopEnd: loopEndS }
        : {}),
    });
    nextSource.connect(this.loudness);
    nextSource.start(whenS, offsetS);
    if (stopS !== null) nextSource.stop(stopS);
    nextSource.onended = () => {
      if (this.source !== nextSource) return;
      this.frozenMs = anchor.endMs;
      this.release();
      this.onEnded?.(anchor.endMs);
    };
    this.source = nextSource;
    this.sourceStartCtxS = whenS;
  }

  /**
   * Starts at `fromMs` (the caller applies pre-roll); loops `loop` or stops at `endMs`. Resolves
   * false without starting when a stop or a later play came while the context resumed, so two
   * quick presses never leave an untracked source playing. A running context starts at once.
   */
  async play(options: {
    fromMs: number;
    endMs: number;
    rate: number;
    loop: { startMs: number; endMs: number } | null;
  }): Promise<boolean> {
    if (!this.buffer) throw new Error("The audio is not loaded yet.");
    this.stop();
    const token = ++this.playToken;
    if (this.context.state !== "running") {
      this.resuming = token;
      try {
        await this.context.resume();
      } finally {
        if (this.resuming === token) this.resuming = 0;
      }
      if (token !== this.playToken) return false;
    }
    const buffer = this.buffer;
    if (!buffer) return false;
    const plan = planPlay(options, {
      currentTimeS: this.context.currentTime,
      sampleRate: this.context.sampleRate,
      leadS: scheduleLeadS,
    });
    const source = new AudioBufferSourceNode(this.context, {
      buffer,
      playbackRate: options.rate,
      loop: plan.loopStartS !== null,
      ...(plan.loopStartS !== null && plan.loopEndS !== null
        ? { loopStart: plan.loopStartS, loopEnd: plan.loopEndS }
        : {}),
    });
    source.connect(this.loudness);
    source.start(plan.whenS, plan.offsetS);
    if (plan.stopS !== null) source.stop(plan.stopS);
    const anchor = plan.anchor;
    source.onended = () => {
      if (this.source !== source) return;
      this.frozenMs = anchor.endMs;
      this.release();
      this.onEnded?.(anchor.endMs);
    };
    this.source = source;
    this.sourceStartCtxS = plan.whenS;
    this.anchor = anchor;
    this.frozenMs = anchor.startSourceMs;
    this.clickedUntilS = 0;
    this.syncClicks();
    return true;
  }

  /**
   * Takes the output's latest stamp into the clock model. The workspace calls it on each transport
   * step (every 25 ms while playing); `heardAt` calls it before mapping a key.
   */
  sampleClock() {
    if (this.context.state === "running") this.clock.observe(this.context.getOutputTimestamp());
  }

  /** The relation between page time and heard context time, or undefined before output starts. */
  clockLine(): ClockLine | undefined {
    return this.clock.line();
  }

  /**
   * How the playhead moves during this play, for frames on the page clock, or undefined when
   * nothing plays, the context is suspended (the transport freezes) or output has not started.
   * Each call also keeps the position a suspension freezes at current: the workspace asks for the
   * motion on every transport step and evaluates it itself, so `shownAt` is rarely called.
   */
  motion(offsetMs: number): PlayheadMotion | undefined {
    const anchor = this.anchor;
    const line = this.clock.line();
    if (!anchor || !line || this.context.state !== "running") return undefined;
    const motion = planMotion(anchor, line, offsetMs);
    this.frozenMs = motionAt(motion, performance.now());
    return motion;
  }

  /**
   * The source time the playhead shows for a frame at `frameMs` (page clock), or undefined when
   * nothing plays. While the context is not running it freezes at the position shown when the
   * motion was last asked for or evaluated.
   */
  shownAt(frameMs: number, offsetMs: number): number | undefined {
    if (!this.anchor) return undefined;
    this.sampleClock();
    const motion = this.motion(offsetMs);
    if (!motion) return this.frozenMs;
    const shown = motionAt(motion, frameMs);
    this.frozenMs = shown;
    return shown;
  }

  /**
   * The source time heard at `eventMs` (an event's `timeStamp`), without the playhead offset;
   * undefined when nothing plays or the output has not yet reached the start.
   */
  heardAt(eventMs: number): number | undefined {
    const anchor = this.anchor;
    if (!anchor || this.context.state !== "running") return undefined;
    this.sampleClock();
    const line = this.clock.line();
    return line ? heardSourceMs(anchor, line, eventMs) : undefined;
  }

  /**
   * Clicks at these source times while playing, or none for null. A change takes effect from now:
   * clicks not yet sounding are rescheduled, so a nudged or new mark is heard on the next pass.
   */
  setClicks(beatsMs: readonly number[] | null) {
    this.clickBeatsMs = beatsMs ? [...beatsMs] : null;
    const keepUntilS = this.context.currentTime + this.clickMarginS();
    this.clicks = this.clicks.filter((click) => {
      if (click.atS <= keepUntilS) return true;
      click.node.stop();
      click.node.disconnect();
      return false;
    });
    this.clickedUntilS = Math.min(this.clickedUntilS, keepUntilS);
    this.syncClicks();
  }

  /**
   * Stops at once, without a fade, and cancels a play waiting to start; returns the position the
   * playhead was showing. Stopping when nothing plays does nothing else.
   */
  stop(offsetMs = 0): number | undefined {
    this.playToken++;
    this.resuming = 0;
    const shown = this.shownAt(performance.now(), offsetMs);
    if (this.source) {
      this.source.onended = null;
      this.source.stop();
    }
    for (const item of this.retiringSources) {
      try {
        item.node.stop();
      } catch {}
    }
    this.release();
    return shown;
  }

  setVolume(value: number) {
    this.volume.gain.value = value;
  }

  /** The click's peak as a fraction of full scale, before the volume. */
  setClickVolume(value: number) {
    this.clickLevel.gain.value = value;
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
    this.sourceStartCtxS = 0;
    for (const item of this.retiringSources) {
      item.node.disconnect();
    }
    this.retiringSources = [];
    this.anchor = undefined;
    for (const click of this.clicks) {
      click.node.stop();
      click.node.disconnect();
    }
    this.clicks = [];
    this.syncClicks();
  }

  /** At least two render buffers, as the audio thread renders a device buffer at a time. */
  private clickMarginS(): number {
    return Math.max(clickMarginMinimumS, 2 * (this.context.baseLatency || 0));
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
    const window = clickWindow(now, this.clickedUntilS, clickLookaheadS, this.clickMarginS());
    if (!window) return;
    this.clickBuffer ??= this.newClickBuffer();
    for (const atS of clickTimes(anchor, beats, window.fromS, window.toS)) {
      const node = new AudioBufferSourceNode(this.context, { buffer: this.clickBuffer });
      node.connect(this.clickLevel);
      node.start(atS);
      this.clicks.push({ node, atS });
    }
    this.clickedUntilS = window.toS;
    // Clicks that have sounded are dropped; the click buffer lasts 25 ms.
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

export { TimingAudioEngine as StageAudioEngine };
