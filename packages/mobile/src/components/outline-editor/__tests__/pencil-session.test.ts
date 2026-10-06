import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  markPencilSeen,
  parsePencilOnlyOverride,
  pencilSeenThisSession,
  pencilStrokeTarget,
  pencilToggleAvailable,
  resetPencilSessionForTests,
  resolvePencilOnly,
  subscribePencilSession,
} from '../pencil-session';

afterEach(() => resetPencilSessionForTests());

describe('resolvePencilOnly', () => {
  it.each([
    // tablet, seen, override → pencil only
    [true, false, null, false],
    [true, true, null, true],
    [true, true, false, false],
    [true, false, true, true],
    [true, true, true, true],
    [false, true, null, false],
    [false, true, true, false],
  ] as const)('tablet %s, Pencil seen %s, override %s → %s', (tablet, pencilSeen, override, expected) => {
    expect(resolvePencilOnly({ tablet, pencilSeen, override })).toBe(expected);
  });
});

describe('pencilToggleAvailable', () => {
  it('shows the toggle once a Pencil is seen, or after an earlier choice, and only on the tablet layout', () => {
    expect(pencilToggleAvailable({ tablet: true, pencilSeen: false, override: null })).toBe(false);
    expect(pencilToggleAvailable({ tablet: true, pencilSeen: true, override: null })).toBe(true);
    expect(pencilToggleAvailable({ tablet: true, pencilSeen: false, override: false })).toBe(true);
    expect(pencilToggleAvailable({ tablet: false, pencilSeen: true, override: true })).toBe(false);
  });
});

describe('parsePencilOnlyOverride', () => {
  it('reads only a stored boolean as a choice', () => {
    expect(parsePencilOnlyOverride(true)).toBe(true);
    expect(parsePencilOnlyOverride(false)).toBe(false);
    expect(parsePencilOnlyOverride(null)).toBeNull();
    expect(parsePencilOnlyOverride('true')).toBeNull();
  });
});

describe('the Pencil session', () => {
  it('reports the first Pencil once, tells subscribers, and survives an editor remount', () => {
    const listener = vi.fn();
    const unsubscribe = subscribePencilSession(listener);
    expect(pencilSeenThisSession()).toBe(false);
    expect(markPencilSeen()).toBe(true);
    expect(markPencilSeen()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    // A new subscriber (the remounted editor) reads the same answer.
    expect(pencilSeenThisSession()).toBe(true);
  });
});

describe('pencilStrokeTarget', () => {
  const selected = { id: 9, cx: 100, cy: 100, r: 20 };

  it('retraces the selected hold when the stroke is centred inside it', () => {
    expect(pencilStrokeTarget({ cx: 110, cy: 95 }, selected)).toEqual({ kind: 'retrace', id: 9 });
    expect(pencilStrokeTarget({ cx: 120, cy: 100 }, selected)).toEqual({ kind: 'retrace', id: 9 });
  });

  it('adds a new hold when the stroke is centred outside it, or nothing is selected', () => {
    expect(pencilStrokeTarget({ cx: 121, cy: 100 }, selected)).toEqual({ kind: 'add' });
    expect(pencilStrokeTarget({ cx: 100, cy: 100 }, null)).toEqual({ kind: 'add' });
  });
});
