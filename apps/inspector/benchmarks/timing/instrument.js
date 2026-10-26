// Injected into the Timing page before its own scripts (Playwright `addInitScript`). It observes
// the page through the browser APIs the page uses and records into `window.__bench` only while
// `__bench.recording` is true; the page's code is not changed, so the same script measures the
// baseline build (playhead drawn on the overlay canvas) and the engine build (playhead element).
//
// - frames: per animation frame, its time stamp, when its first callback started, the summed time
//   of its callbacks, when the last ended, and when a task posted from it ran (after the frame's
//   style, layout, paint and commit on the main thread);
// - playhead: the playhead's device x per frame: from the overlay canvas's fillRect in the
//   playhead colour (baseline), or from the playhead element's computed transform when
//   `samplePlayhead` is on (engine build; reading it forces a style update, so it is off while
//   main-thread time is measured);
// - baseDraws: each redraw of the base canvas, its duration, how many mark lines it drew, and its
//   proposal lines (one every 250 ms of source), so the analysis maps device x to source time
//   without reading the page's state; the last draw before recording is kept as `lastBaseDraw`;
// - stamps: AudioContext.getOutputTimestamp() every frame and every 4 ms;
// - starts: every AudioBufferSourceNode.start(), with the context time when it was called;
// - keys: each keydown's timeStamp and when the page received it;
// - loafs: Long Animation Frame entries (frames over 50 ms), with their script attribution.
(() => {
  const bench = {
    recording: false,
    samplePlayhead: false,
    frameTs: -1,
    frame: 0,
    current: null,
    baseDraw: null,
    lastBaseDraw: null,
    frames: [],
    playhead: [],
    baseDraws: [],
    stamps: [],
    starts: [],
    keys: [],
    loafs: [],
    contexts: [],
    timeOrigin: performance.timeOrigin,
  };
  window.__bench = bench;
  const now = () => performance.now();
  const playheadColour = "#ff4d4f";
  const stageBackground = "#101820";

  const channel = new MessageChannel();
  const posted = [];
  channel.port1.onmessage = () => {
    const record = posted.shift();
    if (record) record.after = now();
  };

  function finishCallback(started) {
    const ended = now();
    const record = bench.current;
    if (record) {
      record.cbMs += ended - started;
      record.end = ended;
    }
    if (bench.baseDraw) {
      bench.baseDraw.end = ended;
      if (bench.recording) bench.baseDraws.push(bench.baseDraw);
      else bench.lastBaseDraw = bench.baseDraw;
      bench.baseDraw = null;
    }
  }

  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) =>
    raf((ts) => {
      if (ts !== bench.frameTs) {
        bench.frameTs = ts;
        bench.frame++;
        bench.current = null;
        if (bench.recording) {
          const record = { frame: bench.frame, ts, start: now(), cbMs: 0, end: 0, after: 0 };
          bench.frames.push(record);
          bench.current = record;
          posted.push(record);
          channel.port2.postMessage(0);
        }
      }
      const started = now();
      try {
        callback(ts);
      } finally {
        finishCallback(started);
      }
    });

  const fillRect = CanvasRenderingContext2D.prototype.fillRect;
  CanvasRenderingContext2D.prototype.fillRect = function (x, y, w, h) {
    const canvas = this.canvas;
    const overlay = canvas.classList?.contains("timing-stage-overlay");
    const style = this.fillStyle;
    if (!overlay && style === stageBackground && w === canvas.width && h === canvas.height) {
      bench.baseDraw = { frame: bench.frame, start: now(), end: 0, marks: 0, bars: [] };
    } else if (h > 100 && w <= 8) {
      const alpha = this.globalAlpha;
      if (overlay && style === playheadColour && Math.abs(alpha - 0.75) < 0.01) {
        if (bench.recording)
          bench.playhead.push({ frame: bench.frame, ts: bench.frameTs, x: x + w / 2, at: now() });
      } else if (!overlay && Math.abs(alpha - 0.85) < 0.01) bench.baseDraw?.bars.push(x + w / 2);
      else if (!overlay && (style === "#ffffff" || style === "#8fb3ff") && bench.baseDraw)
        bench.baseDraw.marks++;
    }
    return fillRect.call(this, x, y, w, h);
  };

  /** The playhead element's centre in device px, from its computed transform. */
  function elementPlayheadX() {
    const element = document.querySelector(".timing-stage-playhead");
    if (!element) return null;
    const transform = getComputedStyle(element).transform;
    const match = /matrix\(([^)]+)\)/.exec(transform);
    const tx = match ? Number(match[1].split(",")[4]) : 0;
    const width = Number.parseFloat(element.style.width) || 0;
    return (tx + width / 2) * (window.devicePixelRatio || 1);
  }
  bench.elementPlayheadX = elementPlayheadX;

  const NativeContext = window.AudioContext;
  window.AudioContext = class extends NativeContext {
    constructor(options) {
      super(options);
      bench.contexts.push(this);
    }
  };

  function sample() {
    const context = bench.contexts.at(-1);
    if (!bench.recording || !context || context.state !== "running") return;
    const stamp = context.getOutputTimestamp();
    bench.stamps.push([now(), stamp.contextTime, stamp.performanceTime, context.currentTime]);
  }
  setInterval(sample, 4);
  const sampleFrame = (ts) => {
    sample();
    if (bench.recording && bench.samplePlayhead) {
      const x = elementPlayheadX();
      if (x !== null) bench.playhead.push({ frame: bench.frame, ts, x, at: now() });
    }
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
        bench.keys.push({
          key: event.key,
          timeStamp: event.timeStamp,
          at: now(),
          repeat: event.repeat,
        });
    },
    true,
  );

  try {
    new PerformanceObserver((list) => {
      if (!bench.recording) return;
      for (const entry of list.getEntries())
        bench.loafs.push({
          startTime: entry.startTime,
          duration: entry.duration,
          blockingDuration: entry.blockingDuration,
          renderStart: entry.renderStart,
          styleAndLayoutStart: entry.styleAndLayoutStart,
          scripts: (entry.scripts ?? []).map((script) => ({
            invoker: script.invoker,
            duration: script.duration,
            sourceFunctionName: script.sourceFunctionName,
          })),
        });
    }).observe({ type: "long-animation-frame", buffered: false });
  } catch {
    bench.loafs = null;
  }
})();
