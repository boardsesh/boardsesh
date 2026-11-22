import { describe, expect, it } from 'vitest';
import { acquireSprayHoldEditorLease } from '../spray-hold-editor-lease';

describe('native hold editor ownership', () => {
  it('serializes owners of one draft while allowing independent drafts', async () => {
    const releaseFirst = await acquireSprayHoldEditorLease('one', new AbortController().signal);
    let secondOwns = false;
    const second = acquireSprayHoldEditorLease('one', new AbortController().signal).then((release) => {
      secondOwns = true;
      return release;
    });
    const releaseOther = await acquireSprayHoldEditorLease('two', new AbortController().signal);
    expect(secondOwns).toBe(false);
    releaseFirst();
    const releaseSecond = await second;
    expect(secondOwns).toBe(true);
    releaseSecond();
    releaseOther();
  });
  it('cancels a waiter without skipping the current owner or stranding its successor', async () => {
    const releaseFirst = await acquireSprayHoldEditorLease('cancel', new AbortController().signal);
    const cancelled = new AbortController();
    const waiting = acquireSprayHoldEditorLease('cancel', cancelled.signal);
    cancelled.abort();
    await expect(waiting).rejects.toThrow('aborted');
    let thirdOwns = false;
    const third = acquireSprayHoldEditorLease('cancel', new AbortController().signal).then((release) => {
      thirdOwns = true;
      return release;
    });
    await Promise.resolve();
    expect(thirdOwns).toBe(false);
    releaseFirst();
    (await third)();
    expect(thirdOwns).toBe(true);
  });
});
