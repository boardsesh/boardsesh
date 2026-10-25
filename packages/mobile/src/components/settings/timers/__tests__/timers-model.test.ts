import { describe, expect, it, vi } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import type {
  MoreButtonRow,
  MoreSegmentedRow,
  MoreSelectRow,
  MoreToggleRow,
  MoreValueRow,
} from '../../../MoreForm.types';
import {
  buildTimersModel,
  REST_LENGTH_LADDER_SECONDS,
  restLengthKey,
  restLengthSummary,
  ROGUE_TIMER_STACK_FONT_SCALE,
  rogueTimerBoards,
  type TimersModelInput,
  type TimersRogueBoard,
} from '../timers-model';

const echo = (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key);

function makeInput(
  overrides: {
    rest?: Partial<TimersModelInput['rest']>;
    cues?: Partial<TimersModelInput['cues']>;
    rogue?: TimersModelInput['rogue'];
    fontScale?: number;
  } = {},
) {
  return {
    t: echo,
    rest: {
      targetSeconds: 180,
      mode: 'afterTick',
      autoAdvance: false,
      autoAdvanceBlockedByCrew: false,
      onTargetChange: vi.fn(),
      onModeChange: vi.fn(),
      onAutoAdvanceChange: vi.fn(),
      ...overrides.rest,
    },
    cues: {
      countdownCues: null,
      sound: null,
      ...overrides.cues,
    },
    rogue: overrides.rogue ?? null,
    fontScale: overrides.fontScale ?? 1,
  } satisfies TimersModelInput;
}

function rowsOf(input: TimersModelInput) {
  return buildTimersModel(input).sections.flatMap((section) => section.rows);
}
function find<T>(input: TimersModelInput, key: string, kind: string): T {
  const row = rowsOf(input).find((candidate) => candidate.key === key);
  if (row?.kind !== kind) throw new Error(`no ${kind} row ${key}`);
  return row as T;
}

describe('buildTimersModel', () => {
  it('leaves the cues section out when it has no rows', () => {
    expect(buildTimersModel(makeInput()).sections.map((section) => section.key)).toEqual(['rest']);
  });

  it('runs the rest section, then the cues when one is available', () => {
    const input = makeInput({ cues: { sound: { enabled: true, onChange: vi.fn() } } });
    expect(buildTimersModel(input).sections.map((section) => section.key)).toEqual(['rest', 'cues']);
    expect(rowsOf(makeInput()).map((row) => row.key)).toEqual(['restLength', 'restMode', 'autoAdvance']);
  });

  describe('rest length', () => {
    it('offers Off then 0:30 to 10:00 in 30 s rungs', () => {
      const row = find<MoreSelectRow>(makeInput(), 'restLength', 'select');
      expect(row.options[0]).toEqual({ key: 'off', label: 'mobile.settings.timers.restLengthOff' });
      expect(row.options.slice(1).map((option) => option.label)).toEqual(
        REST_LENGTH_LADDER_SECONDS.map(
          (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`,
        ),
      );
      expect(row.options).toHaveLength(21);
      expect(row.options[1].label).toBe('0:30');
      expect(row.options.at(-1)?.label).toBe('10:00');
    });

    it('selects the saved length, or Off when there is none', () => {
      expect(find<MoreSelectRow>(makeInput(), 'restLength', 'select').selectedKey).toBe('180');
      expect(
        find<MoreSelectRow>(makeInput({ rest: { targetSeconds: null } }), 'restLength', 'select').selectedKey,
      ).toBe('off');
    });

    it('keeps an off-ladder length as a choice, in order', () => {
      const row = find<MoreSelectRow>(makeInput({ rest: { targetSeconds: 100 } }), 'restLength', 'select');
      expect(row.selectedKey).toBe('100');
      expect(row.options.map((option) => option.label).slice(0, 5)).toEqual([
        'mobile.settings.timers.restLengthOff',
        '0:30',
        '1:00',
        '1:30',
        '1:40',
      ]);
    });

    it('keeps a length past 10:00 at the end', () => {
      const row = find<MoreSelectRow>(makeInput({ rest: { targetSeconds: 1800 } }), 'restLength', 'select');
      expect(row.options.at(-1)).toEqual({ key: '1800', label: '30:00' });
    });

    it('turns a pick into seconds, and Off into null', () => {
      const onTargetChange = vi.fn();
      const row = find<MoreSelectRow>(makeInput({ rest: { onTargetChange } }), 'restLength', 'select');
      row.onSelect('90');
      row.onSelect('off');
      expect(onTargetChange.mock.calls).toEqual([[90], [null]]);
    });
  });

  describe('cadence', () => {
    it('names the fixed window by its length', () => {
      const row = find<MoreSegmentedRow>(makeInput(), 'restMode', 'segmented');
      expect(row.options).toEqual([
        { key: 'afterTick', label: 'mobile.settings.timers.modeAfterTick' },
        { key: 'onTheMinute', label: 'mobile.settings.timers.modeEvery {"length":"3:00"}' },
      ]);
    });

    it('falls back to the plain name with no length', () => {
      const row = find<MoreSegmentedRow>(makeInput({ rest: { targetSeconds: null } }), 'restMode', 'segmented');
      expect(row.options[1].label).toBe('mobile.settings.timers.modeOnTheMinute');
    });

    it('reports the chosen cadence and explains it in the footer', () => {
      const onModeChange = vi.fn();
      const input = makeInput({ rest: { mode: 'onTheMinute', onModeChange } });
      const row = find<MoreSegmentedRow>(input, 'restMode', 'segmented');
      expect(row.selectedKey).toBe('onTheMinute');
      expect(buildTimersModel(input).sections[0].footer).toBe('mobile.settings.timers.modeOnTheMinuteHint');
      row.onSelect('afterTick');
      expect(onModeChange).toHaveBeenCalledWith('afterTick');
    });

    it('ignores a key that is not a cadence', () => {
      const onModeChange = vi.fn();
      find<MoreSegmentedRow>(makeInput({ rest: { onModeChange } }), 'restMode', 'segmented').onSelect('nonsense');
      expect(onModeChange).not.toHaveBeenCalled();
    });
  });

  describe('auto-advance', () => {
    it('is available with a length', () => {
      const row = find<MoreToggleRow>(makeInput(), 'autoAdvance', 'toggle');
      expect(row.disabled).toBe(false);
      expect(row.subtitle).toBe('mobile.settings.timers.autoAdvanceHint');
    });

    it('needs a length, and says so', () => {
      const row = find<MoreToggleRow>(makeInput({ rest: { targetSeconds: null } }), 'autoAdvance', 'toggle');
      expect(row.disabled).toBe(true);
      expect(row.subtitle).toBe('mobile.settings.timers.autoAdvanceNeedsLength');
    });

    it('gives the crew reason before the missing-length one', () => {
      const row = find<MoreToggleRow>(
        makeInput({ rest: { targetSeconds: null, autoAdvanceBlockedByCrew: true } }),
        'autoAdvance',
        'toggle',
      );
      expect(row.disabled).toBe(true);
      expect(row.subtitle).toBe('mobile.settings.timers.autoAdvanceBlocked');
    });
  });

  describe('cues', () => {
    it('has no sound row on a build that cannot play one', () => {
      expect(rowsOf(makeInput()).map((row) => row.key)).not.toContain('sound');
    });

    it('adds the sound row where a sound can play', () => {
      const onChange = vi.fn();
      const row = find<MoreToggleRow>(makeInput({ cues: { sound: { enabled: true, onChange } } }), 'sound', 'toggle');
      expect(row.value).toBe(true);
      row.onValueChange(false);
      expect(onChange).toHaveBeenCalledWith(false);
    });

    it('writes the countdown switch', () => {
      const onChange = vi.fn();
      const row = find<MoreToggleRow>(
        makeInput({ cues: { countdownCues: { enabled: true, onChange } } }),
        'countdownCues',
        'toggle',
      );
      expect(row.value).toBe(true);
      row.onValueChange(false);
      expect(onChange).toHaveBeenCalledWith(false);
    });

    it('leaves the countdown row out until something reads it', () => {
      expect(rowsOf(makeInput()).map((row) => row.key)).not.toContain('countdownCues');
    });
  });
});

describe('restLengthKey and restLengthSummary', () => {
  it('treat null and zero as Off', () => {
    expect(restLengthKey(null)).toBe('off');
    expect(restLengthKey(0)).toBe('off');
    expect(restLengthSummary(echo, 0)).toBe('mobile.settings.timers.restLengthOff');
  });

  it('shows a saved length as m:ss', () => {
    expect(restLengthSummary(echo, 90)).toBe('1:30');
  });
});

function rogueBoard(overrides: Partial<TimersRogueBoard> = {}): TimersRogueBoard {
  return { uuid: 'board-1', name: 'Home wall', timerName: null, busy: false, link: null, ...overrides };
}

function rogueInput(boards: TimersRogueBoard[]) {
  return { boards, onPair: vi.fn(), onRemove: vi.fn() };
}

describe('the gym timer section', () => {
  it('is left out when signed out', () => {
    expect(buildTimersModel(makeInput()).sections.map((section) => section.key)).not.toContain('rogue');
  });

  it('comes after the rest and cues sections', () => {
    const input = makeInput({
      cues: { sound: { enabled: true, onChange: vi.fn() } },
      rogue: rogueInput([rogueBoard()]),
    });
    const section = buildTimersModel(input).sections.at(-1);
    expect(buildTimersModel(input).sections.map((candidate) => candidate.key)).toEqual(['rest', 'cues', 'rogue']);
    expect(section?.title).toBe('mobile.settings.timers.rogueTitle');
    expect(section?.footer).toBe('mobile.settings.timers.rogueFooter');
  });

  it('says so when the climber owns no board yet, the fact first and the way out under it', () => {
    const row = find<MoreValueRow>(makeInput({ rogue: rogueInput([]) }), 'rogueNoBoards', 'value');
    expect(row).toEqual({
      kind: 'value',
      key: 'rogueNoBoards',
      label: 'mobile.settings.timers.rogueNoBoardsTitle',
      subtitle: 'mobile.settings.timers.rogueNoBoards',
    });
  });

  it.each([
    [1, 'trailing'],
    [ROGUE_TIMER_STACK_FONT_SCALE, 'trailing'],
    [1.35, 'below'],
    [3.12, 'below'],
  ] as const)('at text size %s puts the timer %s the board name', (fontScale, valuePlacement) => {
    const input = makeInput({
      rogue: rogueInput([rogueBoard({ timerName: 'Echo Gym Timer 2.0' }), rogueBoard({ uuid: 'bare' })]),
      fontScale,
    });
    expect(find<MoreValueRow>(input, 'rogueBoard:board-1', 'value').valuePlacement).toBe(valuePlacement);
    expect(find<MoreValueRow>(input, 'rogueBoard:bare', 'value').valuePlacement).toBe(valuePlacement);
  });

  it('shows each board with its timer, and Not paired without one', () => {
    const input = makeInput({
      rogue: rogueInput([
        rogueBoard({ uuid: 'paired', name: 'Garage', timerName: 'Rogue Echo Gym Timer' }),
        rogueBoard({ uuid: 'bare', name: 'Spare room' }),
      ]),
    });
    expect(find<MoreValueRow>(input, 'rogueBoard:paired', 'value')).toMatchObject({
      label: 'Garage',
      value: 'Rogue Echo Gym Timer',
      accessibilityHint: 'mobile.settings.timers.rogueChangeHint',
    });
    expect(find<MoreValueRow>(input, 'rogueBoard:bare', 'value')).toMatchObject({
      label: 'Spare room',
      value: 'mobile.settings.timers.rogueNotPaired',
      accessibilityHint: 'mobile.settings.timers.roguePairHint',
    });
  });

  it('offers Remove only under a paired board', () => {
    const input = makeInput({
      rogue: rogueInput([rogueBoard({ uuid: 'paired', name: 'Garage', timerName: 'Rogue Echo' }), rogueBoard()]),
    });
    expect(rowsOf(input).map((row) => row.key)).toEqual([
      'restLength',
      'restMode',
      'autoAdvance',
      'rogueBoard:paired',
      'rogueRemove:paired',
      'rogueBoard:board-1',
    ]);
    expect(find<MoreButtonRow>(input, 'rogueRemove:paired', 'button')).toMatchObject({
      label: 'mobile.settings.timers.rogueRemove {"board":"Garage"}',
      role: 'destructive',
      emphasis: 'subtle',
    });
  });

  it('pairs and removes by board', () => {
    const rogue = rogueInput([rogueBoard({ timerName: 'Rogue Echo' })]);
    const input = makeInput({ rogue });
    find<MoreValueRow>(input, 'rogueBoard:board-1', 'value').onPress?.();
    find<MoreButtonRow>(input, 'rogueRemove:board-1', 'button').onPress();
    expect(rogue.onPair).toHaveBeenCalledWith('board-1');
    expect(rogue.onRemove).toHaveBeenCalledWith('board-1');
  });

  it('shows a spinner and takes no taps while a change saves', () => {
    const rogue = rogueInput([rogueBoard({ timerName: 'Rogue Echo', busy: true })]);
    const input = makeInput({ rogue });
    const pairRow = find<MoreValueRow>(input, 'rogueBoard:board-1', 'value');
    expect(pairRow.busy).toBe(true);
    pairRow.onPress?.();
    expect(rogue.onPair).not.toHaveBeenCalled();
    expect(find<MoreButtonRow>(input, 'rogueRemove:board-1', 'button').disabled).toBe(true);
  });

  it.each([
    ['connected', 'mobile.settings.timers.rogueConnected'],
    ['connecting', 'mobile.settings.timers.rogueConnecting'],
    ['unreachable', 'mobile.settings.timers.rogueUnreachable'],
  ] as const)('says the timer is %s', (link, subtitle) => {
    const input = makeInput({ rogue: rogueInput([rogueBoard({ timerName: 'Rogue Echo', link })]) });
    expect(find<MoreValueRow>(input, 'rogueBoard:board-1', 'value').subtitle).toBe(subtitle);
  });

  it('says nothing about the link when the app is not talking to the timer', () => {
    const input = makeInput({ rogue: rogueInput([rogueBoard({ timerName: 'Rogue Echo' })]) });
    expect(find<MoreValueRow>(input, 'rogueBoard:board-1', 'value').subtitle).toBeUndefined();
  });
});

describe('rogueTimerBoards', () => {
  function board(overrides: Partial<UserBoard>): UserBoard {
    return {
      uuid: 'board-1',
      slug: 'home',
      ownerId: 'me',
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,20',
      name: 'Home wall',
      isPublic: false,
      isUnlisted: false,
      hideLocation: true,
      isOwned: true,
      angle: 40,
      isAngleAdjustable: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      totalAscents: 0,
      uniqueClimbers: 0,
      followerCount: 0,
      commentCount: 0,
      isFollowedByMe: false,
      timerName: null,
      ...overrides,
    };
  }

  const base = { viewerUserId: 'me', activeBoardUuid: null, savingBoardUuid: null, linkStatus: 'idle' as const };

  it("keeps the climber's own boards and drops followed ones, real walls or not", () => {
    const boards = [
      board({ uuid: 'mine' }),
      board({ uuid: 'gym', ownerId: 'someone-else', isOwned: true }),
      board({ uuid: 'followed', ownerId: 'someone-else', isOwned: false }),
    ];
    expect(rogueTimerBoards({ ...base, boards }).map((entry) => entry.uuid)).toEqual(['mine']);
  });

  it('drops a followed board whose owner the server hides, though it reads as a real wall', () => {
    // A followed board whose owner keeps their activity private comes back with
    // no ownerId and isOwned true. Its timer is not the climber's to change.
    const boards = [board({ uuid: 'mine' }), board({ uuid: 'followed-hidden-owner', ownerId: null, isOwned: true })];
    expect(rogueTimerBoards({ ...base, boards }).map((entry) => entry.uuid)).toEqual(['mine']);
  });

  it('drops spray walls, which have no hardware', () => {
    const boards = [board({ uuid: 'kilter' }), board({ uuid: 'wall', boardType: 'spray' })];
    expect(rogueTimerBoards({ ...base, boards }).map((entry) => entry.uuid)).toEqual(['kilter']);
  });

  it('lists nothing until it knows who the climber is', () => {
    expect(rogueTimerBoards({ ...base, viewerUserId: null, boards: [board({})] })).toEqual([]);
  });

  it('reads a blank timer name as none', () => {
    expect(rogueTimerBoards({ ...base, boards: [board({ timerName: '  ' })] })[0].timerName).toBeNull();
    expect(rogueTimerBoards({ ...base, boards: [board({ timerName: ' Rogue Echo ' })] })[0].timerName).toBe(
      'Rogue Echo',
    );
  });

  it('marks the board whose change is saving', () => {
    const boards = [board({ uuid: 'a' }), board({ uuid: 'b' })];
    expect(rogueTimerBoards({ ...base, boards, savingBoardUuid: 'b' }).map((entry) => entry.busy)).toEqual([
      false,
      true,
    ]);
  });

  it('puts the link state on the active board with a timer only', () => {
    const boards = [
      board({ uuid: 'active', timerName: 'Rogue Echo' }),
      board({ uuid: 'other', timerName: 'Rogue Home' }),
      board({ uuid: 'bare' }),
    ];
    const links = (linkStatus: 'idle' | 'connecting' | 'connected' | 'error', activeBoardUuid: string) =>
      rogueTimerBoards({ ...base, boards, linkStatus, activeBoardUuid }).map((entry) => entry.link);

    expect(links('connected', 'active')).toEqual(['connected', null, null]);
    expect(links('connecting', 'active')).toEqual(['connecting', null, null]);
    expect(links('error', 'active')).toEqual(['unreachable', null, null]);
    expect(links('idle', 'active')).toEqual([null, null, null]);
    expect(links('connected', 'bare')).toEqual([null, null, null]);
  });
});
