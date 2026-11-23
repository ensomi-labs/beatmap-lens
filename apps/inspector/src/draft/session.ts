/**
 * One Draft's trace: append-only events, the folded state, and undo/redo as retract events.
 * Commits apply incrementally; a retract re-folds the whole trace. `persist` receives every new
 * event in order, for the local service's serialized writer.
 */
import {
  activeEvents,
  applyEvent,
  type DraftState,
  emptyState,
  fold,
  type TraceBody,
  type TraceEvent,
  undoableTypes,
} from "./ensomi-contract";

export class DraftSession {
  events: TraceEvent[] = [];
  state: DraftState = emptyState();
  /** Seqs of the retracts made by undo, newest last, while nothing new was committed. */
  private redoable: number[] = [];

  private readonly persist: (event: TraceEvent) => void;
  private readonly now: () => string;

  constructor(
    persist: (event: TraceEvent) => void = () => {},
    now: () => string = () => new Date().toISOString(),
  ) {
    this.persist = persist;
    this.now = now;
  }

  load(events: TraceEvent[]) {
    this.events = [...events];
    this.state = fold(this.events);
    this.redoable = [];
  }

  commit(body: TraceBody): TraceEvent {
    const event = this.append(body);
    if (body.type === "retract") this.state = fold(this.events);
    else {
      this.state = applyEvent(this.state, event);
      if (undoableTypes.has(body.type)) this.redoable = [];
    }
    return event;
  }

  get canUndo(): boolean {
    return this.undoTarget() !== undefined;
  }

  get canRedo(): boolean {
    return this.redoable.length > 0;
  }

  undo(): TraceEvent | undefined {
    const target = this.undoTarget();
    if (target === undefined) return undefined;
    const event = this.commit({ type: "retract", target });
    this.redoable.push(event.seq);
    return event;
  }

  redo(): TraceEvent | undefined {
    const target = this.redoable.pop();
    if (target === undefined) return undefined;
    return this.commit({ type: "retract", target });
  }

  /** The latest undoable event still in force. */
  private undoTarget(): number | undefined {
    return activeEvents(this.events)
      .filter((event) => undoableTypes.has(event.type))
      .at(-1)?.seq;
  }

  private append(body: TraceBody): TraceEvent {
    const event = {
      ...body,
      seq: (this.events.at(-1)?.seq ?? 0) + 1,
      at: this.now(),
    } as TraceEvent;
    this.events.push(event);
    this.persist(event);
    return event;
  }
}
