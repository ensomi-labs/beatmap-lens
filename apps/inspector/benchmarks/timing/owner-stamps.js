// Output-clock probe for the owner's own browser and headphones. It plays nothing: it opens a
// silent AudioContext at each rate and latency hint for 8 s, records every new
// getOutputTimestamp() pair, and copies the result to the clipboard as JSON. Save it as
// `owner-stamps.json` in a results directory and run `analyze.mjs` on that directory.
//
// Use: open the Timing page in Arc with the usual output device and rate (FineTune as usual),
// click once anywhere on the page, open the DevTools console, paste this file, press Enter, wait
// about 40 s until it prints "Copied", then paste into the file. If it prints "NOT copied"
// instead, type `copy(ownerStamps)` in the console, press Enter, and paste.
(async () => {
  // The console's own `copy()` works while the console has the focus; the clipboard API refuses a
  // page that is not focused, so it is only the fallback. Read before the first await, while the
  // console's evaluation is still running.
  const consoleCopy = typeof copy === "function" ? copy : null;
  const conditions = [
    [48_000, "interactive"],
    [44_100, "interactive"],
    [48_000, "balanced"],
    [48_000, 0.003],
  ];
  const results = [];
  for (const [sampleRate, latencyHint] of conditions) {
    let context;
    try {
      context = new AudioContext({ sampleRate, latencyHint });
    } catch (error) {
      results.push({ latencyHint, sampleRate, error: String(error) });
      console.warn(`skipped ${sampleRate} ${latencyHint}: ${error}`);
      continue;
    }
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
  window.ownerStamps = json;
  let copied = false;
  if (consoleCopy) {
    try {
      consoleCopy(json);
      copied = true;
    } catch {}
  }
  if (!copied)
    copied = await navigator.clipboard.writeText(json).then(
      () => true,
      () => false,
    );
  if (copied) console.log(`Copied (${json.length} characters). Paste them into owner-stamps.json.`);
  else
    console.error(
      "NOT copied. Type copy(ownerStamps) here and press Enter, then paste into owner-stamps.json.",
    );
})().catch((error) => console.error("owner-stamps.js stopped:", error));
