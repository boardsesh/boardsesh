import { describe, it, expect } from 'vitest';
import { createSheetOpenSerializer } from '../sheet-open-serializer';

describe('createSheetOpenSerializer', () => {
  it('opens immediately when no dismissal is in flight', () => {
    const serializer = createSheetOpenSerializer<string>();
    expect(serializer.requestOpen('climb-a')).toBe('open-now');
    // Nothing was stashed by an immediate open.
    expect(serializer.takePendingOpen()).toBeNull();
  });

  it('defers an open requested mid-dismiss and flushes it on dismiss', () => {
    const serializer = createSheetOpenSerializer<string>();
    serializer.handleAnimate(-1); // dismiss animation starts
    expect(serializer.requestOpen('climb-b')).toBe('deferred');
    expect(serializer.takePendingOpen()).toBe('climb-b');
    // Flush is one-shot — a second flush (e.g. timeout fallback after
    // onDismiss already ran) is a no-op.
    expect(serializer.takePendingOpen()).toBeNull();
  });

  it('keeps only the latest request when several arrive while dismissing', () => {
    const serializer = createSheetOpenSerializer<string>();
    serializer.handleAnimate(-1);
    expect(serializer.requestOpen('climb-b')).toBe('deferred');
    expect(serializer.requestOpen('climb-c')).toBe('deferred');
    expect(serializer.takePendingOpen()).toBe('climb-c');
  });

  it('clears the dismissing flag when the sheet settles back on screen', () => {
    const serializer = createSheetOpenSerializer<string>();
    serializer.handleAnimate(-1); // swipe-down starts closing…
    serializer.handleAnimate(0); // …but springs back open
    expect(serializer.requestOpen('climb-b')).toBe('open-now');
  });

  it('drops a stashed open when the sheet settles back on screen (aborted close)', () => {
    const serializer = createSheetOpenSerializer<string>();
    serializer.handleAnimate(-1); // close starts
    expect(serializer.requestOpen('climb-b')).toBe('deferred'); // stashed mid-close
    serializer.handleAnimate(0); // close aborted — sheet springs back
    // The stash must not survive to replay on the next, unrelated close.
    expect(serializer.takePendingOpen()).toBeNull();
  });

  it('clears the dismissing flag after a flush so the next open is immediate', () => {
    const serializer = createSheetOpenSerializer<string>();
    serializer.handleAnimate(-1);
    expect(serializer.takePendingOpen()).toBeNull(); // dismissed with nothing stashed
    expect(serializer.requestOpen('climb-b')).toBe('open-now');
  });

  it('treats a present animation like any on-screen settle', () => {
    const serializer = createSheetOpenSerializer<string>();
    serializer.handleAnimate(-1);
    serializer.handleAnimate(0); // re-present
    serializer.handleAnimate(-1); // close again
    expect(serializer.requestOpen('climb-d')).toBe('deferred');
  });
});
