import { createHash, randomInt, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { appendFile, readFile, realpath } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type {
  BlindPassage,
  OpenTiming,
  PassageTarget,
  RevealedName,
  SaveRequest,
  SaveResponse,
} from "../src/timing/contracts.ts";
import {
  type AudioInputV1,
  encodeEvent,
  markFromRecord,
  parseSession,
  readMarksFile,
  revealEvent,
  revealedNames,
  type SaveEventV1,
  saveEvent,
  type TimingPassage,
  type TimingSession,
} from "../src/timing/format.ts";
import {
  assertLocalRequest,
  fullPath,
  localService,
  localServicePlugin,
  readBody,
  sendJson,
} from "./local-service.ts";

const prefix = "/api/inspector/timing";
/** Must match the page's proposal palette. */
export const proposalPaletteSize = 9;

interface Session {
  session: TimingSession;
  marksPath: string;
  passages: PassageState[];
  /** Opaque handle to audio input; the page never sees a path. */
  audio: Map<string, AudioInputV1>;
  verified: Map<string, Promise<Buffer>>;
}

interface PassageState {
  passage: TimingPassage;
  audioHandle: string;
  /** Legend order and colours; kept for the service's life and replayed from the last save. */
  legend: { key: string; colour_index: number }[];
  save?: SaveEventV1;
  revealed: boolean;
}

export const timingPlugin = () => localServicePlugin("inspector-timing", prefix, timingHandler);

export const createTimingMiddleware = () => localService(prefix, timingHandler());

export function timingHandler() {
  const sessions = new Map<string, Session>();
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    assertLocalRequest(request, url);
    if (request.method !== "POST") throw new Error("Use POST for timing operations.");
    const body = JSON.parse((await readBody(request)).toString("utf8"));
    const operation = url.pathname.slice(prefix.length + 1);
    if (operation === "open") {
      const id = randomUUID();
      const session = await openSession(body.session_path);
      sessions.set(id, session);
      sendJson(response, describe(id, session));
      return;
    }
    const session = sessions.get(body.session_id);
    if (!session) throw new Error("Reopen the session to reconnect the local service.");
    if (operation === "audio") {
      const bytes = await verifiedAudio(session, body.handle);
      response.setHeader("Content-Type", "application/octet-stream");
      response.end(bytes);
      return;
    }
    const state = session.passages[(body as PassageTarget).passage_index];
    if (!state) throw new Error("Choose a passage.");
    if (operation === "passage") sendJson(response, await blindPassage(session, state));
    else if (operation === "save") sendJson(response, await save(session, state, body));
    else if (operation === "reveal") sendJson(response, await reveal(session, state, body.save_id));
    else throw new Error("Unknown timing operation.");
  };
}

async function openSession(input: string): Promise<Session> {
  const sessionPath = await realpath(fullPath(input));
  const folder = dirname(sessionPath);
  // Paths inside the session are relative to it unless absolute; `~` is not expanded.
  const session = parseSession(await readFile(sessionPath, "utf8"), (path) =>
    isAbsolute(path) ? path : resolve(folder, path),
  );
  const name = basename(sessionPath)
    .replace(/\.json$/, "")
    .replace(/\.timing$/, "");
  const marksPath = join(folder, `${name}.timing.marks.jsonl`);
  const text = await readFile(marksPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return "";
  });
  const { saves, reveals } = readMarksFile(text, session.id);
  const audio = new Map<string, AudioInputV1>();
  const handles = new Map<string, string>();
  const passages = session.passages.map((passage): PassageState => {
    let handle = handles.get(passage.audio.path);
    if (!handle) {
      handle = `a${handles.size + 1}`;
      handles.set(passage.audio.path, handle);
      audio.set(handle, passage.audio);
    }
    const save = saves.get(passage.id);
    return {
      passage,
      audioHandle: handle,
      legend: legendFor(
        passage.proposals.map((proposal) => proposal.key),
        save,
      ),
      ...(save ? { save } : {}),
      revealed: reveals.has(passage.id),
    };
  });
  return { session, marksPath, passages, audio, verified: new Map() };
}

/** A saved passage keeps the legend it was saved with; other keys are shuffled with fresh colours. */
function legendFor(keys: string[], save: SaveEventV1 | undefined) {
  const legend = (save?.proposals_shown ?? [])
    .filter((shown) => keys.includes(shown.key))
    .sort((a, b) => a.legend_index - b.legend_index)
    .map(({ key, colour_index }) => ({ key, colour_index }));
  const used = new Set(legend.map((entry) => entry.colour_index));
  const colours = shuffle(
    Array.from({ length: proposalPaletteSize }, (_, index) => index).filter((c) => !used.has(c)),
  );
  const fresh = shuffle(keys.filter((key) => !legend.some((entry) => entry.key === key)));
  fresh.forEach((key, index) => {
    legend.push({ key, colour_index: colours[index] ?? index % proposalPaletteSize });
  });
  return legend;
}

function shuffle<T>(values: T[]): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const other = randomInt(index + 1);
    [result[index], result[other]] = [result[other] as T, result[index] as T];
  }
  return result;
}

function describe(sessionId: string, { session, marksPath, passages }: Session): OpenTiming {
  return {
    session_id: sessionId,
    id: session.id,
    clock: session.clock,
    marks_path: marksPath,
    passages: passages.map(({ passage, audioHandle, save, revealed }) => ({
      id: passage.id,
      title: passage.title,
      start_ms: passage.start_ms,
      end_ms: passage.end_ms,
      context_before_ms: passage.context_before_ms,
      context_after_ms: passage.context_after_ms,
      hint: passage.hint,
      flags: passage.flags,
      loudness_gain_db: passage.loudness_gain_db,
      audio: {
        handle: audioHandle,
        format: passage.audio.format,
        sample_rate: passage.audio.sample_rate,
        channels: passage.audio.channels,
        frames: passage.audio.frames,
      },
      saved: Boolean(save),
      revealed,
    })),
  };
}

/** The PCM payload, checked once against its stated size and hash before the page receives it. */
function verifiedAudio(session: Session, handle: string): Promise<Buffer> {
  const audio = session.audio.get(handle);
  if (!audio) throw new Error("Unknown audio handle.");
  let pending = session.verified.get(handle);
  if (!pending) {
    pending = readFile(audio.path).then((bytes) => {
      if (bytes.length !== audio.frames * audio.channels * 4)
        throw new Error("The PCM payload's size does not match its frames and channels.");
      if (createHash("sha256").update(bytes).digest("hex") !== audio.pcm_sha256)
        throw new Error("The PCM payload's SHA-256 does not match the session.");
      return bytes;
    });
    // A failed check is retried on the next request instead of being cached.
    pending.catch(() => session.verified.delete(handle));
    session.verified.set(handle, pending);
  }
  return pending;
}

async function blindPassage(session: Session, state: PassageState): Promise<BlindPassage> {
  const beats = new Map(state.passage.proposals.map((p) => [p.key, p.beats_ms]));
  return {
    proposals: state.legend.map(({ key, colour_index }) => ({
      key,
      colour_index,
      beats_ms: beats.get(key) ?? [],
    })),
    saved: state.save
      ? {
          save_id: state.save.id,
          time: state.save.time,
          setup: state.save.setup,
          marks: state.save.marks.map(markFromRecord),
        }
      : null,
    ...(state.revealed ? { names: await names(session, state) } : {}),
  };
}

async function save(
  session: Session,
  state: PassageState,
  body: SaveRequest,
): Promise<SaveResponse> {
  if (!body.setup?.trim()) throw new Error("Describe the playback setup before saving.");
  const { start_ms, end_ms } = state.passage;
  for (const mark of body.marks) {
    if (mark.kind !== "beat" && mark.kind !== "unbeat") throw new Error("Unknown mark kind.");
    if (!(mark.time_ms >= start_ms && mark.time_ms <= end_ms))
      throw new Error("Marks must lie inside the passage.");
  }
  const event = saveEvent({
    id: randomUUID(),
    time: new Date().toISOString(),
    session: session.session,
    passage: state.passage,
    marks: body.marks,
    setup: body.setup.trim(),
    playback: body.playback,
    page: body.page,
    proposals: state.legend.map(({ key, colour_index }, legend_index) => ({
      key,
      colour_index,
      legend_index,
      visible_at_save: body.visible_keys.includes(key),
    })),
  });
  await append(session, encodeEvent(event));
  state.save = event;
  return { save_id: event.id, time: event.time };
}

/** Names leave the service only for a passage whose current snapshot is saved. */
async function reveal(
  session: Session,
  state: PassageState,
  saveId: string,
): Promise<{ names: RevealedName[] }> {
  if (!state.save) throw new Error("Save this passage's marks before revealing names.");
  if (state.save.id !== saveId) throw new Error("Save the current marks before revealing names.");
  if (!state.revealed) {
    await append(
      session,
      encodeEvent(
        revealEvent({
          id: randomUUID(),
          time: new Date().toISOString(),
          sessionId: session.session.id,
          passageId: state.passage.id,
          afterSaveId: state.save.id,
        }),
      ),
    );
    state.revealed = true;
  }
  return { names: await names(session, state) };
}

async function names(session: Session, state: PassageState): Promise<RevealedName[]> {
  return revealedNames(
    await readFile(session.session.revealKeyPath, "utf8"),
    session.session.id,
    state.passage.id,
    state.legend.map((entry) => entry.key),
  );
}

function append(session: Session, line: string) {
  return appendFile(session.marksPath, line, {
    flag: constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
  });
}
