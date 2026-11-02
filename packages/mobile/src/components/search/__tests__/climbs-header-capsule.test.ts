import { describe, expect, it, vi } from 'vitest';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import { resolveClimbsHeaderCapsule, type TrustedWallClimb } from '../climbs-header-capsule';
import { trustedWallCapsuleClimb } from '../../../lib/board-presence/presence-freshness';

// presence-freshness's hook half listens to AppState; the pure rule needs none of it.
vi.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove: () => {} }) } }));

const climb: BoardPresenceClimb = {
  climbUuid: 'wall-climb',
  name: 'Angel Eyes',
  sentAt: '2026-11-02T10:00:00.000Z',
  seq: 4,
};
const wall: TrustedWallClimb = { climb, boardId: 7, occurrenceKey: 'board-7:wall-climb:10:00' };
const shown = { loaded: true, dismissed: false };

// The held capsule reads only booleans about the queue head, so a queue change
// that alters neither builds no new capsule.
const head = (queueHeadUuid: string | null, hiddenClimbUuid: string | null = null) => ({
  wallIsQueueHead: queueHeadUuid !== null && queueHeadUuid === climb.climbUuid,
  queueHeadHidden: queueHeadUuid !== null && queueHeadUuid === hiddenClimbUuid,
});

describe('resolveClimbsHeaderCapsule', () => {
  it('shows nothing with no trusted wall climb and no hold', () => {
    expect(resolveClimbsHeaderCapsule({ wall: null, dismissal: shown, heldCue: false, ...head(null) })).toBe(null);
  });

  it('keeps the bare "You have the board" cue, with no Hide, when nothing is lit', () => {
    expect(resolveClimbsHeaderCapsule({ wall: null, dismissal: shown, heldCue: true, ...head('wall-climb') })).toEqual({
      kind: 'held',
      wall: null,
    });
  });

  // Owner decision 2026-11-02: the queue, the MiniPlayer's pick and the link no
  // longer hide the climb on the wall. Only the heldCue picks the skin.
  it.each([
    ['the queue head is another climb', 'queue-head'],
    ['the queue head IS the wall climb (the old "distinct" rule hid this)', 'wall-climb'],
    ['the queue is empty', null],
  ])('shows the climb on the wall when %s', (_case, queueHeadUuid) => {
    expect(resolveClimbsHeaderCapsule({ wall, dismissal: shown, heldCue: false, ...head(queueHeadUuid) })).toEqual({
      kind: 'wall',
      wall,
    });
  });

  it('draws the climb on the wall in the held skin, with its Hide, while this phone holds the board on it', () => {
    expect(resolveClimbsHeaderCapsule({ wall, dismissal: shown, heldCue: true, ...head('wall-climb') })).toEqual({
      kind: 'held',
      wall,
    });
  });

  it('lets the wall capsule take the slot from the hold when the wall shows another climb', () => {
    expect(resolveClimbsHeaderCapsule({ wall, dismissal: shown, heldCue: true, ...head('queue-head') })).toEqual({
      kind: 'wall',
      wall,
    });
    expect(resolveClimbsHeaderCapsule({ wall, dismissal: shown, heldCue: true, ...head(null) })).toEqual({
      kind: 'wall',
      wall,
    });
  });

  it.each([true, false])('waits for a stored Hide to load before showing anything (held cue %s)', (heldCue) => {
    expect(
      resolveClimbsHeaderCapsule({
        wall,
        dismissal: { loaded: false, dismissed: false },
        heldCue,
        ...head('wall-climb'),
      }),
    ).toBe(null);
  });

  it.each([
    [false, 'queue-head'],
    [true, 'wall-climb'],
    [true, 'queue-head'],
  ] as const)('stays hidden after Hide, never falling back to the held cue (held %s, queue %s)', (heldCue, queue) => {
    expect(
      resolveClimbsHeaderCapsule({
        wall,
        dismissal: { loaded: true, dismissed: true },
        heldCue,
        ...head(queue, 'wall-climb'),
      }),
    ).toBe(null);
  });

  // The held capsule draws the queue head without presence. When the feed drops
  // (WebSocket drop, backend deploy, weak signal) or "Turn off all lights" clears
  // it, the hidden climb must not come back in that skin.
  it('keeps a hidden climb hidden while held and the presence feed is down', () => {
    expect(
      resolveClimbsHeaderCapsule({ wall: null, dismissal: shown, heldCue: true, ...head('wall-climb', 'wall-climb') }),
    ).toBe(null);
  });

  it('draws a different queue head in the held skin while the feed is down', () => {
    expect(
      resolveClimbsHeaderCapsule({ wall: null, dismissal: shown, heldCue: true, ...head('queue-head', 'wall-climb') }),
    ).toEqual({ kind: 'held', wall: null });
  });

  // The whole show/hide matrix with the age rule in front, as ClimbTopChrome runs it.
  describe('with the presence trust rule', () => {
    const cases: Array<{
      name: string;
      linked: boolean;
      presenceFresh: boolean;
      dismissed: boolean;
      heldCue: boolean;
      queueHeadUuid: string | null;
      expected: 'wall' | 'held' | 'held-bare' | 'none';
    }> = [
      {
        name: 'fresh, unlinked',
        linked: false,
        presenceFresh: true,
        dismissed: false,
        heldCue: false,
        queueHeadUuid: 'wall-climb',
        expected: 'wall',
      },
      {
        name: 'fresh, unlinked, other queue head',
        linked: false,
        presenceFresh: true,
        dismissed: false,
        heldCue: false,
        queueHeadUuid: 'queue-head',
        expected: 'wall',
      },
      {
        name: 'stale, unlinked',
        linked: false,
        presenceFresh: false,
        dismissed: false,
        heldCue: false,
        queueHeadUuid: 'wall-climb',
        expected: 'none',
      },
      {
        name: 'stale, crewmate linked',
        linked: true,
        presenceFresh: false,
        dismissed: false,
        heldCue: false,
        queueHeadUuid: 'queue-head',
        expected: 'wall',
      },
      {
        name: 'stale, this phone linked, Material / iPad',
        linked: true,
        presenceFresh: false,
        dismissed: false,
        heldCue: false,
        queueHeadUuid: 'wall-climb',
        expected: 'wall',
      },
      {
        name: 'stale, this phone linked, iPhone held cue',
        linked: true,
        presenceFresh: false,
        dismissed: false,
        heldCue: true,
        queueHeadUuid: 'wall-climb',
        expected: 'held',
      },
      {
        name: 'fresh, dismissed',
        linked: false,
        presenceFresh: true,
        dismissed: true,
        heldCue: false,
        queueHeadUuid: null,
        expected: 'none',
      },
      {
        name: 'linked, dismissed, held cue',
        linked: true,
        presenceFresh: true,
        dismissed: true,
        heldCue: true,
        queueHeadUuid: 'wall-climb',
        expected: 'none',
      },
      {
        name: 'stale, unlinked, held cue cannot exist',
        linked: false,
        presenceFresh: false,
        dismissed: false,
        heldCue: false,
        queueHeadUuid: null,
        expected: 'none',
      },
    ];

    it.each(cases)('$name → $expected', ({ linked, presenceFresh, dismissed, heldCue, queueHeadUuid, expected }) => {
      const trusted = trustedWallCapsuleClimb(climb, { linked, presenceFresh });
      const capsule = resolveClimbsHeaderCapsule({
        wall: trusted ? { ...wall, climb: trusted } : null,
        dismissal: { loaded: true, dismissed },
        heldCue,
        ...head(queueHeadUuid, dismissed ? 'wall-climb' : null),
      });
      const kind =
        capsule === null ? 'none' : capsule.kind === 'held' && capsule.wall === null ? 'held-bare' : capsule.kind;
      expect(kind).toBe(expected);
    });
  });
});
