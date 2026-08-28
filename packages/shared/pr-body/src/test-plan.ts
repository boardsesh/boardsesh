import { CODE_FENCE, LIST_MARKER, extractSection, isJunkLine } from './sections';

// The heading that marks the tester-facing steps. Case-insensitive, `##` or
// `###`, optional trailing whitespace.
export const TEST_PLAN_HEADING = /^#{2,3}\s+test plan\s*$/i;

export type TestPlan = {
  /** One entry per list item, markers stripped, continuation lines folded in. */
  steps: string[];
  /** The section as written (comments and junk lines stripped), for readers that render it verbatim. */
  raw: string;
};

/**
 * Reads the `## Test plan` section. Steps are the section's list items
 * (numbered or bulleted); an indented or unmarked line that follows a step is
 * folded into it, so a sub-bullet with the expected result stays with its
 * action. Lines inside a code fence are never steps. Returns null when the
 * heading is absent; an empty `steps` array means the section exists but holds
 * no list items (the template's bare `1.` counts as nothing).
 */
export function parseTestPlan(body: string | null | undefined): TestPlan | null {
  const lines = extractSection(body, TEST_PLAN_HEADING);
  if (lines === null) return null;

  const steps: string[] = [];
  // The section minus junk lines (trailers, link-only lines), for readers that
  // render it verbatim when the steps can't be parsed.
  const kept: string[] = [];
  let insideFence = false;
  for (const line of lines) {
    if (CODE_FENCE.test(line)) {
      insideFence = !insideFence;
      kept.push(line);
      continue;
    }
    if (insideFence) {
      kept.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (trimmed.length === 0 || isJunkLine(trimmed)) continue;
    kept.push(line);

    // A list marker at column 0 starts a step; an indented one is a sub-bullet
    // (the expected result under its action) and folds into the step above.
    const indented = /^\s/.test(line);
    if (LIST_MARKER.test(trimmed) && !indented) {
      const text = trimmed.replace(LIST_MARKER, '').trim();
      // The template ships `1.` with nothing after it; that's a placeholder,
      // not a step.
      if (text.length > 0) steps.push(text);
      continue;
    }

    // Continuation of the previous step: an indented sub-bullet or wrapped prose.
    if (steps.length > 0) {
      const last = steps.length - 1;
      steps[last] = `${steps[last]} ${trimmed.replace(LIST_MARKER, '').trim()}`.trim();
    }
  }

  return { steps, raw: kept.join('\n').trim() };
}
