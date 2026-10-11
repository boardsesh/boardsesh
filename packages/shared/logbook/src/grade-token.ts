/**
 * ONE number, and whether it needs a glyph to say whose it is.
 *
 * Boardsesh shows a climb's grade on two kinds of surface, and they disagree
 * about which grade is the unremarkable one:
 *
 *   - CATALOG surfaces (`baseline: 'crowd'`) — the climbs list, the play-drawer
 *     header. These are about the board's climbs, so the crowd's number is the
 *     expected one and YOUR number is the exception.
 *   - DIARY surfaces (`baseline: 'personal'`) — the logbook row, the share-beta
 *     picker row. These are about what YOU did, so your number is the expected
 *     one and the CROWD's number is the exception.
 *
 * From that falls the single rule every surface follows:
 *
 *   **A glyph on the number means the number is not the one this screen is
 *   about.**
 *
 * `person` on a catalog surface, `people` on a diary surface, and never both,
 * because only ONE number is ever in the grade column. The other number, when
 * there is one and it differs, leaves the column entirely: it becomes
 * `crowdLineToken`, the leading token of whatever stats/meta line the surface
 * already has ("V0 · 412 · 2.9★ · woods"). That is what keeps the column one
 * line tall in every state — no stacked second grade, no smaller type tier, no
 * negative margin pulling two lines together, and no rule that drops the second
 * line once Dynamic Type grows.
 *
 * Pure TS on purpose — no React, no formatting. Callers own the formatting (it
 * needs each platform's grade-format preference) and pass the rendered labels
 * back in.
 *
 * Supersedes `derivePersonalGradeDisplay` and `deriveLogbookGradeDisplay`,
 * which encoded the two-line composition this replaces.
 */

import { splitGradeLabel } from '@boardsesh/play-view';

/** Whose grade a number is. */
export type GradeTokenSource = 'personal' | 'crowd';

/** Whose grade a surface is ABOUT — the number that needs no explaining there. */
export type GradeTokenBaseline = GradeTokenSource;

export type GradeTokenModel = {
  /** Whose grade the column shows. `'none'` when there is no grade at all. */
  source: GradeTokenSource | 'none';
  /** The label to render in the column. Empty string when `source` is `'none'`. */
  label: string;
  /**
   * The crowd's grade for the surface's stats/meta line, or `null` for no
   * token. Only ever set when the crowd has a grade AND it differs from the
   * label in the column — a token repeating the column would be a second
   * number stating no difference.
   */
  crowdLineToken: string | null;
  /**
   * Whether the number wears a provenance glyph: `source !== baseline`.
   *
   * Note this is NOT "the two grades disagree". #5143 originally marked only on
   * disagreement, which made the same climb gain and lose a glyph as its crowd
   * grade drifted past yours — the grammar changed state to state, so a reader
   * could not learn it. Marking on provenance instead means the glyph always
   * answers the same question, and a search list over a 30k-climb board still
   * shows it on a minority of rows because a minority of rows are ones you
   * personally graded.
   */
  mark: boolean;
};

export type DeriveGradeTokenInput = {
  /**
   * The climber's own rendered grade. Pass `null` for BOTH "never graded it"
   * and "we haven't fetched the logbook yet" — an unknown bucket must render
   * exactly like an ungraded one rather than guessing (#3940).
   */
  personalLabel?: string | null;
  /** The crowd's rendered grade (community consensus, or the Boardsesh grade). */
  crowdLabel?: string | null;
  /** Whose grade this surface is about. Defaults to the catalog reading. */
  baseline?: GradeTokenBaseline;
};

function present(label: string | null | undefined): string | null {
  return label == null || label === '' ? null : label;
}

/**
 * Decide which grade a surface shows, whether it is marked, and what (if
 * anything) the surface's meta line should lead with.
 *
 * EQUALITY IS COMPARED ON THE RENDERED LABEL, NEVER ON THE DIFFICULTY ID.
 * Aurora's ids 10, 11 and 12 are 4a, 4b and 4c — three distinct grades that all
 * render "V0". A climber who logged 4c on a climb the board lists as 4a has not
 * disagreed with anything a reader can see, so an id comparison would print
 * "V0" beside "V0": a second number stating no difference. (This is exactly
 * where the retired `deriveLogbookGradeDisplay` was wrong — it compared ids.)
 * Comparing labels also makes the answer follow the climber's own
 * V-grade/Font/both preference for free, with no scale maths here.
 */
export function deriveGradeTokenModel({
  personalLabel,
  crowdLabel,
  baseline = 'crowd',
}: DeriveGradeTokenInput): GradeTokenModel {
  const personal = present(personalLabel);
  const crowd = present(crowdLabel);

  if (personal === null && crowd === null) {
    return { source: 'none', label: '', crowdLineToken: null, mark: false };
  }

  // Your grade wins wherever you have one (#4796, #4828) — on both kinds of
  // surface. What changes between them is only whether that needs saying.
  const source: GradeTokenSource = personal !== null ? 'personal' : 'crowd';
  const label = personal ?? (crowd as string);

  // Under the `'both'` format the labels are "V5+ / 6C+". The meta-line token
  // takes only the V half — it is already the first half of the number in the
  // column, so the two can never look like they are on different scales, and
  // the token costs the line no extra width.
  const crowdLineToken = crowd !== null && crowd !== label ? (splitGradeLabel(crowd)[0] ?? null) : null;

  return { source, label, crowdLineToken, mark: source !== baseline };
}

/**
 * How a screen reader should say the number in the column.
 *
 * An unmarked number is read bare — the surface's own context already says
 * whose it is. A marked one names its owner, because the glyph that says so
 * visually is not spoken.
 *
 * `t` is the caller's i18next `t`; the keys are namespace-qualified so any
 * caller's binding resolves them. They live in `common`, and because the i18n
 * orphan checker scans only `packages/web/{app,scripts}` and
 * `packages/mobile/{src,app}`, each mobile consumer carries an `i18n-keep`
 * marker for them.
 */
export type GradeTokenTranslate = (key: string, values: { grade: string }) => string;

export function gradeTokenA11yLabel(model: GradeTokenModel, t: GradeTokenTranslate): string | null {
  if (model.source === 'none') return null;
  if (!model.mark) return model.label;
  return model.source === 'personal'
    ? t('common:mobile.gradeToken.a11yYours', { grade: model.label })
    : t('common:mobile.gradeToken.a11yCommunity', { grade: model.label });
}
