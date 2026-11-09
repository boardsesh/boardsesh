import { createHash } from 'node:crypto';
import { getBoardDetailsForBoard, normalizeOgCardText } from '@boardsesh/board-render';
import {
  OG_FAMILY_JOIN_GREEN,
  OG_FAMILY_MUTED,
  OG_FAMILY_WHITE,
  ogFamilyGradeColor,
  type OgFamilyCardContent,
  type OgFamilyRow,
  type OgFamilySlot,
} from '@boardsesh/board-render/og-family';
import { BOARD_TYPE_LABELS, toFlatFrames, type BoardName } from '@boardsesh/board-constants';
import { getBoulderGradesForBoard } from '@boardsesh/board-constants/boulder-grade-mapping';
import { getDefaultRenderBoard, parseBoardPath, parseNamedBoardPath } from '@boardsesh/board-config';
import type { OgFamilyArtSpec } from '../board-render';

/** What a surface's loader hands the handler after its gate has passed. */
export type LoadedOgFamilyCard = {
  /** Digest of everything that changes the bytes. See `digestDrawnData`. */
  digest: string;
  art: OgFamilyArtSpec | null;
  content: OgFamilyCardContent;
};

/** Stable digest over the drawn data, so the byte cache keys on what the card actually shows. */
export function digestDrawnData(drawn: unknown): string {
  return createHash('sha256').update(JSON.stringify(drawn)).digest('base64url').slice(0, 32);
}

/** Card-name bound: text longer than this cannot be drawn usefully anyway. */
const MAX_DRAWN_NAME_CODEPOINTS = 60;

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
