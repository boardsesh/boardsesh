import { createHash } from 'node:crypto';
import { getBoardDetailsForBoard, normalizeOgCardText } from '@boardsesh/board-render';
import {
  OG_FAMILY_JOIN_GREEN,
  OG_FAMILY_MUTED,
  OG_FAMILY_WHITE,
  ogFamilyGradeColor,
  type OgFamilyAvatar,
  type OgFamilyBar,
  type OgFamilyCardContent,
  type OgFamilyDots,
  type OgFamilyRow,
  type OgFamilySlot,
} from '@boardsesh/board-render/og-family';
import { BOARD_TYPE_LABELS, toFlatFrames, type BoardName } from '@boardsesh/board-constants';
import { getBoulderGradesForBoard } from '@boardsesh/board-constants/boulder-grade-mapping';
import {
  getDefaultRenderBoard,
  parseBoardPath,
  parseNamedBoardPath,
  resolveRenderBoard,
  type RenderBoardConfig,
} from '@boardsesh/board-config';
import { isValidFramesString } from '@boardsesh/board-render';
import type { OgFamilyArtSpec, OgFamilyPhotoArt } from '../board-render';
import type { CardAvatar } from './load-avatar';
import type { SessionRecapRead } from './session-recap';

/** What a surface's loader hands the handler after its gate has passed. */
export type LoadedOgFamilyCard = {
  /** Digest of everything that changes the bytes. See `digestDrawnData`. */
  digest: string;
  art: OgFamilyArtSpec | null;
  /** A real photo in the art slot, when this card draws one instead of a board. */
  photo?: OgFamilyPhotoArt | null;
  content: OgFamilyCardContent;
};

/** Stable digest over the drawn data, so the byte cache keys on what the card actually shows. */
export function digestDrawnData(drawn: unknown): string {
  return createHash('sha256').update(JSON.stringify(drawn)).digest('base64url').slice(0, 32);
}

/** Card-name bound: text longer than this cannot be drawn usefully anyway. */
export const MAX_DRAWN_NAME_CODEPOINTS = 60;

export type BoardConfig = {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
};

/**
 * Whether this config can actually be drawn. Spray walls have no catalogue art
 * (the place cards handle them separately), and a stale config or unknown layout
 * must drop the art rather than 500.
 */
export function isRenderableConfig(config: BoardConfig): boolean {
  if (config.boardName === 'spray') return false;
  try {
    getBoardDetailsForBoard({
      board_name: config.boardName,
      layout_id: config.layoutId,
      size_id: config.sizeId,
      set_ids: config.setIds.split(',').map(Number),
    });
    return true;
  } catch {
    return false;
  }
}

// --- playlist --------------------------------------------------------------

export const PLAYLIST_ART_PAGE_SIZE = 20;

export type PlaylistArtClimb = { layoutId: number | null; frames: string | null };

/**
 * The art for a playlist: one climb, the first in the list's own order on the
 * most-used layout of its first page, in that climb's real LED colours.
 */
export function buildPlaylistArt(boardName: BoardName, climbs: readonly PlaylistArtClimb[]): OgFamilyArtSpec | null {
  const withLayout = climbs.flatMap((climb) => {
    // A multi-frame climb is the union of its frames, not frame 0.
    const frames = toFlatFrames(climb.frames, boardName);
    return climb.layoutId !== null && frames ? [{ layoutId: climb.layoutId, frames }] : [];
  });
  const [firstClimb] = withLayout;
  if (!firstClimb) return null;

  const countByLayout = new Map<number, number>();
  for (const climb of withLayout) {
    countByLayout.set(climb.layoutId, (countByLayout.get(climb.layoutId) ?? 0) + 1);
  }
  // Ties go to the layout that appears first, which is the one the owner put first.
  const dominantLayoutId = [...countByLayout].reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];

  const defaultBoard = getDefaultRenderBoard(boardName, dominantLayoutId);
  if (!defaultBoard) return null;
  const config: BoardConfig = {
    boardName,
    layoutId: defaultBoard.layoutId,
    sizeId: defaultBoard.sizeId,
    setIds: defaultBoard.setIds.join(','),
  };
  if (!isRenderableConfig(config)) return null;

  const litClimb = withLayout.find((climb) => climb.layoutId === dominantLayoutId) ?? firstClimb;
  return { ...config, frames: litClimb.frames };
}

export type PlaylistSummaryForCard = { p10Difficulty: number; p90Difficulty: number } | null | undefined;

type GradeBand = { heroRuns: OgFamilyRow['runs']; fontRuns: OgFamilyRow['runs'] };

/**
 * The band as coloured runs: `V5–V9` over `6c+ to 7c`. Null when no grades resolve,
 * which puts the count in the hero slot instead.
 */
export function buildGradeBand(boardName: string, summary: PlaylistSummaryForCard): GradeBand | null {
  if (!summary) return null;
  const grades = getBoulderGradesForBoard(boardName);
  const low = grades.find((grade) => grade.difficulty_id === summary.p10Difficulty);
  const high = grades.find((grade) => grade.difficulty_id === summary.p90Difficulty);
  if (!low || !high) return null;

  const lowColor = ogFamilyGradeColor(low.font_grade);
  const highColor = ogFamilyGradeColor(high.font_grade);
  const heroRuns =
    low.v_grade === high.v_grade
      ? [{ text: low.v_grade, color: lowColor }]
      : [
          { text: low.v_grade, color: lowColor },
          { text: '–', color: OG_FAMILY_MUTED },
          { text: high.v_grade, color: highColor },
        ];
  const fontRuns =
    low.font_grade === high.font_grade
      ? [{ text: low.font_grade, color: lowColor }]
      : [
          { text: low.font_grade, color: lowColor },
          { text: ' to ', color: OG_FAMILY_MUTED },
          { text: high.font_grade, color: highColor },
        ];
  return { heroRuns, fontRuns };
}

function climbCountLabel(climbCount: number): string {
  return `${climbCount === 1 ? 'climb' : 'climbs'}`;
}

/**
 * Hero: band if there is one, else the count in white. Creator name is never on a card.
 * `climbCount` is what a stranger can open (`playlistClimbs.totalCount`), not the row
 * count on `Playlist.climbCount`, which also counts drafts and hidden spray climbs.
 */
export function buildPlaylistCardContent(params: {
  name: string;
  boardName: string;
  climbCount: number;
  summary: PlaylistSummaryForCard;
  art: OgFamilyArtSpec | null;
  fontFamily: string;
}): OgFamilyCardContent {
  const { name, boardName, climbCount, summary, art, fontFamily } = params;
  const slot: OgFamilySlot = art ? 'full' : 'none';
  const drawnName = normalizeOgCardText(name, MAX_DRAWN_NAME_CODEPOINTS);
  const boardLine = `${BOARD_TYPE_LABELS[boardName] ?? boardName} playlist`;
  const countText = `${climbCount.toLocaleString('en-US')} ${climbCountLabel(climbCount)}`;

  const nameRow: OgFamilyRow = {
    runs: [{ text: drawnName, color: OG_FAMILY_WHITE }],
    sizePt: 27,
    weight: 700,
    maxLines: 2,
    gapBelow: 8,
  };
  const boardRow: OgFamilyRow = {
    runs: [{ text: boardLine, color: OG_FAMILY_MUTED }],
    sizePt: 16,
    weight: 500,
  };

  const band = buildGradeBand(boardName, summary);
  if (!band) {
    return {
      slot,
      fontFamily,
      hero: { runs: [{ text: climbCount.toLocaleString('en-US'), color: OG_FAMILY_WHITE }], maxPt: 78, wrap: false },
      rows: [
        {
          runs: [{ text: climbCountLabel(climbCount), color: OG_FAMILY_MUTED }],
          sizePt: 24,
          weight: 600,
          gapBelow: 16,
        },
        ...(drawnName ? [nameRow] : []),
        boardRow,
      ],
    };
  }

  return {
    slot,
    fontFamily,
    hero: { runs: band.heroRuns, maxPt: 78, wrap: false },
    rows: [
      // 40px is the floor at which the Font band is still readable at 110px.
      { runs: band.fontRuns, sizePt: 32, weight: 700, gapBelow: 16 },
      { runs: [{ text: countText, color: OG_FAMILY_WHITE }], sizePt: 19, weight: 600, gapBelow: 10 },
      ...(drawnName ? [nameRow] : []),
      boardRow,
    ],
  };
}

// --- session invite --------------------------------------------------------

export type SessionUserForCard = { userId: string | null; username: string; isLeader: boolean };

/**
 * Who the invite names: the leader, else the first named person on the roster.
 *
 * The roster here has already been through the anonymous projection, which blanks
 * `userId` and `username` for a climber who stays anonymous, so "no userId" reads
 * as "not nameable", the same rule web's preview uses.
 */
export function pickInviteName(users: readonly SessionUserForCard[]): string | null {
  const named = users.filter((user) => user.userId && user.username.trim());
  const leader = named.find((user) => user.isLeader);
  const picked = leader ?? named[0];
  if (!picked) return null;
  const normalised = normalizeOgCardText(picked.username, MAX_DRAWN_NAME_CODEPOINTS);
  return normalised || null;
}

export type NamedBoardForCard = {
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
};

export type SessionBoardForCard = { config: BoardConfig; angle: number | null };

/** Whether this path is the `/b/<slug>` form, which needs a board lookup to draw. */
export function namedBoardSlug(boardPath: string): string | null {
  return parseNamedBoardPath(boardPath)?.slug ?? null;
}

/**
 * Turn a session's `boardPath` and, for a named board, its looked-up config into
 * something drawable. The anonymous projection returns `/b/<slug>` only when a
 * stranger may name the board and the geometry form otherwise, so both must work.
 */
export function resolveSessionBoard(
  boardPath: string,
  namedBoard: NamedBoardForCard | null,
): SessionBoardForCard | null {
  const named = parseNamedBoardPath(boardPath);
  if (named) {
    if (!namedBoard) return null;
    return {
      config: {
        boardName: namedBoard.boardType as BoardName,
        layoutId: namedBoard.layoutId,
        sizeId: namedBoard.sizeId,
        setIds: namedBoard.setIds,
      },
      angle: named.angle ?? namedBoard.angle,
    };
  }
  const parsed = parseBoardPath(boardPath);
  if (!parsed) return null;
  return {
    config: {
      boardName: parsed.boardName as BoardName,
      layoutId: parsed.layoutId,
      sizeId: parsed.sizeId,
      setIds: parsed.setIds,
    },
    angle: parsed.angle,
  };
}

/** The floor keeps even a long name well above the board line under it. */
export const JOIN_BOARD_LINE_PT = 30;
export const JOIN_HERO_MIN_PT = 44;
export const JOIN_HERO_PREFIX = 'Join';
export const JOIN_FALLBACK_NAME = 'the crew';

/** `Join {name}` in white. The "ended" state never reaches here, so the pill and hero stay true. */
export function buildJoinCardContent(params: {
  name: string | null;
  board: SessionBoardForCard | null;
  art: OgFamilyArtSpec | null;
  fontFamily: string;
}): OgFamilyCardContent {
  const { name, board, art, fontFamily } = params;
  // The name is the hero, so the art gives up width: the narrow slice leaves it
  // the whole crop to grow into.
  const slot: OgFamilySlot = art ? 'narrow' : 'none';

  const rows: OgFamilyRow[] = [];
  if (board) {
    const label = BOARD_TYPE_LABELS[board.config.boardName] ?? board.config.boardName;
    const boardLine = board.angle === null ? label : `${label} at ${board.angle}°`;
    rows.push({ runs: [{ text: boardLine, color: OG_FAMILY_WHITE }], sizePt: JOIN_BOARD_LINE_PT, weight: 700 });
  }

  return {
    slot,
    fontFamily,
    pill: { text: 'JOIN', color: OG_FAMILY_JOIN_GREEN },
    hero: {
      // Two runs, so a name too long to fit is the part that truncates.
      runs: [
        { text: `${JOIN_HERO_PREFIX}\n`, color: OG_FAMILY_WHITE },
        { text: name ?? JOIN_FALLBACK_NAME, color: OG_FAMILY_WHITE },
      ],
      maxPt: 100,
      minPt: JOIN_HERO_MIN_PT,
      wrap: true,
    },
    rows,
  };
}

// --- shared people-card pieces --------------------------------------------

/** The name a profile falls back to, the same string the profile page uses. */
export const PROFILE_FALLBACK_NAME = 'Climber';
/** What the recap calls someone a stranger may not see named. */
export const RECAP_FALLBACK_NAME = 'A climber';

/** A grade as the card shows it, or null when this board has no such grade. */
export function resolveCardGrade(
  boardName: string,
  difficulty: number | null,
): { label: string; color: string } | null {
  if (difficulty === null) return null;
  const grade = getBoulderGradesForBoard(boardName).find((candidate) => candidate.difficulty_id === difficulty);
  if (!grade) return null;
  return { label: `${grade.font_grade}/${grade.v_grade}`, color: ogFamilyGradeColor(grade.font_grade) };
}

/**
 * Art for one climb on the board it should be drawn on. Null, not an error, when
 * the climb cannot be drawn: an unknown layout, a stale config, spray, or frames
 * this renderer would not understand.
 */
export function buildClimbArt(
  boardName: string,
  frames: string | null | undefined,
  renderBoard: RenderBoardConfig | null | undefined,
): OgFamilyArtSpec | null {
  if (!renderBoard) return null;
  const flatFrames = toFlatFrames(frames, boardName as BoardName);
  if (!isValidFramesString(flatFrames)) return null;
  const config: BoardConfig = {
    boardName: boardName as BoardName,
    layoutId: renderBoard.layoutId,
    sizeId: renderBoard.sizeId,
    setIds: renderBoard.setIds.join(','),
  };
  return isRenderableConfig(config) ? { ...config, frames: flatFrames } : null;
}

/** `Kilter`, `Kilter and Tension`, `3 boards`. */
export function describeBoards(boardTypes: readonly string[]): string {
  const labels = [...new Set(boardTypes)].map((boardType) => BOARD_TYPE_LABELS[boardType] ?? boardType);
  if (labels.length === 0) return 'Boardsesh';
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.length} boards`;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** The first full character of a name, so a surname or combining mark is not split. */
export function monogramLetter(name: string): string {
  const [first] = graphemeSegmenter.segment(name.trim());
  return first ? first.segment.toLocaleUpperCase('en-US') : '?';
}

/** The avatar to draw for a name: the decoded picture, else a monogram in the card's accent. */
export function cardAvatarFor(name: string, avatar: CardAvatar | null, accentColor: string): OgFamilyAvatar {
  return avatar
    ? { kind: 'image', png: avatar.png, digest: avatar.digest }
    : { kind: 'monogram', letter: monogramLetter(name), color: accentColor };
}

/** `1,136,595` -> `1.1M`; `227,004` -> `227K`; below 100k the exact number fits and means more. */
export function compactCount(count: number): string {
  // 999,500 and up round to a thousand thousands, so they read as millions.
  if (count >= 999_500) return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (count >= 100_000) return `${Math.round(count / 1000)}K`;
  return count.toLocaleString('en-US');
}

/** Drawn data minus raw picture bytes: the digest keys on the picture's own hash. */
export function digestCard(art: OgFamilyArtSpec | null, content: OgFamilyCardContent): string {
  const { identity } = content;
  const avatar = identity?.avatar;
  const digestible =
    identity && avatar?.kind === 'image'
      ? { ...content, identity: { ...identity, avatar: { kind: 'image', digest: avatar.digest } } }
      : content;
  return digestDrawnData({ art, content: digestible });
}

// --- profile ---------------------------------------------------------------

export type HardestSendForCard = {
  climbName: string;
  boardType: string;
  difficulty: number | null;
  consensusDifficulty: number | null;
  frames: string | null;
  renderBoard: RenderBoardConfig | null;
};

export type ProfileStatsForCard = {
  totalDistinctClimbs: number;
  layoutStats: {
    boardType: string;
    distinctClimbCount: number;
    gradeCounts: { grade: string; count: number }[];
  }[];
};

const HERO_GRADE_MAX_PT = 96;
const HARDEST_NAME_PT = 22;
const SUBLINE_PT = 18;
const IDENTITY_PT = 34;

/** The logged grade, falling back to consensus only when nothing was logged. */
export function effectiveHardestDifficulty(send: Pick<HardestSendForCard, 'difficulty' | 'consensusDifficulty'>) {
  if (send.difficulty !== null) return send.difficulty;
  return send.consensusDifficulty !== null ? Math.round(send.consensusDifficulty) : null;
}

/**
 * Per-grade bars across every board, from the easiest grade they have climbed to
 * the hardest. A grade id means the same thing on every board, so one axis holds.
 */
export function buildGradeBars(stats: ProfileStatsForCard): OgFamilyBar[] {
  const totals = new Map<number, number>();
  for (const layout of stats.layoutStats) {
    for (const { grade, count } of layout.gradeCounts) {
      const difficulty = Number(grade);
      if (Number.isInteger(difficulty)) totals.set(difficulty, (totals.get(difficulty) ?? 0) + count);
    }
  }
  if (totals.size === 0) return [];
  const present = [...totals.keys()];
  const bars: OgFamilyBar[] = [];
  for (let difficulty = Math.min(...present); difficulty <= Math.max(...present); difficulty++) {
    const grade = resolveCardGrade('kilter', difficulty);
    bars.push({ value: totals.get(difficulty) ?? 0, color: grade?.color ?? OG_FAMILY_MUTED });
  }
  return bars;
}

export function buildProfileCardContent(params: {
  displayName: string | null | undefined;
  avatar: CardAvatar | null;
  hardest: HardestSendForCard | null;
  stats: ProfileStatsForCard;
  art: OgFamilyArtSpec | null;
  fontFamily: string;
}): OgFamilyCardContent {
  const { displayName, avatar, hardest, stats, art, fontFamily } = params;
  const named = normalizeOgCardText(displayName ?? '', MAX_DRAWN_NAME_CODEPOINTS);
  const name = named || PROFILE_FALLBACK_NAME;
  const slot: OgFamilySlot = art ? 'full' : 'none';

  if (!hardest) {
    const identity = {
      name,
      avatar: named ? cardAvatarFor(name, avatar, OG_FAMILY_MUTED) : null,
      sizePt: IDENTITY_PT,
    };
    // No featured climb is not the same as an empty logbook: every send can be on
    // a community-hidden climb, which the card will not name or draw but the
    // public stats still count.
    const sentClimbs = stats.totalDistinctClimbs;
    if (sentClimbs > 0) {
      const sentBoards = stats.layoutStats
        .filter((layout) => layout.distinctClimbCount > 0)
        .map((layout) => layout.boardType);
      return {
        slot,
        fontFamily,
        identity,
        hero: {
          runs: [
            {
              text: `${sentClimbs.toLocaleString('en-US')} ${sentClimbs === 1 ? 'climb' : 'climbs'} sent`,
              color: OG_FAMILY_WHITE,
            },
          ],
          maxPt: 46,
          minPt: 30,
          wrap: true,
        },
        rows: [
          {
            runs: [{ text: `On ${describeBoards(sentBoards)}`, color: OG_FAMILY_MUTED }],
            sizePt: SUBLINE_PT,
            weight: 500,
          },
        ],
        bars: buildGradeBars(stats),
      };
    }
    return {
      slot,
      fontFamily,
      identity,
      hero: { runs: [{ text: 'No sends logged yet', color: OG_FAMILY_WHITE }], maxPt: 46, minPt: 30, wrap: true },
      rows: [],
    };
  }

  const difficulty = effectiveHardestDifficulty(hardest);
  const grade = resolveCardGrade(hardest.boardType, difficulty);
  const boards = stats.layoutStats.filter((layout) => layout.distinctClimbCount > 0).map((layout) => layout.boardType);
  const boardsLabel = describeBoards(boards.length > 0 ? boards : [hardest.boardType]);
  const climbs = stats.totalDistinctClimbs;
  const summary =
    climbs <= 1
      ? `One send logged · ${boardsLabel}`
      : `Hardest of ${climbs.toLocaleString('en-US')} climbs sent on ${boardsLabel}`;
  const accent = grade?.color ?? OG_FAMILY_MUTED;

  const climbName = normalizeOgCardText(hardest.climbName, MAX_DRAWN_NAME_CODEPOINTS);
  const rows: OgFamilyRow[] = [
    ...(climbName
      ? [{ runs: [{ text: climbName, color: OG_FAMILY_WHITE }], sizePt: HARDEST_NAME_PT, weight: 700, gapBelow: 12 }]
      : []),
    { runs: [{ text: summary, color: OG_FAMILY_MUTED }], sizePt: SUBLINE_PT, weight: 500 },
  ];

  return {
    slot,
    fontFamily,
    identity: { name, avatar: named ? cardAvatarFor(name, avatar, accent) : null, sizePt: IDENTITY_PT },
    hero: grade
      ? { runs: [{ text: grade.label, color: grade.color }], maxPt: HERO_GRADE_MAX_PT, wrap: false, tight: true }
      : {
          runs: [{ text: `${climbs.toLocaleString('en-US')} sends`, color: OG_FAMILY_WHITE }],
          maxPt: 72,
          wrap: false,
          tight: true,
        },
    rows,
    bars: buildGradeBars(stats),
  };
}

// --- setter ----------------------------------------------------------------

export type SetterTopClimbForCard = {
  uuid: string;
  name: string;
  boardType: string | null;
  layoutId: number | null;
  frames: string;
  ascensionist_count: number;
  compatibleSizeIds: number[] | null;
  requiredSetIds: number[] | null;
};

/** What a setter is called when neither their account nor their username has anything drawable. */
export const SETTER_FALLBACK_NAME = 'Setter';

/** Under this many sends the climb count carries the card instead. */
export const SETTER_SENDS_HERO_MINIMUM = 10;

/** The most-sent climb, on a board it fits, in its own LED colours. */
export function buildSetterArt(climb: SetterTopClimbForCard | null): OgFamilyArtSpec | null {
  if (!climb?.boardType) return null;
  const renderBoard = resolveRenderBoard({
    boardType: climb.boardType,
    climbLayoutId: climb.layoutId,
    compatibleSizeIds: climb.compatibleSizeIds,
    requiredSetIds: climb.requiredSetIds,
    tickBoard: null,
    ownerBoards: [],
  });
  return buildClimbArt(climb.boardType, climb.frames, renderBoard);
}

export function buildSetterCardContent(params: {
  username: string;
  linkedDisplayName: string | null | undefined;
  avatar: CardAvatar | null;
  hasLinkedAvatar: boolean;
  climbCount: number;
  boardTypes: readonly string[];
  totalAscents: number;
  topClimb: SetterTopClimbForCard | null;
  art: OgFamilyArtSpec | null;
  fontFamily: string;
}): OgFamilyCardContent {
  const {
    username,
    linkedDisplayName,
    avatar,
    hasLinkedAvatar,
    climbCount,
    boardTypes,
    totalAscents,
    topClimb,
    art,
    fontFamily,
  } = params;
  const name =
    normalizeOgCardText(linkedDisplayName ?? '', MAX_DRAWN_NAME_CODEPOINTS) ||
    normalizeOgCardText(username, MAX_DRAWN_NAME_CODEPOINTS) ||
    SETTER_FALLBACK_NAME;
  const slot: OgFamilySlot = art ? 'full' : 'none';
  const identity = {
    name,
    avatar: hasLinkedAvatar ? cardAvatarFor(name, avatar, OG_FAMILY_WHITE) : null,
    sizePt: IDENTITY_PT,
  };
  const count = climbCount.toLocaleString('en-US');
  const climbsWord = climbCount === 1 ? 'climb' : 'climbs';

  // A setter with no listable climbs left still has a page, so the card stays,
  // and a count of nothing is no headline.
  if (climbCount === 0) {
    return {
      slot,
      fontFamily,
      identity,
      hero: { runs: [{ text: 'No climbs listed yet', color: OG_FAMILY_WHITE }], maxPt: 46, minPt: 30, wrap: true },
      rows: [],
    };
  }

  const topClimbName =
    topClimb && topClimb.ascensionist_count > 0 ? normalizeOgCardText(topClimb.name, MAX_DRAWN_NAME_CODEPOINTS) : '';
  const mostSentRow: OgFamilyRow[] = topClimbName
    ? [{ runs: [{ text: `Most sent: ${topClimbName}`, color: OG_FAMILY_MUTED }], sizePt: 20, weight: 500 }]
    : [];

  if (totalAscents < SETTER_SENDS_HERO_MINIMUM) {
    return {
      slot,
      fontFamily,
      identity,
      hero: {
        runs: [
          { text: count, color: OG_FAMILY_WHITE },
          { text: ` ${climbsWord}`, color: OG_FAMILY_WHITE, scale: 0.42 },
        ],
        maxPt: HERO_GRADE_MAX_PT,
        wrap: false,
        tight: true,
      },
      rows: [
        {
          runs: [{ text: `set on ${describeBoards(boardTypes)}`, color: OG_FAMILY_WHITE }],
          sizePt: 26,
          weight: 600,
          gapBelow: 10,
        },
        ...mostSentRow,
      ],
    };
  }

  return {
    slot,
    fontFamily,
    identity,
    hero: {
      runs: [
        { text: compactCount(totalAscents), color: OG_FAMILY_WHITE },
        { text: ' sends', color: OG_FAMILY_WHITE, scale: 0.42 },
      ],
      maxPt: HERO_GRADE_MAX_PT,
      wrap: false,
      tight: true,
    },
    rows: [
      {
        runs: [{ text: `on ${count} ${climbsWord} they set`, color: OG_FAMILY_WHITE }],
        sizePt: 26,
        weight: 600,
        gapBelow: 10,
      },
      ...mostSentRow,
    ],
  };
}

// --- session recap ---------------------------------------------------------

/** One line is enough at the 593px hero width; this bounds the list, not what is shown. */
const RECAP_MAX_DOTS_KEPT = 60;
/** Rings are for a handful of tries, not every one of a long project. */
const RECAP_MAX_RINGS = 24;
const RECAP_HERO_MAX_PT = 170;

/** The plain sentence under the grade. */
export function recapLine(recap: Pick<SessionRecapRead, 'sends' | 'flashes' | 'capped'>): string {
  const { sends, flashes, capped } = recap;
  if (sends === 0) return 'Still projecting';
  if (capped) return `${sends.toLocaleString('en-US')}+ sends logged`;
  if (sends === 1) return flashes === 1 ? 'Flashed it' : '1 send';
  const plural = `${sends.toLocaleString('en-US')} sends`;
  if (flashes === sends) return `${plural}, all flashed`;
  return flashes > 0 ? `${plural}, ${flashes.toLocaleString('en-US')} flashed` : plural;
}

/**
 * Who the recap names. A crew session reads as one person plus the rest; the
 * count covers everyone a stranger can see logging, including anyone unnamed.
 */
export function recapNameLine(participants: SessionRecapRead['participants']): string {
  const named = participants.flatMap((participant) => {
    const name = participant.name ? normalizeOgCardText(participant.name, MAX_DRAWN_NAME_CODEPOINTS) : '';
    return name ? [name] : [];
  });
  if (participants.length <= 1) return named[0] ?? RECAP_FALLBACK_NAME;
  if (named.length === 0) return `${participants.length.toLocaleString('en-US')} climbers`;
  const others = participants.length - 1;
  return `${named[0]} + ${others.toLocaleString('en-US')} ${others === 1 ? 'other' : 'others'}`;
}

function recapDots(recap: SessionRecapRead, featuredColor: string): OgFamilyDots | undefined {
  if (recap.sends === 0) {
    if (recap.attempts === 0) return undefined;
    return {
      dots: Array.from({ length: Math.min(recap.attempts, RECAP_MAX_RINGS) }, () => ({
        color: featuredColor,
        filled: false,
      })),
      total: recap.attempts,
      label: `${recap.attempts.toLocaleString('en-US')} ${recap.attempts === 1 ? 'attempt' : 'attempts'}`,
    };
  }
  const dots: { color: string; filled: boolean }[] = [];
  for (const row of recap.gradeRows) {
    const color = resolveCardGrade(recap.featured?.boardType ?? 'kilter', row.difficulty)?.color ?? OG_FAMILY_MUTED;
    for (let index = 0; index < row.flashes && dots.length < RECAP_MAX_DOTS_KEPT; index++) {
      dots.push({ color, filled: true });
    }
    for (let index = 0; index < row.sends && dots.length < RECAP_MAX_DOTS_KEPT; index++) {
      dots.push({ color, filled: false });
    }
  }
  // Sends with no grade at all still each get a dot, in the neutral colour, and
  // still say which of them were flashes.
  const gradedFlashes = recap.gradeRows.reduce((sum, row) => sum + row.flashes, 0);
  let ungradedFlashes = recap.flashes - gradedFlashes;
  while (dots.length < Math.min(recap.sends, RECAP_MAX_DOTS_KEPT)) {
    dots.push({ color: OG_FAMILY_MUTED, filled: ungradedFlashes > 0 });
    ungradedFlashes -= 1;
  }
  return { dots, total: recap.sends };
}

function recapAside(recap: SessionRecapRead): OgFamilyCardContent['aside'] {
  const { featured, participants, durationMinutes, sends } = recap;
  if (!featured) return undefined;
  const title = normalizeOgCardText(featured.climbName ?? '', MAX_DRAWN_NAME_CODEPOINTS);
  if (!title) return undefined;
  const statusWord = featured.status === 'flash' ? 'Flashed' : featured.status === 'send' ? 'Sent' : null;
  // On a solo card "by Name" would only repeat the headline.
  const credit =
    participants.length > 1 && featured.climberName
      ? ` by ${normalizeOgCardText(featured.climberName, MAX_DRAWN_NAME_CODEPOINTS)}`
      : '';
  const boardLabel = BOARD_TYPE_LABELS[featured.boardType] ?? featured.boardType;
  const lines = [
    ...(statusWord ? [`${statusWord}${credit}`] : []),
    `${boardLabel} at ${featured.angle}°`,
    ...(durationMinutes ? [`${durationMinutes.toLocaleString('en-US')} min session`] : []),
  ];
  return { eyebrow: sends > 0 ? 'HARDEST SEND' : 'THE PROJECT', title, lines };
}

export function buildRecapCardContent(params: {
  recap: SessionRecapRead;
  art: OgFamilyArtSpec | null;
  fontFamily: string;
}): OgFamilyCardContent {
  const { recap, art, fontFamily } = params;
  const slot: OgFamilySlot = art ? 'narrow' : 'none';
  const grade = recap.featured ? resolveCardGrade(recap.featured.boardType, recap.featured.difficulty) : null;
  const accent = grade?.color ?? OG_FAMILY_WHITE;
  const line = recapLine(recap);

  return {
    slot,
    fontFamily,
    identity: { name: recapNameLine(recap.participants), avatar: null, sizePt: 30 },
    hero: grade
      ? { runs: [{ text: grade.label, color: grade.color }], maxPt: RECAP_HERO_MAX_PT, wrap: false, tight: true }
      : { runs: [{ text: line, color: OG_FAMILY_WHITE }], maxPt: 72, minPt: 40, wrap: true },
    // Without a grade the plain sentence is the hero, so it is not said twice.
    rows: grade ? [{ runs: [{ text: line, color: OG_FAMILY_WHITE }], sizePt: 34, weight: 800 }] : [],
    dots: recapDots(recap, accent),
    aside: slot === 'none' ? undefined : recapAside(recap),
  };
}
