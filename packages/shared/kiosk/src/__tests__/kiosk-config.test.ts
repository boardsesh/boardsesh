import { describe, expect, it } from 'vitest';
import {
  KioskBoardSlotSchema,
  KioskLeaderboardSchema,
  KioskLayoutSchema,
  emptyKioskLayout,
  parseKioskLayoutLenient,
} from '../kiosk-config';
import {
  KIOSK_DEFAULT_LEADERBOARD_PERIOD,
  KIOSK_LAYOUT_VERSION,
  KIOSK_PRESETS,
  MAX_KIOSK_BOARDS,
  kioskPresetForBoardCount,
} from '../constants';

// Deterministic RFC-4122 UUIDs for fixtures (z.uuid() validates the format).
const BOARD_A = '11111111-1111-4111-8111-111111111111';
const BOARD_B = '22222222-2222-4222-8222-222222222222';
const BOARD_C = '33333333-3333-4333-8333-333333333333';
const BOARD_D = '44444444-4444-4444-8444-444444444444';
const BOARD_E = '55555555-5555-4555-8555-555555555555';

function slot(boardUuid: string) {
  return { boardUuid };
}

describe('kioskPresetForBoardCount', () => {
  it('maps 1–4 boards to single/dual/triple/quad', () => {
    expect(kioskPresetForBoardCount(1)).toBe('single');
    expect(kioskPresetForBoardCount(2)).toBe('dual');
    expect(kioskPresetForBoardCount(3)).toBe('triple');
    expect(kioskPresetForBoardCount(4)).toBe('quad');
    expect(KIOSK_PRESETS).toEqual(['single', 'dual', 'triple', 'quad']);
  });

  it('returns null for 0, out-of-range, and non-integer counts', () => {
    expect(kioskPresetForBoardCount(0)).toBeNull();
    expect(kioskPresetForBoardCount(5)).toBeNull();
    expect(kioskPresetForBoardCount(-1)).toBeNull();
    expect(kioskPresetForBoardCount(2.5)).toBeNull();
  });
});

describe('KioskBoardSlotSchema', () => {
  it('accepts a slot with a uuid', () => {
    expect(KioskBoardSlotSchema.safeParse(slot(BOARD_A)).success).toBe(true);
  });

  it('rejects a slot with a non-uuid boardUuid', () => {
    expect(KioskBoardSlotSchema.safeParse({ boardUuid: 'not-a-uuid' }).success).toBe(false);
  });

  it('rejects a slot missing boardUuid', () => {
    expect(KioskBoardSlotSchema.safeParse({}).success).toBe(false);
  });
});

describe('KioskLeaderboardSchema', () => {
  it('defaults boardUuid to null and period to the session default', () => {
    const parsed = KioskLeaderboardSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.boardUuid).toBeNull();
      expect(parsed.data.period).toBe(KIOSK_DEFAULT_LEADERBOARD_PERIOD);
      expect(parsed.data.period).toBe('session');
    }
  });

  it('accepts an explicit board scope and period', () => {
    const parsed = KioskLeaderboardSchema.safeParse({ boardUuid: BOARD_A, period: 'week' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.boardUuid).toBe(BOARD_A);
      expect(parsed.data.period).toBe('week');
    }
  });

  it('rejects an unknown period', () => {
    expect(KioskLeaderboardSchema.safeParse({ period: 'yearly' }).success).toBe(false);
  });

  it('rejects a non-uuid, non-null boardUuid', () => {
    expect(KioskLeaderboardSchema.safeParse({ boardUuid: 'nope' }).success).toBe(false);
  });
});

describe('KioskLayoutSchema (strict writer)', () => {
  it('accepts the empty layout', () => {
    expect(KioskLayoutSchema.safeParse(emptyKioskLayout()).success).toBe(true);
    expect(emptyKioskLayout().theme).toBe('dark');
  });

  it('defaults legacy layouts to dark without a version bump', () => {
    const layout = KioskLayoutSchema.parse({ version: 1, boards: [slot(BOARD_A)] });
    expect(layout.theme).toBe('dark');
    expect(layout.version).toBe(1);
    expect(layout.boards).toEqual([slot(BOARD_A)]);
  });

  it.each(['dark', 'light'])('accepts an explicit %s appearance', (theme) => {
    const layout = KioskLayoutSchema.parse({ version: KIOSK_LAYOUT_VERSION, boards: [], theme });
    expect(layout.theme).toBe(theme);
  });

  it.each([null, 'automatic', 'Light', true, 17])('rejects a malformed theme: %j', (theme) => {
    expect(KioskLayoutSchema.safeParse({ version: KIOSK_LAYOUT_VERSION, boards: [], theme }).success).toBe(false);
  });

  it('treats an empty boards array as valid (create-then-configure)', () => {
    const parsed = KioskLayoutSchema.safeParse({ version: KIOSK_LAYOUT_VERSION, boards: [], leaderboard: null });
    expect(parsed.success).toBe(true);
  });

  it('defaults leaderboard to null when omitted', () => {
    const parsed = KioskLayoutSchema.safeParse({ version: KIOSK_LAYOUT_VERSION, boards: [] });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.leaderboard).toBeNull();
    }
  });

  it('accepts a full layout of MAX_KIOSK_BOARDS boards', () => {
    const boards = [BOARD_A, BOARD_B, BOARD_C, BOARD_D].map(slot);
    expect(boards).toHaveLength(MAX_KIOSK_BOARDS);
    const parsed = KioskLayoutSchema.safeParse({ version: KIOSK_LAYOUT_VERSION, boards, leaderboard: null });
    expect(parsed.success).toBe(true);
  });

  it('rejects more than MAX_KIOSK_BOARDS boards', () => {
    const boards = [BOARD_A, BOARD_B, BOARD_C, BOARD_D, BOARD_E].map(slot);
    expect(KioskLayoutSchema.safeParse({ version: KIOSK_LAYOUT_VERSION, boards, leaderboard: null }).success).toBe(
      false,
    );
  });

  it('rejects a wrong version literal', () => {
    expect(KioskLayoutSchema.safeParse({ version: 2, boards: [], leaderboard: null }).success).toBe(false);
  });

  it('defaults showInstallQr to false when omitted', () => {
    const parsed = KioskLayoutSchema.safeParse({ version: KIOSK_LAYOUT_VERSION, boards: [], leaderboard: null });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.showInstallQr).toBe(false);
    }
  });

  it('accepts an explicit showInstallQr toggle', () => {
    const parsed = KioskLayoutSchema.safeParse({
      version: KIOSK_LAYOUT_VERSION,
      boards: [slot(BOARD_A)],
      leaderboard: null,
      showInstallQr: true,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.showInstallQr).toBe(true);
    }
  });

  it('rejects a non-boolean showInstallQr', () => {
    const parsed = KioskLayoutSchema.safeParse({
      version: KIOSK_LAYOUT_VERSION,
      boards: [],
      leaderboard: null,
      showInstallQr: 'yes',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a rail scoped to all boards (boardUuid null)', () => {
    const parsed = KioskLayoutSchema.safeParse({
      version: KIOSK_LAYOUT_VERSION,
      boards: [slot(BOARD_A), slot(BOARD_B)],
      leaderboard: { boardUuid: null, period: 'session' },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a single-board rail pointing at a kiosk board', () => {
    const parsed = KioskLayoutSchema.safeParse({
      version: KIOSK_LAYOUT_VERSION,
      boards: [slot(BOARD_A), slot(BOARD_B)],
      leaderboard: { boardUuid: BOARD_B, period: 'day' },
    });
    expect(parsed.success).toBe(true);
  });

  it('superRefine: rejects duplicate board slots', () => {
    const parsed = KioskLayoutSchema.safeParse({
      version: KIOSK_LAYOUT_VERSION,
      boards: [slot(BOARD_A), slot(BOARD_A)],
      leaderboard: null,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path.join('.') === 'boards.1.boardUuid')).toBe(true);
    }
  });

  it('superRefine: rejects a single-board rail not among the kiosk boards', () => {
    const parsed = KioskLayoutSchema.safeParse({
      version: KIOSK_LAYOUT_VERSION,
      boards: [slot(BOARD_A)],
      leaderboard: { boardUuid: BOARD_B, period: 'week' },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path.join('.') === 'leaderboard.boardUuid')).toBe(true);
    }
  });

  // The epic's forward-compat contract: later PRs add fields (a slot `variant`,
  // top-level display options, rail styling) ADDITIVELY, without a version bump. That
  // only works if the writer schema strips unknown keys instead of rejecting
  // them — a future `.strict()`/strictObject hardening would silently break the
  // contract, so this test pins the stripping behaviour at every nesting level.
  it('strips unknown keys at every nesting level instead of rejecting them', () => {
    const layout = KioskLayoutSchema.parse({
      version: KIOSK_LAYOUT_VERSION,
      displayDensity: 'compact',
      boards: [{ boardUuid: BOARD_A, variant: 'compact' }],
      leaderboard: { boardUuid: BOARD_A, period: 'week', style: 'minimal' },
    });
    expect(layout).not.toHaveProperty('displayDensity');
    expect(layout.boards[0]).not.toHaveProperty('variant');
    expect(layout.leaderboard).not.toHaveProperty('style');
    expect(layout).toEqual({
      version: KIOSK_LAYOUT_VERSION,
      boards: [slot(BOARD_A)],
      leaderboard: { boardUuid: BOARD_A, period: 'week' },
      // Known additive fields receive their defaults; unknown displayDensity,
      // variant and style keys are stripped.
      showInstallQr: false,
      theme: 'dark',
    });
  });
});

describe('parseKioskLayoutLenient (forward-compat reader)', () => {
  it.each([undefined, null, 'automatic', 'Light', false, 17, {}, []])(
    'defaults absent or malformed theme %j to dark while preserving the configuration',
    (theme) => {
      const result = parseKioskLayoutLenient({
        version: KIOSK_LAYOUT_VERSION,
        boards: [slot(BOARD_A)],
        leaderboard: { boardUuid: BOARD_A, period: 'week' },
        showInstallQr: true,
        theme,
      });
      expect(result.layout.theme).toBe('dark');
      expect(result.layout.boards).toEqual([slot(BOARD_A)]);
      expect(result.layout.leaderboard).toEqual({ boardUuid: BOARD_A, period: 'week' });
      expect(result.layout.showInstallQr).toBe(true);
      expect(result.droppedBoardCount).toBe(0);
      expect(result.droppedLeaderboard).toBe(false);
    },
  );

  it.each(['dark', 'light'])('keeps a saved %s theme when repairing board slots', (theme) => {
    const result = parseKioskLayoutLenient({
      version: KIOSK_LAYOUT_VERSION,
      boards: [slot(BOARD_A), { boardUuid: 'bad' }],
      theme,
    });
    expect(result.layout.theme).toBe(theme);
    expect(result.layout.boards).toEqual([slot(BOARD_A)]);
    expect(result.droppedBoardCount).toBe(1);
  });

  it('returns the empty layout for an unknown top-level version, reporting the discarded config', () => {
    // The wholesale discard must not read as "nothing dropped": callers surface
    // these flags as data-loss warnings, so report the stored board count and
    // whether a rail was present, even though neither could be interpreted.
    const result = parseKioskLayoutLenient({
      version: 999,
      boards: [slot(BOARD_A), slot(BOARD_B)],
      leaderboard: { boardUuid: null, period: 'week' },
    });
    expect(result.layout).toEqual(emptyKioskLayout());
    expect(result.droppedBoardCount).toBe(2);
    expect(result.droppedLeaderboard).toBe(true);
  });

  it('reports zero drops for an unknown version carrying no boards and a null rail', () => {
    const result = parseKioskLayoutLenient({ version: 999, boards: [], leaderboard: null });
    expect(result.layout).toEqual(emptyKioskLayout());
    expect(result.droppedBoardCount).toBe(0);
    expect(result.droppedLeaderboard).toBe(false);
  });

  it('returns the empty layout when boards and leaderboard keys are entirely absent', () => {
    const result = parseKioskLayoutLenient({ version: KIOSK_LAYOUT_VERSION });
    expect(result.layout).toEqual(emptyKioskLayout());
    expect(result.droppedBoardCount).toBe(0);
    expect(result.droppedLeaderboard).toBe(false);
  });

  it('returns the empty layout for null / undefined / non-object input', () => {
    for (const garbage of [null, undefined, 42, 'nope', []]) {
      const result = parseKioskLayoutLenient(garbage);
      expect(result.layout).toEqual(emptyKioskLayout());
      expect(result.droppedBoardCount).toBe(0);
      expect(result.droppedLeaderboard).toBe(false);
    }
  });

  it('keeps valid slots and drops malformed ones', () => {
    const result = parseKioskLayoutLenient({
      version: KIOSK_LAYOUT_VERSION,
      boards: [slot(BOARD_A), { boardUuid: 'not-a-uuid' }, slot(BOARD_B)],
      leaderboard: null,
    });
    expect(result.layout.boards.map((each) => each.boardUuid)).toEqual([BOARD_A, BOARD_B]);
    expect(result.droppedBoardCount).toBe(1);
  });

  it('dedupes slots by boardUuid, keeping the first', () => {
    const result = parseKioskLayoutLenient({
      version: KIOSK_LAYOUT_VERSION,
      boards: [slot(BOARD_A), slot(BOARD_A), slot(BOARD_B)],
      leaderboard: null,
    });
    expect(result.layout.boards.map((each) => each.boardUuid)).toEqual([BOARD_A, BOARD_B]);
    expect(result.droppedBoardCount).toBe(1);
  });

  it('caps at MAX_KIOSK_BOARDS when a writer bypassed the strict cap', () => {
    const overBy = 2;
    const boards = [BOARD_A, BOARD_B, BOARD_C, BOARD_D, BOARD_E, '66666666-6666-4666-8666-666666666666'].map(slot);
    expect(boards.length).toBe(MAX_KIOSK_BOARDS + overBy);
    const result = parseKioskLayoutLenient({ version: KIOSK_LAYOUT_VERSION, boards, leaderboard: null });
    expect(result.layout.boards).toHaveLength(MAX_KIOSK_BOARDS);
    expect(result.droppedBoardCount).toBe(overBy);
  });

  // Forward-compat contract (see the strict-schema counterpart above): a slot
  // written by a NEWER client carrying an additive field must survive a lenient
  // read on older JS — kept, with the unknown field stripped, not dropped.
  it('keeps a slot carrying an unknown additive field, stripped', () => {
    const result = parseKioskLayoutLenient({
      version: KIOSK_LAYOUT_VERSION,
      boards: [{ boardUuid: BOARD_A, variant: 'compact' }],
      leaderboard: null,
    });
    expect(result.layout.boards).toEqual([slot(BOARD_A)]);
    expect(result.layout.boards[0]).not.toHaveProperty('variant');
    expect(result.droppedBoardCount).toBe(0);
  });

  it('repairs a combined duplicate + invalid + over-cap board list to exactly MAX_KIOSK_BOARDS', () => {
    // 7 stored slots: 1 invalid, 1 duplicate, and 5 unique valid boards (one past
    // the cap). Invalid-drop and dedupe happen before the cap, so exactly the
    // first MAX_KIOSK_BOARDS unique valid boards survive.
    const result = parseKioskLayoutLenient({
      version: KIOSK_LAYOUT_VERSION,
      boards: [
        slot(BOARD_A),
        { boardUuid: 'not-a-uuid' },
        slot(BOARD_A),
        slot(BOARD_B),
        slot(BOARD_C),
        slot(BOARD_D),
        slot(BOARD_E),
      ],
      leaderboard: null,
    });
    expect(result.layout.boards.map((each) => each.boardUuid)).toEqual([BOARD_A, BOARD_B, BOARD_C, BOARD_D]);
    expect(result.layout.boards).toHaveLength(MAX_KIOSK_BOARDS);
    expect(result.droppedBoardCount).toBe(3);
  });

  it('widens a single-board rail to all boards when its board was dropped by the cap', () => {
    // The rail names the 5th unique board, which the cap drops — the rail must
    // not keep a dangling reference; it widens to all boards instead.
    const result = parseKioskLayoutLenient({
      version: KIOSK_LAYOUT_VERSION,
      boards: [slot(BOARD_A), slot(BOARD_B), slot(BOARD_C), slot(BOARD_D), slot(BOARD_E)],
      leaderboard: { boardUuid: BOARD_E, period: 'week' },
    });
    expect(result.layout.boards.map((each) => each.boardUuid)).toEqual([BOARD_A, BOARD_B, BOARD_C, BOARD_D]);
    expect(result.layout.leaderboard).toEqual({ boardUuid: null, period: 'week' });
    expect(result.droppedLeaderboard).toBe(true);
    expect(result.droppedBoardCount).toBe(1);
  });

  it('treats a non-array boards field as an empty board list', () => {
    const result = parseKioskLayoutLenient({ version: KIOSK_LAYOUT_VERSION, boards: 'oops', leaderboard: null });
    expect(result.layout.boards).toEqual([]);
    expect(result.droppedBoardCount).toBe(0);
  });

  it('drops a malformed leaderboard to null and flags it', () => {
    const result = parseKioskLayoutLenient({
      version: KIOSK_LAYOUT_VERSION,
      boards: [slot(BOARD_A)],
      leaderboard: { period: 'from-the-future' },
    });
    expect(result.layout.leaderboard).toBeNull();
    expect(result.droppedLeaderboard).toBe(true);
  });

  it('keeps a valid rail scoped to all boards untouched', () => {
    const result = parseKioskLayoutLenient({
      version: KIOSK_LAYOUT_VERSION,
      boards: [slot(BOARD_A)],
      leaderboard: { boardUuid: null, period: 'week' },
    });
    expect(result.layout.leaderboard).toEqual({ boardUuid: null, period: 'week' });
    expect(result.droppedLeaderboard).toBe(false);
  });

  it('widens a single-board rail to all boards when its board did not survive', () => {
    const result = parseKioskLayoutLenient({
      version: KIOSK_LAYOUT_VERSION,
      boards: [slot(BOARD_A)],
      leaderboard: { boardUuid: BOARD_B, period: 'month' },
    });
    expect(result.layout.leaderboard).toEqual({ boardUuid: null, period: 'month' });
    expect(result.droppedLeaderboard).toBe(true);
  });

  it('keeps a single-board rail whose board is still present', () => {
    const result = parseKioskLayoutLenient({
      version: KIOSK_LAYOUT_VERSION,
      boards: [slot(BOARD_A), slot(BOARD_B)],
      leaderboard: { boardUuid: BOARD_B, period: 'day' },
    });
    expect(result.layout.leaderboard).toEqual({ boardUuid: BOARD_B, period: 'day' });
    expect(result.droppedLeaderboard).toBe(false);
  });

  it('defaults showInstallQr to false when the field is absent', () => {
    const result = parseKioskLayoutLenient({
      version: KIOSK_LAYOUT_VERSION,
      boards: [slot(BOARD_A)],
      leaderboard: null,
    });
    expect(result.layout.showInstallQr).toBe(false);
  });

  it('keeps an explicit showInstallQr: true', () => {
    const result = parseKioskLayoutLenient({
      version: KIOSK_LAYOUT_VERSION,
      boards: [slot(BOARD_A)],
      leaderboard: null,
      showInstallQr: true,
    });
    expect(result.layout.showInstallQr).toBe(true);
  });

  it('drops a malformed showInstallQr to false', () => {
    const result = parseKioskLayoutLenient({
      version: KIOSK_LAYOUT_VERSION,
      boards: [slot(BOARD_A)],
      leaderboard: null,
      showInstallQr: 'yes',
    });
    expect(result.layout.showInstallQr).toBe(false);
  });

  it('produces a layout the strict schema re-accepts', () => {
    const result = parseKioskLayoutLenient({
      version: KIOSK_LAYOUT_VERSION,
      boards: [slot(BOARD_A), slot(BOARD_A), { boardUuid: 'bad' }, slot(BOARD_B)],
      leaderboard: { boardUuid: BOARD_C, period: 'week' },
    });
    expect(KioskLayoutSchema.safeParse(result.layout).success).toBe(true);
  });
});
