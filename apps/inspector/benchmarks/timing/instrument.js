// Injected into the page before its own scripts (Playwright `addInitScript`). It observes the
// Timing page through the browser APIs it uses and records into `window.__bench` only while
// `__bench.recording` is true; the page's code is not changed. What it records:
// - frames: each animation frame's timestamp, when its first callback started and ended, and when
//   a task posted from it ran (after the frame's style, layout, paint and commit);
// - playhead: every vertical fillRect in the playhead colour on the overlay canvas, with its frame;
// - bars: every proposal line drawn on the base canvas (alpha 0.85, any colour), with its frame, so the analysis can map
//   device x to source time without reading the page's state;
// - stamps: AudioContext.getOutputTimestamp() sampled every frame and every 4 ms;
// - starts: every AudioBufferSourceNode.start(), with its loop settings and playback rate;
// - keys: every keydown's timeStamp and when the page received it;
// - capture (when `localStorage.benchCapture` is set): the context's output, through a
//   ScriptProcessorNode inserted in front of the destination.
(() => {
  const bench = {
    recording: false,
    frameTs: -1,
    frame: 0,
    current: null,
    frames: [],
    playhead: [],
    bars: [],
    stamps: [],
    starts: [],
    keys: [],
    capture: [],
    contexts: [],
    errors: [],
  };
  window.__bench = bench;
  const now = () => performance.now();
  const playheadColour = "#ff4d4f";

  const channel = new MessageChannel();
  const posted = [];
  channel.port1.onmessage = () => {
    const record = posted.shift();
    if (record) record.after = now();
  };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) =>
    raf((ts) => {
      if (ts !== bench.frameTs) {
        bench.frameTs = ts;
        bench.frame++;
        bench.current = null;
        if (bench.recording) {
          const record = { frame: bench.frame, ts, start: now(), end: 0, after: 0 };
          bench.frames.push(record);
          bench.current = record;
          posted.push(record);
          channel.port2.postMessage(0);
        }
      }
      try {
        callback(ts);
      } finally {
        if (bench.current) bench.current.end = now();
      }
    });

  const fillRect = CanvasRenderingContext2D.prototype.fillRect;
  CanvasRenderingContext2D.prototype.fillRect = function (x, y, w, h) {
    if (bench.recording && h > 100 && w <= 8) {
      const overlay = this.canvas.classList?.contains("timing-stage-overlay");
      const style = this.fillStyle;
      if (style === playheadColour && Math.abs(this.globalAlpha - 0.75) < 0.01)
        bench.playhead.push({ frame: bench.frame, ts: bench.frameTs, x, w, at: now(), overlay });
      else if (!overlay && Math.abs(this.globalAlpha - 0.85) < 0.01)
        bench.bars.push({ frame: bench.frame, x, w });
    }
    return fillRect.call(this, x, y, w, h);
  };

  const NativeContext = window.AudioContext;
  window.AudioContext = class extends NativeContext {
    constructor(options) {
      super(options);
      bench.contexts.push(this);
      if (localStorage.getItem("benchCapture")) installCapture(this);
    }
  };

  function sample() {
    const context = bench.contexts.at(-1);
    if (!bench.recording || !context || context.state !== "running") return;
    const stamp = context.getOutputTimestamp();
    bench.stamps.push([now(), stamp.contextTime, stamp.performanceTime, context.currentTime]);
  }
  setInterval(sample, 4);
  const sampleFrame = () => {
    sample();
    raf(sampleFrame);
  };
  raf(sampleFrame);

  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (when, offset, duration) {
    if (bench.recording)
      bench.starts.push({
        at: now(),
        ctxNow: this.context.currentTime,
        when,
        offset,
        length: this.buffer?.length ?? 0,
        rate: this.playbackRate.value,
        loop: this.loop,
        loopStart: this.loopStart,
        loopEnd: this.loopEnd,
      });
    return start.call(this, when, offset, duration);
  };

  window.addEventListener(
    "keydown",
    (event) => {
      if (bench.recording)
        bench.keys.push({ key: event.key, timeStamp: event.timeStamp, at: now(), repeat: event.repeat });
    },
    true,
  );

  /** Every connection to the destination goes through one tap, recorded block by block. */
  function installCapture(context) {
    const tap = new GainNode(context);
    const processor = context.createScriptProcessor(4096, 2, 2);
    const mute = new GainNode(context, { gain: 0 });
    const connect = AudioNode.prototype.connect;
    connect.call(tap, context.destination);
    connect.call(tap, processor);
    connect.call(processor, mute);
    connect.call(mute, context.destination);
    processor.onaudioprocess = (event) => {
      if (!bench.recording) return;
      const input = event.inputBuffer;
      bench.capture.push({
        playbackTime: event.playbackTime,
        left: input.getChannelData(0).slice(),
      });
    };
    if (!AudioNode.prototype.connect.__bench) {
      const patched = function (target, ...rest) {
        if (target instanceof AudioDestinationNode && target.context.__benchTap)
          return connect.call(this, target.context.__benchTap, ...rest);
        return connect.call(this, target, ...rest);
      };
      patched.__bench = true;
      AudioNode.prototype.connect = patched;
    }
    context.__benchTap = tap;
  }
})();
