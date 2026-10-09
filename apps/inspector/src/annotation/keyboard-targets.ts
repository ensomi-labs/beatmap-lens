/** Keys typed into a field belong to that field, not to workspace shortcuts. */
export function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    Boolean(target.closest("input, textarea, select, [contenteditable='true']"))
  );
}

/** Space and Enter activate a focused control natively, so shortcuts must not handle them too. */
export function isNativeActivationTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    Boolean(target.closest("button, a, summary, [role='button'], [role='link']"))
  );
}
