export function normalizeSearchName(text: string): string {
  return text.trim();
}

/**
 * Whether the displayed search field text is genuinely out of sync with the
 * committed `name` and so needs re-seeding into the field.
 *
 * The field stores the RAW text the user typed (with any leading/trailing
 * whitespace), while `name` is committed normalized (trimmed). A trim-only
 * difference — e.g. the user is mid-typing "crimp " before the next word — is
 * NOT a desync and must not trigger a re-seed, which would yank the in-progress
 * whitespace out from under the cursor. Compare normalized values so only a
 * real external change (board restore, recent pill, cancel) re-seeds the field.
 */
export function visibleSearchTextNeedsSync(visibleText: string, name: string): boolean {
  return normalizeSearchName(visibleText) !== name;
}
