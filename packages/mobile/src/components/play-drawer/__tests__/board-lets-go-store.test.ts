// Board plan item 8: who has the board after a drive's link dropped, the
// words for it, and the caption's store.
import type { TFunction } from 'i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LETS_GO_NOTICE_MS,
  LETS_GO_BUTTON_MS,
  clearLetsGo,
  formatLetsGo,
  getLetsGo,
  getBoardTakenButtonNotice,
  resolveLetsGoTaker,
  resolveLetsGoTargetBoardId,
  showLetsGo,
  takenByOf,
} from '../board-lets-go-store';
import { MAX_CAPTION_NAME_LENGTH } from '../track-label-text';

const t = ((key: string, values?: Record<string, string>) =>
  values ? `${key} ${JSON.stringify(values)}` : key) as unknown as TFunction<'session'>;

/** Signed in as `user-me`; the drive started at sequence 4 and the link dropped at 6. */
const BASE = { driveStartSeq: 4, dropSeq: 6, viewerUserId: 'user-me', signedIn: true } as const;

describe('resolveLetsGoTargetBoardId', () => {
  it('recovers a sanitized saved board ID only from its exact UUID binding', () => {
    const saved = { uuid: 'board-a' };
    expect(resolveLetsGoTargetBoardId(saved, { boardId: 7, boardUuid: 'board-a' })).toBe(7);
    expect(resolveLetsGoTargetBoardId(saved, { boardId: 7, boardUuid: 'board-b' })).toBeNull();
    expect(resolveLetsGoTargetBoardId(saved, { boardId: 7 })).toBeNull();
    expect(resolveLetsGoTargetBoardId(saved, { boardId: null, boardUuid: 'board-a' })).toBeNull();
    expect(resolveLetsGoTargetBoardId(saved, null)).toBeNull();
    expect(resolveLetsGoTargetBoardId({ uuid: '' }, { boardId: 7, boardUuid: '' })).toBeNull();
    expect(resolveLetsGoTargetBoardId(null, { boardId: 7, boardUuid: 'board-a' })).toBeNull();
  });

  it('never replaces a known numeric ID with the current presence board', () => {
    expect(resolveLetsGoTargetBoardId({ uuid: 'board-a', boardId: 9 }, { boardId: 7, boardUuid: 'board-a' })).toBe(9);
  });
});

describe('resolveLetsGoTaker', () => {
  it('names a signed-in holder who took the board during the drive', () => {
    expect(
      resolveLetsGoTaker({ ...BASE, holder: { userId: 'user-sam', displayName: 'Sam' }, holderChangeSeq: 5 }),
    ).toEqual({ kind: 'taken_named', name: 'Sam' });
  });

  it('trims the name, and falls back to another phone when there is none', () => {
    const at = (displayName: string | null) =>
      resolveLetsGoTaker({ ...BASE, holder: { userId: 'user-sam', displayName }, holderChangeSeq: 7 });
    expect(at('  Sam ')).toEqual({ kind: 'taken_named', name: 'Sam' });
    expect(at('   ')).toEqual({ kind: 'taken' });
    expect(at(null)).toEqual({ kind: 'taken' });
  });

  it('never names an anonymous holder, even one carrying a name', () => {
    expect(resolveLetsGoTaker({ ...BASE, holder: { userId: null, displayName: 'Ghost' }, holderChangeSeq: 7 })).toEqual(
      {
        kind: 'taken',
      },
    );
  });

  it('finds no taker with no holder, the climber’s own account, or a holder from before the drive', () => {
    expect(resolveLetsGoTaker({ ...BASE, holder: null, holderChangeSeq: 9 })).toBeNull();
    expect(
      resolveLetsGoTaker({ ...BASE, holder: { userId: 'user-me', displayName: 'Me' }, holderChangeSeq: 9 }),
    ).toBeNull();
    expect(
      resolveLetsGoTaker({ ...BASE, holder: { userId: 'user-sam', displayName: 'Sam' }, holderChangeSeq: 4 }),
    ).toBeNull();
  });

  it('counts a holder that could be this phone only once it changed after the drop', () => {
    // Signed out: an anonymous holder may be this phone's own last hold.
    const signedOut = { ...BASE, viewerUserId: null, signedIn: false };
    const anonymous = { userId: null, displayName: null };
    expect(resolveLetsGoTaker({ ...signedOut, holder: anonymous, holderChangeSeq: 6 })).toBeNull();
    expect(resolveLetsGoTaker({ ...signedOut, holder: anonymous, holderChangeSeq: 7 })).toEqual({ kind: 'taken' });
    // Signed in but the climber's id isn't known yet: a named holder may be them.
    const unknownSelf = { ...BASE, viewerUserId: null };
    const sam = { userId: 'user-sam', displayName: 'Sam' };
    expect(resolveLetsGoTaker({ ...unknownSelf, holder: sam, holderChangeSeq: 6 })).toBeNull();
    expect(resolveLetsGoTaker({ ...unknownSelf, holder: sam, holderChangeSeq: 7 })).toEqual({
      kind: 'taken_named',
      name: 'Sam',
    });
    // Signed in: an anonymous holder is never this phone, so the drive's start counts.
    expect(resolveLetsGoTaker({ ...BASE, holder: anonymous, holderChangeSeq: 5 })).toEqual({ kind: 'taken' });
  });

  it('counts a holder with an account from the drive’s start when the climber is signed out', () => {
    // A signed-out phone holds anonymously: Sam is never this phone.
    const signedOut = { ...BASE, viewerUserId: null, signedIn: false };
    const sam = { userId: 'user-sam', displayName: 'Sam' };
    expect(resolveLetsGoTaker({ ...signedOut, holder: sam, holderChangeSeq: 5 })).toEqual({
      kind: 'taken_named',
      name: 'Sam',
    });
    expect(resolveLetsGoTaker({ ...signedOut, holder: sam, holderChangeSeq: 4 })).toBeNull();
  });
});

describe('takenByOf', () => {
  it('maps the notice to Drive Mode Ended’s takenBy', () => {
    expect(takenByOf({ kind: 'taken_named', name: 'Sam' })).toBe('named');
    expect(takenByOf({ kind: 'taken' })).toBe('anonymous');
    expect(takenByOf({ kind: 'dropped' })).toBeNull();
    expect(takenByOf(null)).toBeNull();
  });
});

describe('formatLetsGo', () => {
  it('words each notice', () => {
    expect(formatLetsGo({ kind: 'taken_named', name: 'Sam' }, t)).toBe(
      'playView.wallControl.boardTakenBy {"name":"Sam"}',
    );
    expect(formatLetsGo({ kind: 'taken' }, t)).toBe('playView.wallControl.boardTakenOtherPhone');
    expect(formatLetsGo({ kind: 'dropped' }, t)).toBe('playView.wallControl.boardDropped');
  });

  it('cuts a long name for the caption only', () => {
    const name = 'Alexandra Montgomery-Fitzgerald';
    expect(name.length).toBeGreaterThan(MAX_CAPTION_NAME_LENGTH);
    expect(formatLetsGo({ kind: 'taken_named', name }, t)).toContain(name);
    const short = formatLetsGo({ kind: 'taken_named', name }, t, { short: true });
    expect(short).not.toContain(name);
    expect(short).toContain('…');
  });
});

describe('the caption store', () => {
  afterEach(() => {
    vi.useRealTimers();
    clearLetsGo();
  });

  it('shows a notice for its time, and a newer one restarts the clock', () => {
    vi.useFakeTimers();
    showLetsGo({ kind: 'dropped' }, 7);
    vi.advanceTimersByTime(LETS_GO_NOTICE_MS - 1);
    showLetsGo({ kind: 'taken' }, 7);
    vi.advanceTimersByTime(LETS_GO_NOTICE_MS - 1);
    expect(getLetsGo()).toEqual({ kind: 'taken' });
    vi.advanceTimersByTime(1);
    expect(getLetsGo()).toBeNull();
  });

  it('clears at once', () => {
    showLetsGo({ kind: 'dropped' }, 7);
    clearLetsGo();
    expect(getLetsGo()).toBeNull();
  });

  it('keeps the confirmed takeover button for three seconds, independently of the caption', () => {
    vi.useFakeTimers();
    showLetsGo({ kind: 'taken_named', name: 'Sam' }, 7);
    expect(getBoardTakenButtonNotice(7)).toBe(true);
    vi.advanceTimersByTime(LETS_GO_BUTTON_MS - 1);
    expect(getBoardTakenButtonNotice(7)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(getBoardTakenButtonNotice(7)).toBe(false);
    expect(getLetsGo()).toEqual({ kind: 'taken_named', name: 'Sam' });
    vi.advanceTimersByTime(LETS_GO_NOTICE_MS - LETS_GO_BUTTON_MS);
    expect(getLetsGo()).toBeNull();
  });

  it('does not treat an unattributed drop as someone else connecting', () => {
    showLetsGo({ kind: 'dropped' }, 7);
    expect(getBoardTakenButtonNotice(7)).toBe(false);
  });

  it('never shows a takeover button for an unknown or different target board', () => {
    showLetsGo({ kind: 'taken' });
    expect(getBoardTakenButtonNotice(null)).toBe(false);
    expect(getBoardTakenButtonNotice(7)).toBe(false);
    showLetsGo({ kind: 'taken' }, 7);
    expect(getBoardTakenButtonNotice(7)).toBe(true);
    expect(getBoardTakenButtonNotice(9)).toBe(false);
    expect(getBoardTakenButtonNotice(null)).toBe(false);
  });

  it('clears both timers and prevents an earlier notice clearing its replacement', () => {
    vi.useFakeTimers();
    showLetsGo({ kind: 'taken' }, 7);
    vi.advanceTimersByTime(LETS_GO_BUTTON_MS - 1);
    clearLetsGo();
    expect(getBoardTakenButtonNotice(7)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    showLetsGo({ kind: 'taken_named', name: 'Lee' }, 7);
    vi.advanceTimersByTime(1);
    expect(getBoardTakenButtonNotice(7)).toBe(true);
    vi.advanceTimersByTime(LETS_GO_BUTTON_MS - 1);
    expect(getBoardTakenButtonNotice(7)).toBe(false);
    showLetsGo({ kind: 'dropped' }, 7);
    expect(getBoardTakenButtonNotice(7)).toBe(false);
  });
});
