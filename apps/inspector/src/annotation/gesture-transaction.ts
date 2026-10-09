export interface GestureTransactionSnapshot<TEditorState> {
  readonly editorState: TEditorState;
  readonly undoStackLength: number;
  readonly rangeError: string;
  readonly rangeNotePage: number;
  readonly autosavePending: boolean;
}

export interface GestureTransaction<TEditorState, TKind extends string = string> {
  readonly kind: TKind;
  readonly pointerId: number;
  readonly anchorMs: number;
  readonly startCoordinate: number;
  readonly before: GestureTransactionSnapshot<TEditorState>;
  lastCoordinate: number;
  hasValidPreview: boolean;
}

export interface GestureTransactionOptions<TEditorState, TKind extends string> {
  readonly kind: TKind;
  readonly pointerId: number;
  readonly anchorMs: number;
  readonly startCoordinate: number;
  readonly before: GestureTransactionSnapshot<TEditorState>;
}

export type GestureFinalization<TEditorState, TKind extends string, TValue> =
  | {
      readonly outcome: "commit";
      readonly transaction: GestureTransaction<TEditorState, TKind>;
      readonly value: TValue;
    }
  | {
      readonly outcome: "rollback";
      readonly transaction: GestureTransaction<TEditorState, TKind>;
    };

export type GesturePreview<TValue> =
  | { readonly outcome: "apply"; readonly firstValid: boolean; readonly value: TValue }
  | { readonly outcome: "restore" }
  | { readonly outcome: "noop" };

export function createGestureTransaction<TEditorState, TKind extends string>(
  options: GestureTransactionOptions<TEditorState, TKind>,
): GestureTransaction<TEditorState, TKind> {
  return {
    kind: options.kind,
    pointerId: options.pointerId,
    anchorMs: options.anchorMs,
    startCoordinate: options.startCoordinate,
    lastCoordinate: options.startCoordinate,
    before: options.before,
    hasValidPreview: false,
  };
}

export function updateGestureTransaction(
  transaction: GestureTransaction<unknown>,
  coordinate: number,
): void {
  transaction.lastCoordinate = coordinate;
}

export function recordValidGesturePreview(transaction: GestureTransaction<unknown>): void {
  transaction.hasValidPreview = true;
}

export function previewGestureTransaction<TValue>(
  transaction: GestureTransaction<unknown>,
  value: TValue | undefined,
): GesturePreview<TValue> {
  if (value === undefined) {
    return transaction.hasValidPreview ? { outcome: "restore" } : { outcome: "noop" };
  }
  const firstValid = !transaction.hasValidPreview;
  recordValidGesturePreview(transaction);
  return { outcome: "apply", firstValid, value };
}

export function finalizeGestureTransaction<TEditorState, TKind extends string, TValue>(
  transaction: GestureTransaction<TEditorState, TKind>,
  value: TValue | undefined,
): GestureFinalization<TEditorState, TKind, TValue> {
  return value === undefined
    ? { outcome: "rollback", transaction }
    : { outcome: "commit", transaction, value };
}
