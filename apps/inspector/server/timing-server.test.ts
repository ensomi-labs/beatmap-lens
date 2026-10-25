import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { startTimingServer } from "./timing-server";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(frames: number, { key = true } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lens-timing-server-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dist", "assets"), { recursive: true });
  await writeFile(join(root, "dist", "index.html"), "<!doctype html><title>Inspector</title>");
  await writeFile(join(root, "dist", "assets", "app.js"), "export {};");
  if (key) await writeFile(join(root, "keys.json"), '{"version":1,"session_id":"s","passages":{}}');
  const pcm = new Uint8Array(new Float32Array(16).buffer);
  await writeFile(join(root, "audio.f32"), pcm);
  const session = {
    version: 1,
    id: "s",
    clock: "osu",
    reveal_key_path: "keys.json",
    passages: [
      {
        id: "p",
        start_ms: 0,
        end_ms: 0.1,
        audio: {
          path: "audio.f32",
          format: "f32le-interleaved",
          sha256: "x",
          pcm_sha256: createHash("sha256").update(pcm).digest("hex"),
          sample_rate: 48_000,
          channels: 2,
          frames,
          decode: {},
        },
      },
    ],
  };
  const sessionPath = join(root, "s.timing.json");
  await writeFile(sessionPath, JSON.stringify(session));
  return { root, sessionPath };
}

it("serves the built page and the service, opening the session from the root address", async () => {
  const { root, sessionPath } = await fixture(8);
  const server = await startTimingServer({
    session: sessionPath,
    port: 0,
    staticRoot: join(root, "dist"),
  });
  cleanups.push(server.close);
  expect(server.summary).toBe("s: 1 passages, 1 recordings at 48000 Hz");
  const origin = new URL(server.url).origin;
  const home = await fetch(`${origin}/`, { redirect: "manual" });
  expect(home.status).toBe(302);
  expect(home.headers.get("location")).toBe(`/timing?session=${encodeURIComponent(sessionPath)}`);
  expect(await (await fetch(`${origin}/timing`)).text()).toContain("Inspector");
  expect((await fetch(`${origin}/assets/app.js`)).headers.get("content-type")).toContain(
    "javascript",
  );
  expect((await fetch(`${origin}/../s.timing.json`)).status).toBe(404);
  const opened = await fetch(`${origin}/api/inspector/timing/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Beatmap-Lens-Local": "1" },
    body: JSON.stringify({ session_path: sessionPath }),
  });
  expect((await opened.json()).passages).toHaveLength(1);
});

it("answers malformed requests without stopping", async () => {
  const { root, sessionPath } = await fixture(8);
  const server = await startTimingServer({
    session: sessionPath,
    port: 0,
    staticRoot: join(root, "dist"),
  });
  cleanups.push(server.close);
  const origin = new URL(server.url).origin;
  expect((await fetch(`${origin}/%E0%A4%A`)).status).toBe(400);
  expect((await fetch(`${origin}/assets/%E0%A4%A.js`)).status).toBe(400);
  // A Host header that is not a URL authority fails while routing the service request.
  const status = await new Promise<number | undefined>((done, fail) => {
    const sent = request(
      `${origin}/api/inspector/timing/open`,
      { method: "POST", headers: { Host: "a b" } },
      (response) => {
        response.resume();
        done(response.statusCode);
      },
    );
    sent.on("error", fail);
    sent.end("{}");
  });
  expect(status).toBe(400);
  expect((await fetch(`${origin}/timing`)).status).toBe(200);
});

it("refuses to start when a PCM file's size disagrees with the session", async () => {
  const { root, sessionPath } = await fixture(9);
  await expect(
    startTimingServer({ session: sessionPath, port: 0, staticRoot: join(root, "dist") }),
  ).rejects.toThrow("size");
});

it("refuses to start when the identity key file is missing", async () => {
  const { root, sessionPath } = await fixture(8, { key: false });
  await expect(
    startTimingServer({ session: sessionPath, port: 0, staticRoot: join(root, "dist") }),
  ).rejects.toThrow(`Missing identity key file: ${join(root, "keys.json")}`);
});
