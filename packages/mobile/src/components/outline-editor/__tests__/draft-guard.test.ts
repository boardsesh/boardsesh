import { describe, expect, it, vi } from 'vitest';
import { withUnsavedDraftGuard } from '../draft-guard';

// Regression cover for the bug this guard exists to fix: a validated stroke used
// to disappear on a stray tap, a kind switch or a step to the next placement,
// with nothing asked. The property that matters is negative — with a draft in
// flight, nothing reaches the action except through the confirmation.

describe('withUnsavedDraftGuard', () => {
  it('runs the action straight through when there is no draft', () => {
    const action = vi.fn();
    const confirm = vi.fn();
    withUnsavedDraftGuard(false, action, confirm);
    expect(action).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('never runs the action itself when a draft is in flight', () => {
    const action = vi.fn();
    const confirm = vi.fn();
    withUnsavedDraftGuard(true, action, confirm);
    expect(action).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('runs the action once the confirmation says yes', () => {
    const action = vi.fn();
    // Stands in for the user tapping "Discard".
    const confirmAndAccept = (onConfirm: () => void) => onConfirm();
    withUnsavedDraftGuard(true, action, confirmAndAccept);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('leaves the draft alone when the confirmation is dismissed', () => {
    const action = vi.fn();
    // Stands in for "Keep drawing" — the dialog closes, the callback never fires.
    const confirmAndDismiss = () => {};
    withUnsavedDraftGuard(true, action, confirmAndDismiss);
    expect(action).not.toHaveBeenCalled();
  });

  it('hands the confirmation the exact action it is deciding about', () => {
    const action = vi.fn();
    // Collected into an array rather than a `let`: assigning inside the callback
    // leaves TypeScript narrowing the variable to its initial type, and CI
    // typechecks test files.
    const captured: Array<() => void> = [];
    withUnsavedDraftGuard(true, action, (onConfirm) => captured.push(onConfirm));
    expect(captured).toHaveLength(1);
    captured[0]();
    expect(action).toHaveBeenCalledTimes(1);
  });
});
