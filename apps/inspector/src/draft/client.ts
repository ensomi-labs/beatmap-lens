import type { TraceEvent } from "./ensomi-contract.ts";

const prefix = "/api/draft";

/** Calls the local Draft service; a failure carries the service's error name and message. */
export async function draftRequest(
  operation: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const response = await fetch(`${prefix}/${operation}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Beatmap-Lens-Local": "1" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const failure: { name: string; error: string } = await response.json();
    throw Object.assign(new Error(failure.error), { name: failure.name });
  }
  return response;
}

export async function draftJson<T>(
  operation: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return (await draftRequest(operation, body, signal)).json();
}

export type TraceSaveStatus = "none" | "saving" | "saved" | "error";

export interface TraceQueueSnapshot {
  path: string | null;
  status: TraceSaveStatus;
  pendingCount: number;
  lastError: string | null;
}

/**
 * Per-trace ordered queue of unacknowledged trace events.
 *
 * On append failure the failed prefix stays queued and is retried in order on the next append or
 * explicit retry; status reaches `"saved"` ONLY when the entire prefix up to the latest event is
 * acknowledged. Relies on the server's idempotent `(seq, id)` append handling so retrying a
 * prefix never duplicates persisted lines.
 */
export class TraceAppendQueue {
  private path: string | null = null;
  private pending: TraceEvent[] = [];
  private inFlight = false;
  private status: TraceSaveStatus = "none";
  private lastError: string | null = null;
  private epoch = 0;

  private readonly send: (tracePath: string, events: TraceEvent[]) => Promise<unknown>;
  private readonly onChange: (snapshot: TraceQueueSnapshot) => void;

  constructor(
    send: (tracePath: string, events: TraceEvent[]) => Promise<unknown>,
    onChange: (snapshot: TraceQueueSnapshot) => void = () => {},
  ) {
    this.send = send;
    this.onChange = onChange;
  }

  snapshot(): TraceQueueSnapshot {
    return {
      path: this.path,
      status: this.status,
      pendingCount: this.pending.length,
      lastError: this.lastError,
    };
  }

  attach(tracePath: string, initialEvents: readonly TraceEvent[] = [], alreadySaved = false) {
    this.epoch += 1;
    this.path = tracePath;
    this.pending = alreadySaved ? [] : [...initialEvents];
    this.inFlight = false;
    this.lastError = null;
    this.status = this.pending.length ? "saving" : alreadySaved ? "saved" : "none";
    this.emit();
    if (this.pending.length) void this.flush();
  }

  detach() {
    this.epoch += 1;
    this.path = null;
    this.pending = [];
    this.inFlight = false;
    this.lastError = null;
    this.status = "none";
    this.emit();
  }

  enqueue(events: readonly TraceEvent[]) {
    if (!this.path || !events.length) return;
    this.pending.push(...events);
    this.lastError = null;
    if (!this.inFlight) {
      this.status = "saving";
      this.emit();
      void this.flush();
    } else {
      this.emit();
    }
  }

  retry(): Promise<void> {
    if (!this.path || !this.pending.length) return Promise.resolve();
    this.lastError = null;
    this.status = "saving";
    this.emit();
    return this.flush();
  }

  private async flush(): Promise<void> {
    if (this.inFlight || !this.path || !this.pending.length) return;
    this.inFlight = true;
    const myEpoch = this.epoch;
    const targetPath = this.path;
    this.status = "saving";
    this.emit();
    try {
      while (this.epoch === myEpoch && this.path === targetPath && this.pending.length > 0) {
        const batch = this.pending.slice();
        await this.send(targetPath, batch);
        if (this.epoch !== myEpoch || this.path !== targetPath) return;
        this.pending.splice(0, batch.length);
        this.emit();
      }
      if (this.epoch === myEpoch && this.path === targetPath) {
        this.inFlight = false;
        this.lastError = null;
        this.status = this.pending.length === 0 ? "saved" : "saving";
        this.emit();
      }
    } catch (failure) {
      if (this.epoch !== myEpoch || this.path !== targetPath) return;
      this.inFlight = false;
      this.lastError = (failure as Error).message || String(failure);
      this.status = "error";
      this.emit();
    }
  }

  private emit() {
    this.onChange(this.snapshot());
  }
}

/** Splits interleaved float32 PCM into channels. */
export function deinterleave(bytes: ArrayBuffer, channels: number): Float32Array[] {
  const samples = new Float32Array(bytes);
  const frames = Math.floor(samples.length / channels);
  return Array.from({ length: channels }, (_, channel) => {
    const data = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame++)
      data[frame] = samples[frame * channels + channel] as number;
    return data;
  });
}
