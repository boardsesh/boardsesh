// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireSprayHoldEditorLease } from '../spray-hold-editor-lease.web';
afterEach(() => {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
});
describe('browser hold editor ownership', () => {
  it('keeps the origin lock held until the caller releases it', async () => {
    let held: Promise<void> | undefined;
    const request = vi.fn((_name: string, _options: unknown, operation: () => Promise<void>) => {
      held = operation();
      return held;
    });
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } });
    const abort = new AbortController();
    const release = await acquireSprayHoldEditorLease('user:wall:17', abort.signal);
    expect(request).toHaveBeenCalledWith(
      'boardsesh-hold-editor:user:wall:17',
      { mode: 'exclusive', signal: abort.signal },
      expect.any(Function),
    );
    let finished = false;
    void held?.then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    release();
    await held;
    expect(finished).toBe(true);
  });
  it('fails closed when origin locking is unavailable or denied', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    await expect(acquireSprayHoldEditorLease('draft', new AbortController().signal)).rejects.toThrow('unavailable');
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request: () => Promise.reject(new Error('denied')) },
    });
    await expect(acquireSprayHoldEditorLease('draft', new AbortController().signal)).rejects.toThrow('denied');
  });
});
