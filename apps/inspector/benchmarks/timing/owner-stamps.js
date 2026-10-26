// Output-clock probe for the owner's own browser and headphones. It plays nothing: it opens a
// silent AudioContext at each rate and latency hint for 8 s, records every new
// getOutputTimestamp() pair, and copies the result to the clipboard as JSON. Save it as
// `owner-stamps.json` in a results directory and run `analyze.mjs` on that directory.
//
// Use: open the Timing page in Arc with the usual output device and rate (FineTune as usual),
// click once anywhere on the page, open the DevTools console, paste this file, press Enter, wait
// about 40 s until it prints "copied", then paste into the file.
(async () => {
  const conditions = [
    [48_000, "interactive"],
    [44_100, "interactive"],
    [48_000, "balanced"],
    [48_000, 0.003],
  ];
  const results = [];
  for (const [sampleRate, latencyHint] of conditions) {
    const context = new AudioContext({ sampleRate, latencyHint });
    await context.resume();
    const stamps = [];
    let last = 0;
    const started = performance.now();
    await new Promise((done) => {
      const timer = setInterval(() => {
        const stamp = context.getOutputTimestamp();
        if (stamp.contextTime !== last) {
          last = stamp.contextTime;
          stamps.push([
            performance.now(),
            stamp.contextTime,
            stamp.performanceTime,
            context.currentTime,
          ]);
        }
        if (performance.now() - started > 8000) {
          clearInterval(timer);
          done();
        }
      }, 1);
    });
    const resumes = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      await context.resume();
      resumes.push(performance.now() - t0);
    }
    results.push({
      latencyHint,
      sampleRate: context.sampleRate,
      baseLatency: context.baseLatency,
      outputLatency: context.outputLatency,
      resumeRunningMs: resumes,
      stamps,
    });
    await context.close();
    console.log(`done ${sampleRate} ${latencyHint}`);
  }
  const json = JSON.stringify({
    mode: "lab",
    owner: true,
    when: new Date().toISOString(),
    userAgent: navigator.userAgent,
    brands: navigator.userAgentData?.brands ?? null,
    experiments: { contextOptions: results },
  });
  await navigator.clipboard.writeText(json).catch(() => console.log(json));
  console.log("copied");
})();
