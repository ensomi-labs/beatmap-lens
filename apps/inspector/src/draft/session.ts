/**
 * One Draft's trace: append-only `ensomi` v0 events (`schemaVersion: "0.1"`), folded into
 * `ensomi`'s `SessionState`, with conflict-first offer acceptance and undo/redo via backward
 * `retract` events targeting event IDs. `persist` receives every new event in order for the
 * local service's serialized writer.
 */
import {
  applyEvent,
  type BeatInput,
  type BoundaryInput,
  type Conflict,
  createInitialState,
  type DraftAudio,
  type DraftProviders,
  type EditOp,
  foldTrace,
  type PatchOffer,
  resolveActiveRetractions,
  type SessionState,
  type SoundAnchorInput,
  type Span,
  type StatementInput,
  serializeTraceNdjson,
  TRACE_SCHEMA_VERSION,
  type TraceAuthor,
  type TraceEvent,
  type TraceEventType,
  toAudioDescriptor,
  undoableTypes,
  validatePatchOffer,
} from "./ensomi-contract.ts";

export type AcceptOfferResult =
  | { ok: true; event: TraceEvent; offer: PatchOffer | undefined }
  | { ok: false; conflicts: Conflict[] };

export class DraftSession {
  events: TraceEvent[] = [];
  state: SessionState = createInitialState();
  /** Event IDs of retracts made by undo, newest last, while nothing new was committed. */
  private redoable: string[] = [];

  private readonly persist: (event: TraceEvent) => void;
  private readonly nowMs: () => number;

  constructor(
    persist: (event: TraceEvent) => void = () => {},
    nowMs: () => number = () => Date.now(),
  ) {
    this.persist = persist;
    this.nowMs = nowMs;
  }

  load(events: TraceEvent[]) {
    this.state = events.length ? foldTrace(events) : createInitialState();
    this.events = [...this.state.events];
    this.redoable = [];
  }

  commit<TPayload>(
    type: TraceEventType,
    payload: TPayload,
    author: TraceAuthor = { kind: "user" },
  ): TraceEvent<TPayload> {
    const seq = this.state.lastSeq + 1;
    const event: TraceEvent<TPayload> = {
      schemaVersion: TRACE_SCHEMA_VERSION,
      seq,
      id: `${type}_${seq}`,
      type,
      tsMs: this.nowMs(),
      author,
      payload,
    };
    this.state = applyEvent(this.state, event);
    this.events = [...this.state.events];
    if (type !== "retract" && undoableTypes.has(type)) this.redoable = [];
    this.persist(event);
    return event;
  }

  initDraft(
    audio: DraftAudio,
    draft: {
      beats: BeatInput[];
      boundaries?: BoundaryInput[];
      sounds?: SoundAnchorInput[];
      statements?: StatementInput[];
    },
    providers: DraftProviders,
  ): [TraceEvent, TraceEvent] {
    const bound = this.commit(
      "audio_bound",
      {
        audio: toAudioDescriptor(audio),
        draftAudio: audio,
        providers,
      },
      { kind: "host" },
    );
    const authorKind =
      providers.beats.kind === "model"
        ? "model"
        : providers.beats.kind === "rule"
          ? "rule"
          : "import";
    const loaded = this.commit(
      "draft_loaded",
      {
        beats: draft.beats,
        boundaries: draft.boundaries ?? [],
        sounds: draft.sounds ?? [],
        ...(draft.statements?.length ? { statements: draft.statements } : {}),
        replace: true,
      },
      { kind: authorKind, id: providers.beats.name },
    );
    return [bound, loaded];
  }

  applyEdit(opOrOps: EditOp | EditOp[], author: TraceAuthor = { kind: "user" }): TraceEvent {
    const payload = Array.isArray(opOrOps) ? { ops: opOrOps } : opOrOps;
    return this.commit("edit", payload, author);
  }

  upsertStatement(statement: StatementInput, author: TraceAuthor = { kind: "user" }): TraceEvent {
    return this.commit("statement", { action: "upsert", statement }, author);
  }

  deactivateStatement(id: string, author: TraceAuthor = { kind: "user" }): TraceEvent {
    return this.commit("statement", { action: "deactivate", id }, author);
  }

  recordSignal(
    scope: Span | "song",
    reason: string,
    generation: number,
    statementIds?: string[],
    author: TraceAuthor = { kind: "user" },
  ): TraceEvent {
    return this.commit(
      "signal",
      {
        scope,
        reason,
        generation,
        ...(statementIds ? { statementIds } : {}),
      },
      author,
    );
  }

  recordOfferBatch(
    offers: PatchOffer[],
    author: TraceAuthor = { kind: "rule" },
    batchId?: string,
  ): TraceEvent {
    return this.commit(
      "offer_batch",
      {
        batchId: batchId ?? offers[0]?.batchId ?? `batch_${this.state.lastSeq + 1}`,
        offers,
      },
      author,
    );
  }

  acceptOffer(offerId: string, author: TraceAuthor = { kind: "user" }): AcceptOfferResult {
    const offer = this.state.offers.get(offerId);
    if (!offer) {
      return {
        ok: false,
        conflicts: [
          {
            id: `conflict:missing:${offerId}`,
            kind: "range_changed",
            message: `Offer "${offerId}" does not exist in session state.`,
          },
        ],
      };
    }
    const conflicts = validatePatchOffer(this.state, offer);
    if (conflicts.length > 0) return { ok: false, conflicts };
    const event = this.commit("offer_accept", { offerId }, author);
    return { ok: true, event, offer: this.state.offers.get(offerId) };
  }

  rejectOffer(
    offerId: string,
    reason?: string,
    author: TraceAuthor = { kind: "user" },
  ): TraceEvent | undefined {
    if (!this.state.offers.has(offerId)) return undefined;
    return this.commit("offer_reject", { offerId, ...(reason ? { reason } : {}) }, author);
  }

  exportNdjson(): string {
    return serializeTraceNdjson(this.events);
  }

  get canUndo(): boolean {
    return this.undoTarget() !== undefined;
  }

  get canRedo(): boolean {
    return this.redoable.length > 0;
  }

  undo(): TraceEvent | undefined {
    const targetEventId = this.undoTarget();
    if (targetEventId === undefined) return undefined;
    const event = this.commit("retract", { targetEventId });
    this.redoable.push(event.id);
    return event;
  }

  redo(): TraceEvent | undefined {
    const targetEventId = this.redoable.pop();
    if (targetEventId === undefined) return undefined;
    return this.commit("retract", { targetEventId });
  }

  /** The latest active undoable event's ID. */
  private undoTarget(): string | undefined {
    const retracted = resolveActiveRetractions(this.events);
    for (let i = this.events.length - 1; i >= 0; i -= 1) {
      const event = this.events[i];
      if (!event || event.type === "retract" || retracted.has(event.id)) continue;
      if (undoableTypes.has(event.type)) return event.id;
    }
    return undefined;
  }
}
