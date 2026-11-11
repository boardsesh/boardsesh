import { getGradeColor } from '@boardsesh/board-constants';
import { OG_CARD_BOARD_LINE_SEPARATOR } from './og-board-line';
import {
  OG_FAMILY_MUTED,
  OG_FAMILY_WHITE,
  liftGradeColorForCard,
  renderOgFamilyTextLayers,
  type OgFamilyCardContent,
  type OgFamilyHero,
  type OgFamilyRow,
} from './og-family';

/**
 * The climb's identity on a `/og/climb` card, laid out on the share-card family's
 * `full` slot: the grade as the hero in its grade colour, then the climb name, the
 * setter, and the board line with the wall angle. See docs/og-climb.md.
 *
 * This module only decides WHAT the card says; `og-family.ts` typesets it through
 * Pango, which escapes every string for markup and measures every fit.
 */

/**
 * A grade is one line, shrunk to fit and never cut: `8C+/V16` has to sit whole
 * inside the search crop. 96pt is the profile card's grade size, so a climb and a
 * climber's hardest send read the same.
 */
const GRADE_HERO_MAX_PT = 96;
/** With no grade the name leads, wrapping; below this it truncates instead. */
const NAME_HERO_MAX_PT = 64;
const NAME_HERO_MIN_PT = 34;
/** With no grade and no name the board's brand leads, like a place card's name. */
const BOARD_HERO_MAX_PT = 72;

const NAME_PT = 34;
const NAME_MAX_LINES = 3;
const DETAIL_PT = 20;
const BOARD_LINE_MAX_LINES = 2;

export type OgCardContent = {
  /**
   * Climb name. Normalising it is the caller's job (`normalizeOgCardText`);
   * the trim here is belt and braces for a caller that skipped it, not a second
   * normalisation pass.
   */
  name?: string;
  /** Grade label, e.g. `7a/V6`. */
  grade?: string;
  /** Setter's display name. Same contract as `name`. */
  setter?: string;
  /** Board wall angle in degrees. */
  angle?: number;
  /**
   * e.g. `Kilter · Original · 12 x 12`, derived server-side from the board config.
   * Parts are joined with `OG_CARD_BOARD_LINE_SEPARATOR`; the first one leads a
   * card that has no grade and no name.
   */
  boardLine?: string;
  /** Font family passed to Pango. Left to fontconfig's fallback chain when unset. */
  fontFamily?: string;
};

type TextLayer = { input: Buffer; left: number; top: number };

/**
 * The grade's colour on the card's dark ground: the grade scale's own colour,
 * lifted the same way every family card lifts it, so a V10 reads as purple rather
 * than vanishing into the field.
 */
export function ogCardGradeColor(grade: string): string {
  const color = getGradeColor(grade);
  return color ? liftGradeColorForCard(color) : OG_FAMILY_WHITE;
}

function detailRow(text: string, maxLines = 1): OgFamilyRow {
  return { runs: [{ text, color: OG_FAMILY_MUTED }], sizePt: DETAIL_PT, weight: 500, maxLines };
}

/**
 * What the card says, as family content, or null when there is nothing to say.
 *
 * The hero is the first of grade, name, board brand and angle that the card has.
 * An already-shipped binary sends no identity params, so its card leads with the
 * board brand from the board line the server derives.
 */
export function buildOgClimbCardContent(content: OgCardContent): OgFamilyCardContent | null {
  const name = content.name?.trim() ?? '';
  const grade = content.grade?.trim() ?? '';
  const setter = content.setter?.trim() ?? '';
  const boardLine = content.boardLine?.trim() ?? '';
  const angleLabel = content.angle === undefined ? '' : `${content.angle}°`;
  if (!name && !grade && !setter && !boardLine && !angleLabel) return null;

  const withAngle = (line: string) => [line, angleLabel].filter(Boolean).join(OG_CARD_BOARD_LINE_SEPARATOR);
  const rows: OgFamilyRow[] = [];
  let hero: OgFamilyHero;

  if (grade) {
    hero = {
      runs: [{ text: grade, color: ogCardGradeColor(grade) }],
      maxPt: GRADE_HERO_MAX_PT,
      wrap: false,
      tight: true,
    };
    if (name) {
      rows.push({
        runs: [{ text: name, color: OG_FAMILY_WHITE }],
        sizePt: NAME_PT,
        weight: 700,
        maxLines: NAME_MAX_LINES,
        gapBelow: 12,
      });
    }
  } else if (name) {
    hero = {
      runs: [{ text: name, color: OG_FAMILY_WHITE }],
      maxPt: NAME_HERO_MAX_PT,
      minPt: NAME_HERO_MIN_PT,
      wrap: true,
    };
  } else if (boardLine) {
    const [brand, ...details] = boardLine.split(OG_CARD_BOARD_LINE_SEPARATOR);
    hero = { runs: [{ text: brand, color: OG_FAMILY_WHITE }], maxPt: BOARD_HERO_MAX_PT, minPt: 40, wrap: true };
    if (setter) rows.push(detailRow(setter));
    const rest = withAngle(details.join(OG_CARD_BOARD_LINE_SEPARATOR));
    if (rest) rows.push(detailRow(rest, BOARD_LINE_MAX_LINES));
    return { slot: 'full', fontFamily: content.fontFamily, hero, rows };
  } else if (angleLabel) {
    hero = { runs: [{ text: angleLabel, color: OG_FAMILY_WHITE }], maxPt: GRADE_HERO_MAX_PT, wrap: false, tight: true };
    if (setter) rows.push(detailRow(setter));
    return { slot: 'full', fontFamily: content.fontFamily, hero, rows };
  } else {
    // Only a setter: the name of who set it leads, the way a setter card leads.
    hero = { runs: [{ text: setter, color: OG_FAMILY_WHITE }], maxPt: NAME_HERO_MAX_PT, minPt: 34, wrap: true };
    return { slot: 'full', fontFamily: content.fontFamily, hero, rows };
  }

  if (setter) rows.push(detailRow(setter));
  const boardRow = withAngle(boardLine);
  if (boardRow) rows.push(detailRow(boardRow, BOARD_LINE_MAX_LINES));
  return { slot: 'full', fontFamily: content.fontFamily, hero, rows };
}

/**
 * Build the sharp composite layers for the card's text, on the family grid.
 *
 * Returns an empty array when there is nothing to say. A Pango failure rejects;
 * the caller decides whether a card may go out without words.
 */
export async function renderOgCardLayers(content: OgCardContent): Promise<TextLayer[]> {
  return (await renderOgCardText(content)).layers;
}

/**
 * `renderOgCardLayers`, plus why the app icon is missing when it is. A card drawn
 * without its icon is not the final drawing, so the caller must not cache it
 * under the real key.
 */
export async function renderOgCardText(
  content: OgCardContent,
): Promise<{ layers: TextLayer[]; iconError: string | null }> {
  const familyContent = buildOgClimbCardContent(content);
  if (!familyContent) return { layers: [], iconError: null };
  const { layers, iconError } = await renderOgFamilyTextLayers(familyContent);
  return { layers, iconError };
}
