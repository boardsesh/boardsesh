import { getBoardDetailsForBoard, normalizeOgCardText } from '@boardsesh/board-render';
import {
  OG_FAMILY_MUTED,
  OG_FAMILY_PLACE_ACCENT,
  OG_FAMILY_WHITE,
  type OgFamilyCardContent,
  type OgFamilyHero,
  type OgFamilyRow,
  type OgFamilySlot,
} from '@boardsesh/board-render/og-family';
import { BOARD_TYPE_LABELS, type BoardName } from '@boardsesh/board-constants';
import { FALLBACK_BOARD_PREVIEW_CONFIGS } from '../board-preview-defaults';
import { digestDrawnData, isRenderableConfig, MAX_DRAWN_NAME_CODEPOINTS, type BoardConfig } from './card-model';
import type { OgFamilyArtSpec, OgFamilyPhotoArt } from '../board-render';

/** Every read behind a place card that names a board picks its climb at an angle: this is the common one. */
export const DEFAULT_PLACE_ANGLE = 40;

export const GYM_FALLBACK_NAME = 'Climbing gym';
export const BOARD_FALLBACK_NAME = 'Climbing board';
export const SPRAY_FALLBACK_NAME = 'Spraywall';
export const NO_BOARDS_LINE = 'No boards here yet';

// --- shared rows ------------------------------------------------------------

const HERO_MAX_PT = 66;
/** Small enough to keep a long German compound on one line in the 325px hero column. */
const HERO_MIN_PT = 28;
/** A card with no art gives the name the whole crop. */
const HERO_NO_ART_MAX_PT = 96;

function placeHero(name: string, slot: OgFamilySlot): OgFamilyHero {
  return {
    runs: [{ text: name, color: OG_FAMILY_WHITE }],
    maxPt: slot === 'none' ? HERO_NO_ART_MAX_PT : HERO_MAX_PT,
    minPt: HERO_MIN_PT,
    wrap: true,
  };
}

function eyebrowRow(text: string): OgFamilyRow {
  return { runs: [{ text, color: OG_FAMILY_PLACE_ACCENT }], sizePt: 26, weight: 700, gapBelow: 16 };
}

function detailRow(text: string): OgFamilyRow {
  return { runs: [{ text, color: OG_FAMILY_MUTED }], sizePt: 22, weight: 500, maxLines: 2 };
}

/** Drawn name, bounded and cleaned, cut at a word with an ellipsis. Empty when nothing drawable is left in it. */
function drawableName(name: string): string {
  const cleaned = normalizeOgCardText(name, MAX_DRAWN_NAME_CODEPOINTS + 1);
  const codePoints = Array.from(cleaned);
  if (codePoints.length <= MAX_DRAWN_NAME_CODEPOINTS) return cleaned;
  const kept = codePoints.slice(0, MAX_DRAWN_NAME_CODEPOINTS).join('');
  const lastSpace = kept.lastIndexOf(' ');
  return `${lastSpace > 0 ? kept.slice(0, lastSpace) : kept}…`;
}

/** Drawn data minus raw photo bytes: the digest keys on the photo's own hash. */
export function digestPlaceCard(
  art: OgFamilyArtSpec | null,
  photo: OgFamilyPhotoArt | null,
  content: OgFamilyCardContent,
): string {
  return digestDrawnData({ art, photo: photo?.digest ?? null, content });
}

// --- gym --------------------------------------------------------------------

export type GymForCard = { uuid: string; name: string; imageUrl: string | null };

export type GymBoardsForCard = { boardTypes: string[]; boardSummaries: { boardType: string; angle: number }[] };

export type GymBoardArtChoice = { config: BoardConfig; angle: number };

/**
 * The board a gym card draws: the first of its board types with a default config,
 * in the order those are warmed. Null for a gym whose only boards have none, a
 * spray wall has no catalogue art to draw.
 */
export function pickGymBoardConfig(
  boardTypes: readonly string[],
  boardSummaries: GymBoardsForCard['boardSummaries'],
): GymBoardArtChoice | null {
  for (const [boardName, config] of Object.entries(FALLBACK_BOARD_PREVIEW_CONFIGS)) {
    if (!boardTypes.includes(boardName)) continue;
    const boardConfig: BoardConfig = {
      boardName: boardName as BoardName,
      layoutId: config.layout_id,
      sizeId: config.size_id,
      setIds: config.set_ids.join(','),
    };
    if (!isRenderableConfig(boardConfig)) continue;
    const angle = boardSummaries.find((summary) => summary.boardType === boardName)?.angle ?? DEFAULT_PLACE_ANGLE;
    return { config: boardConfig, angle };
  }
  return null;
}

/** `Kilter 30°` for one board at one angle, `Kilter + Tension` for several, null for none. */
export function describeGymBoards(
  boardTypes: readonly string[],
  boardSummaries: GymBoardsForCard['boardSummaries'],
): string | null {
  const types = [...new Set(boardTypes)];
  if (types.length === 0) return null;
  const labels = types.map((boardType) => BOARD_TYPE_LABELS[boardType] ?? boardType);
  if (labels.length > 1) return labels.join(' + ');
  const angles = new Set(boardSummaries.filter((summary) => summary.boardType === types[0]).map((row) => row.angle));
  return angles.size === 1 ? `${labels[0]} ${[...angles][0]}°` : labels[0];
}

/** LED colours in the four corners, so a gym with nothing to draw is not an empty panel. */
const NO_ART_FIELD_GLOW: NonNullable<OgFamilyCardContent['fieldGlow']> = {
  points: [
    { x: 140, y: 120, color: '#00D21F' },
    { x: 1060, y: 120, color: '#FF00CC' },
    { x: 180, y: 520, color: '#FF9A00' },
    { x: 1040, y: 500, color: '#00D9E8' },
  ],
  source: { w: 1200, h: 630 },
};

export function buildGymCardContent(params: {
  gym: Pick<GymForCard, 'name'> & GymBoardsForCard;
  hasArt: boolean;
  fontFamily: string;
}): OgFamilyCardContent {
  const { gym, hasArt, fontFamily } = params;
  const slot: OgFamilySlot = hasArt ? 'full' : 'none';
  const boardsLine = describeGymBoards(gym.boardTypes, gym.boardSummaries);
  return {
    slot,
    fontFamily,
    ...(boardsLine ? { eyebrow: eyebrowRow(boardsLine) } : {}),
    hero: placeHero(drawableName(gym.name) || GYM_FALLBACK_NAME, slot),
    rows: boardsLine ? [] : [detailRow(NO_BOARDS_LINE)],
    ...(hasArt ? {} : { fieldGlow: NO_ART_FIELD_GLOW }),
  };
}

// --- board ------------------------------------------------------------------

export type BoardForCard = {
  uuid: string;
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  name: string;
  angle: number;
  /** Masked by the schema: null for a board whose location a stranger may not see. */
  locationName: string | null;
};

function cleanLayoutName(layoutName: string, label: string): string {
  const cleaned = layoutName
    .replace(new RegExp(`\\b${escapeRegExp(label)}\\b`, 'gi'), '')
    .replace(/\bBoard\b/gi, '')
    .replace(/\bLayout\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^2\s+/, '');
  return cleaned || layoutName;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The catalogue's own names for this config, or empty when it has none. */
function catalogueNames(config: BoardConfig): { layoutName?: string; sizeName?: string } {
  try {
    const details = getBoardDetailsForBoard({
      board_name: config.boardName,
      layout_id: config.layoutId,
      size_id: config.sizeId,
      set_ids: config.setIds.split(',').map(Number),
    });
    return { layoutName: details.layout_name, sizeName: details.size_name };
  } catch {
    return {};
  }
}

/**
 * Strip the config off a name the app made up.
 *
 * The create flow names a board `Marco's Kilter Original 12×12` when the owner
 * leaves the field blank (`formatDefaultBoardName` in mobile). The config is
 * printed under the name already, so the card keeps `Marco's Kilter`, or
 * `Kilter Original` when there was no owner to keep. Only an exact default tail is
 * touched, directly after the board's own label: a name somebody chose stays as
 * they wrote it.
 */
export function stripDefaultBoardNameTail(name: string, config: BoardConfig): string {
  const label = BOARD_TYPE_LABELS[config.boardName];
  if (!label || config.boardName === 'spray') return name;
  const { layoutName, sizeName } = catalogueNames(config);
  if (!layoutName || !sizeName) return name;
  const layout = cleanLayoutName(layoutName, label).split(/\s+/).map(escapeRegExp).join('\\s+');
  const size = sizeName
    .replace(/\s*(high|wide)\s*/gi, ' ')
    .trim()
    .split(/\s*[x×]\s*/i)
    .map((part) => part.split(/\s+/).map(escapeRegExp).join('\\s+'))
    .join('\\s*[x×]\\s*');
  const tail = new RegExp(`^(.*\\b${escapeRegExp(label)})\\s+${layout}\\s+${size}\\s*$`, 'iu');
  const stripped = tail.exec(name)?.[1]?.trim();
  if (stripped === undefined) return name;
  // With no owner the tail was the whole name, and the brand alone says nothing
  // the line above the name does not.
  return stripped.toLowerCase() === label.toLowerCase() ? `${label} ${cleanLayoutName(layoutName, label)}` : stripped;
}

/** `Mirror · 12 x 8`: what the board's config is, without the brand the line above already says. */
export function boardConfigLine(config: BoardConfig): string {
  const label = BOARD_TYPE_LABELS[config.boardName] ?? config.boardName;
  const { layoutName, sizeName } = catalogueNames(config);
  const size = sizeName
    ?.replace(/\s*\b(high|wide)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return [layoutName && cleanLayoutName(layoutName, label), size].filter(Boolean).join(' · ');
}

export function buildBoardCardContent(params: {
  board: Omit<BoardForCard, 'uuid'>;
  config: BoardConfig;
  hasArt: boolean;
  fontFamily: string;
}): OgFamilyCardContent {
  const { board, config, hasArt, fontFamily } = params;
  const slot: OgFamilySlot = hasArt ? 'full' : 'none';
  const name = drawableName(stripDefaultBoardNameTail(board.name, config)) || BOARD_FALLBACK_NAME;
  const label = BOARD_TYPE_LABELS[config.boardName] ?? config.boardName;
  const configLine = boardConfigLine(config);
  const location = drawableName(board.locationName ?? '');
  return {
    slot,
    fontFamily,
    eyebrow: eyebrowRow(`${label} ${board.angle}°`),
    hero: placeHero(name, slot),
    rows: [
      ...(configLine ? [{ ...detailRow(configLine), gapBelow: 8 }] : []),
      ...(location ? [detailRow(location)] : []),
    ],
  };
}

// --- spray wall ---------------------------------------------------------------

/** `holdCount` is a true number about this wall, unlike a catalogue climb count. */
export function buildSprayCardContent(params: {
  board: Pick<BoardForCard, 'name' | 'angle' | 'locationName'>;
  holdCount: number;
  fontFamily: string;
}): OgFamilyCardContent {
  const { board, holdCount, fontFamily } = params;
  const location = drawableName(board.locationName ?? '');
  return {
    slot: 'full',
    fontFamily,
    eyebrow: eyebrowRow(`Spraywall · ${holdCount.toLocaleString('en-US')} ${holdCount === 1 ? 'hold' : 'holds'}`),
    hero: placeHero(drawableName(board.name) || SPRAY_FALLBACK_NAME, 'full'),
    rows: [detailRow([location, `${board.angle}°`].filter(Boolean).join(' · '))],
  };
}
