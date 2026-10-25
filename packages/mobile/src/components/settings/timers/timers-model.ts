import type { UserBoard } from '@boardsesh/shared-schema';
import { toBoardName } from '@boardsesh/board-config';
import type { RestTimerMode } from '../../../lib/rest-timer';
import type { RogueTimerStatus } from '../../../providers/rogue-timer-context';
import {
  formatRestLength,
  hasRestLength,
  MAX_TAP_REST_LENGTH_SECONDS,
  REST_LENGTH_TAP_STEP_SECONDS,
} from '../../queue-control/rest-length.logic';
import type { MoreFormModel, MoreOption, MoreRow, MoreSection } from '../../MoreForm.types';
import type { SettingsTranslate } from '../root/settings-pages';

export type TimersModelInput = {
  t: SettingsTranslate;
  rest: {
    /** The saved rest length; `null` is Off. */
    targetSeconds: number | null;
    mode: RestTimerMode;
    autoAdvance: boolean;
    /** This phone may not move the wall (a crewmate drives it). Outranks a missing length. */
    autoAdvanceBlockedByCrew: boolean;
    onTargetChange: (seconds: number | null) => void;
    onModeChange: (mode: RestTimerMode) => void;
    onAutoAdvanceChange: (enabled: boolean) => void;
  };
  cues: {
    /**
     * `null` until something reads the setting and emits the countdown buzz
     * (#5396): the row is left out, never shown as a switch that does nothing.
     */
    countdownCues: { enabled: boolean; onChange: (enabled: boolean) => void } | null;
    /** `null` on a build that cannot play a sound: the row is left out, not greyed. */
    sound: { enabled: boolean; onChange: (enabled: boolean) => void } | null;
  };
  /** The gym timer section, or `null` when signed out (pairing is saved on the board). */
  rogue: {
    /** The climber's own boards that can carry a timer: no spray walls. */
    boards: readonly TimersRogueBoard[];
    onPair: (boardUuid: string) => void;
    onRemove: (boardUuid: string) => void;
  } | null;
  /** The system text size (`useWindowDimensions().fontScale`). */
  fontScale: number;
};

/**
 * Past this text size a board's name and its timer's name no longer fit side by
 * side without breaking words, so the timer goes under the board's name. The
 * size SegmentedControl swaps to scrolling tabs at, and climb rows start
 * wrapping names at.
 */
export const ROGUE_TIMER_STACK_FONT_SCALE = 1.3;

/** How the paired timer is doing, said only on the active board's row. */
export type RogueTimerLinkState = 'connected' | 'connecting' | 'unreachable';

export type TimersRogueBoard = {
  uuid: string;
  name: string;
  /** The paired timer's advertised name, or `null` when none is paired. */
  timerName: string | null;
  /** A pairing change for this board is saving. */
  busy: boolean;
  /** Set only for the active board with a timer paired, while the app is talking to it. */
  link: RogueTimerLinkState | null;
};

const OFF_KEY = 'off';

/** The rungs the in-session pill steps through: 0:30 to 10:00 in 30 s. */
export const REST_LENGTH_LADDER_SECONDS: readonly number[] = Array.from(
  { length: MAX_TAP_REST_LENGTH_SECONDS / REST_LENGTH_TAP_STEP_SECONDS },
  (_, index) => (index + 1) * REST_LENGTH_TAP_STEP_SECONDS,
);

/**
 * Off, then the tap ladder, plus the saved length when it sits between rungs
 * (a 1:40 set with the slider, or a longer one). Without it the row would show a
 * choice nobody made.
 */
export function restLengthOptions(t: SettingsTranslate, targetSeconds: number | null): MoreOption[] {
  const seconds = [...REST_LENGTH_LADDER_SECONDS];
  if (hasRestLength(targetSeconds) && !seconds.includes(targetSeconds)) {
    seconds.push(targetSeconds);
    seconds.sort((first, second) => first - second);
  }
  return [
    { key: OFF_KEY, label: t('mobile.settings.timers.restLengthOff') },
    ...seconds.map((value) => ({ key: String(value), label: formatRestLength(value) })),
  ];
}

export function restLengthKey(targetSeconds: number | null): string {
  return hasRestLength(targetSeconds) ? String(targetSeconds) : OFF_KEY;
}

/** The root row's trailing value: the rest default, or Off. */
export function restLengthSummary(t: SettingsTranslate, targetSeconds: number | null): string {
  return hasRestLength(targetSeconds) ? formatRestLength(targetSeconds) : t('mobile.settings.timers.restLengthOff');
}

const ROGUE_LINK_BY_STATUS: Record<RogueTimerStatus, RogueTimerLinkState | null> = {
  idle: null,
  connecting: 'connecting',
  connected: 'connected',
  error: 'unreachable',
};

export type RogueTimerBoardsInput = {
  /** Every page of `myBoards`: the climber's own boards and the ones they follow. */
  boards: readonly UserBoard[];
  viewerUserId: string | null;
  activeBoardUuid: string | null;
  savingBoardUuid: string | null;
  /** The gym-timer provider's link, which is always the active board's timer. */
  linkStatus: RogueTimerStatus;
};

/**
 * Whether the climber owns this board, by the rule the server uses before it
 * sends `timerName`: `ownerId` is the viewer. Stricter than My Boards'
 * `boardIsOwnedBy`, whose `isOwned` fallback is for old offline snapshots. The
 * server also sends no `ownerId` for a followed board whose owner keeps their
 * activity private, and `isOwned` there means "a real wall", not "yours".
 */
function isViewersBoard(board: UserBoard, viewerUserId: string | null): boolean {
  return viewerUserId !== null && board.ownerId === viewerUserId;
}

/**
 * The boards a timer can be paired to: the climber's own (the server shows a
 * board's timer to its owner only), never a spray wall, which has no hardware.
 */
export function rogueTimerBoards({
  boards,
  viewerUserId,
  activeBoardUuid,
  savingBoardUuid,
  linkStatus,
}: RogueTimerBoardsInput): TimersRogueBoard[] {
  return boards
    .filter((board) => toBoardName(board.boardType) !== 'spray' && isViewersBoard(board, viewerUserId))
    .map((board) => {
      const timerName = board.timerName?.trim() || null;
      return {
        uuid: board.uuid,
        name: board.name,
        timerName,
        busy: board.uuid === savingBoardUuid,
        link: timerName !== null && board.uuid === activeBoardUuid ? ROGUE_LINK_BY_STATUS[linkStatus] : null,
      };
    });
}

function rogueLinkSubtitle(t: SettingsTranslate, link: RogueTimerLinkState | null): string | undefined {
  switch (link) {
    case 'connected':
      return t('mobile.settings.timers.rogueConnected');
    case 'connecting':
      return t('mobile.settings.timers.rogueConnecting');
    case 'unreachable':
      return t('mobile.settings.timers.rogueUnreachable');
    default:
      return undefined;
  }
}

/**
 * One row per board: its paired timer (tap to pair or change it), and a quiet
 * Remove under a paired one. At large text sizes the timer sits under the
 * board's name. When the climber owns no board yet, one status row: the fact in
 * the row's label, what to do about it in the subtitle under it.
 */
function rogueSection(
  t: SettingsTranslate,
  rogue: NonNullable<TimersModelInput['rogue']>,
  fontScale: number,
): MoreSection {
  const valuePlacement = fontScale > ROGUE_TIMER_STACK_FONT_SCALE ? 'below' : 'trailing';
  const rows: MoreRow[] =
    rogue.boards.length === 0
      ? [
          {
            kind: 'value',
            key: 'rogueNoBoards',
            label: t('mobile.settings.timers.rogueNoBoardsTitle'),
            subtitle: t('mobile.settings.timers.rogueNoBoards'),
          },
        ]
      : rogue.boards.flatMap((board): MoreRow[] => {
          const pairRow: MoreRow = {
            kind: 'value',
            key: `rogueBoard:${board.uuid}`,
            label: board.name,
            value: board.timerName ?? t('mobile.settings.timers.rogueNotPaired'),
            valuePlacement,
            subtitle: board.timerName ? rogueLinkSubtitle(t, board.link) : undefined,
            busy: board.busy,
            accessibilityHint: board.timerName
              ? t('mobile.settings.timers.rogueChangeHint')
              : t('mobile.settings.timers.roguePairHint'),
            onPress: () => {
              if (!board.busy) rogue.onPair(board.uuid);
            },
          };
          if (!board.timerName) return [pairRow];
          return [
            pairRow,
            {
              kind: 'button',
              key: `rogueRemove:${board.uuid}`,
              label: t('mobile.settings.timers.rogueRemove', { board: board.name }),
              role: 'destructive',
              emphasis: 'subtle',
              disabled: board.busy,
              onPress: () => rogue.onRemove(board.uuid),
            },
          ];
        });

  return {
    key: 'rogue',
    title: t('mobile.settings.timers.rogueTitle'),
    footer: t('mobile.settings.timers.rogueFooter'),
    rows,
  };
}

/**
 * Settings › Timers: the rest timer's saved defaults, its countdown cues, then
 * the gym timer paired to each of the climber's boards. The in-session sheet
 * edits the same settings, so the two always agree.
 */
export function buildTimersModel(input: TimersModelInput): MoreFormModel {
  const { t, rest, cues, rogue, fontScale } = input;
  const hasLength = hasRestLength(rest.targetSeconds);

  const modeOptions: (MoreOption & { key: RestTimerMode })[] = [
    { key: 'afterTick', label: t('mobile.settings.timers.modeAfterTick') },
    {
      key: 'onTheMinute',
      label: hasLength
        ? t('mobile.settings.timers.modeEvery', { length: formatRestLength(rest.targetSeconds as number) })
        : t('mobile.settings.timers.modeOnTheMinute'),
    },
  ];

  const autoAdvanceSubtitle = rest.autoAdvanceBlockedByCrew
    ? t('mobile.settings.timers.autoAdvanceBlocked')
    : hasLength
      ? t('mobile.settings.timers.autoAdvanceHint')
      : t('mobile.settings.timers.autoAdvanceNeedsLength');

  const cueRows: MoreRow[] = [
    ...(cues.countdownCues
      ? [
          {
            kind: 'toggle' as const,
            key: 'countdownCues',
            label: t('mobile.settings.timers.countdownCues'),
            subtitle: t('mobile.settings.timers.countdownCuesHint'),
            value: cues.countdownCues.enabled,
            onValueChange: cues.countdownCues.onChange,
          },
        ]
      : []),
    ...(cues.sound
      ? [
          {
            kind: 'toggle' as const,
            key: 'sound',
            label: t('mobile.settings.timers.sound'),
            subtitle: t('mobile.settings.timers.soundHint'),
            value: cues.sound.enabled,
            onValueChange: cues.sound.onChange,
          },
        ]
      : []),
  ];

  return {
    sections: [
      {
        key: 'rest',
        title: t('mobile.settings.timers.restTitle'),
        footer:
          rest.mode === 'afterTick'
            ? t('mobile.settings.timers.modeAfterTickHint')
            : t('mobile.settings.timers.modeOnTheMinuteHint'),
        rows: [
          {
            kind: 'select',
            key: 'restLength',
            label: t('mobile.settings.timers.restLength'),
            options: restLengthOptions(t, rest.targetSeconds),
            selectedKey: restLengthKey(rest.targetSeconds),
            onSelect: (key) => rest.onTargetChange(key === OFF_KEY ? null : Number(key)),
          },
          {
            kind: 'segmented',
            key: 'restMode',
            label: t('mobile.settings.timers.modeLabel'),
            options: modeOptions,
            selectedKey: rest.mode,
            onSelect: (key) => {
              const next = modeOptions.find((option) => option.key === key);
              if (next) rest.onModeChange(next.key);
            },
          },
          {
            kind: 'toggle',
            key: 'autoAdvance',
            label: t('mobile.settings.timers.autoAdvance'),
            subtitle: autoAdvanceSubtitle,
            value: rest.autoAdvance,
            disabled: rest.autoAdvanceBlockedByCrew || !hasLength,
            onValueChange: rest.onAutoAdvanceChange,
          },
        ],
      },
      ...(cueRows.length > 0
        ? [
            {
              key: 'cues' as const,
              title: t('mobile.settings.timers.cuesTitle'),
              footer: t('mobile.settings.timers.cuesFooter'),
              rows: cueRows,
            },
          ]
        : []),
      ...(rogue ? [rogueSection(t, rogue, fontScale)] : []),
    ],
  };
}
