/**
 * Which grades to print above the "Community" ascents-by-angle bars, and how.
 *
 * A board offers up to fifteen angles, which on a phone leaves each bar about
 * 14px with a 6px gap — narrower than "V10". The first attempt at #4164 stood
 * those labels on end, and a rotated 11pt grade wedged between dense bars is
 * unreadable (see the issue thread). Grades repeat across neighbouring angles
 * though, so there is a better trade than shrinking or turning the text: print
 * fewer labels and keep every one of them upright and legible.
 *
 * The ladder, widest-label first so the whole row reads the same way:
 *  1. Fits its own column → label every bar, exactly as before.
 *  2. Doesn't fit, but it's a both-formats grade → stack "V6" over "7A", which
 *     roughly halves the width it needs.
 *  3. Still wider than a column → label only where the grade CHANGES, and only
 *     once there's been enough room since the last label. Unlabelled bars still
 *     carry their grade in their colour, and the labels that survive mark where
 *     each grade band begins.
 */
import { splitGradeLabel } from '@boardsesh/play-view';
import { CHART_LABEL_LINE_HEIGHT, estimateLabelWidth } from '../../lib/chart/label-metrics';

export type GradeBarLabels = {
  /** Lines to draw above each bar, by bar index. Empty = this bar goes bare. */
  linesByBar: string[][];
  /** Width of the label box gifted-charts should render for every bar. */
  width: number;
  /** Left offset that keeps a wider-than-bar box centred over its own bar. */
  left: number;
  /** Height the plot must give up so a stacked label clears the tallest bar. */
  headroom: number;
  /** True when labels are stacked onto their two grade formats. */
  stacked: boolean;
  /** Bars between labels — 1 means every bar is labelled. */
  columnsPerLabel: number;
};

/**
 * `columnWidth` is the horizontal room one bar owns before it would collide with
 * the next: the bar plus the gap beside it.
 */
export function buildGradeBarLabels(grades: readonly string[], barWidth: number, columnWidth: number): GradeBarLabels {
  if (grades.length === 0) {
    return { linesByBar: [], width: barWidth, left: 0, headroom: 0, stacked: false, columnsPerLabel: 1 };
  }

  // Size the row off its widest grade so every bar gets the same treatment.
  const widestOneLine = grades.reduce((widest, grade) => Math.max(widest, estimateLabelWidth(grade)), 0);

  // Stacking only earns its keep if splitting genuinely narrows the row, and
  // only helps when the label is too wide to begin with.
  let renderWidth = widestOneLine;
  let stacked = false;
  if (widestOneLine > columnWidth) {
    const parts = grades.map((grade) => splitGradeLabel(grade));
    if (parts.some((pieces) => pieces.length > 1)) {
      const widestPart = parts.reduce(
        (widest, pieces) => pieces.reduce((inner, piece) => Math.max(inner, estimateLabelWidth(piece)), widest),
        0,
      );
      if (widestPart < widestOneLine) {
        renderWidth = widestPart;
        stacked = true;
      }
    }
  }

  const columnsPerLabel = Math.max(1, Math.ceil(renderWidth / Math.max(1, columnWidth)));
  const width = Math.max(barWidth, renderWidth);

  const linesByBar: string[][] = grades.map(() => []);
  const linesFor = (grade: string): string[] => (stacked ? splitGradeLabel(grade) : [grade]);

  if (columnsPerLabel === 1) {
    grades.forEach((grade, index) => {
      linesByBar[index] = linesFor(grade);
    });
  } else {
    // Crowded: the first bar always speaks, then only a bar that says something
    // new AND has had room to say it since the last one.
    let lastLabelledIndex = 0;
    let lastLabelledGrade = grades[0];
    linesByBar[0] = linesFor(grades[0]);
    grades.forEach((grade, index) => {
      if (index === 0) return;
      if (grade === lastLabelledGrade) return;
      if (index - lastLabelledIndex < columnsPerLabel) return;
      linesByBar[index] = linesFor(grade);
      lastLabelledIndex = index;
      lastLabelledGrade = grade;
    });
  }

  return {
    linesByBar,
    width,
    left: Math.round((barWidth - width) / 2),
    headroom: stacked ? CHART_LABEL_LINE_HEIGHT : 0,
    stacked,
    columnsPerLabel,
  };
}
