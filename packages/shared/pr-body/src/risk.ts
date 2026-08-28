import { CODE_FENCE, LIST_MARKER, extractSection, linesOutsideFences } from './sections';

// The heading that marks the risk score. Case-insensitive, `##` or `###`.
export const RISK_HEADING = /^#{2,3}\s+risk\s*$/i;
// `Risk: 3/5 — why`. The label and score may be bolded; the dash before the
// reason may be an em/en dash, a hyphen or a colon. `Risk: /5 —` (the template
// placeholder) has no digit, so it doesn't match.
const RISK_LINE = /^\**\s*risk\s*:?\s*\**\s*([1-5])\s*\/\s*5\s*\**\s*(?:[—–\-:]+\s*(.*))?$/i;
// Any `risk: N/5` line, whatever N — so an out-of-range score can be reported
// as such rather than as "missing".
const RISK_ANY_LINE = /^\**\s*risk\s*:?\s*\**\s*(\d+)\s*\/\s*5\b/i;

export type RiskLevel = 1 | 2 | 3 | 4 | 5;

export type Risk = {
  level: RiskLevel;
  /** The words after the dash, or null when the author gave a bare score. */
  reason: string | null;
};

function withoutFences(lines: readonly string[]): string[] {
  const kept: string[] = [];
  let insideFence = false;
  for (const line of lines) {
    if (CODE_FENCE.test(line)) {
      insideFence = !insideFence;
      continue;
    }
    if (!insideFence) kept.push(line);
  }
  return kept;
}

function candidateLines(body: string): string[] {
  // The `## Risk` section first; then the whole body, so a `Risk: 3/5` line
  // under Summary still counts. Fenced code never counts anywhere — a
  // `Risk: 3/5 — example` inside a code sample must not satisfy the gate.
  const section = withoutFences(extractSection(body, RISK_HEADING) ?? []);
  const everywhere = linesOutsideFences(body);
  return [...section, ...everywhere].map((line) => line.trim().replace(LIST_MARKER, '').trim());
}

/** Reads `Risk: N/5 — why` from the body. Null when no in-range score is present. */
export function parseRisk(body: string | null | undefined): Risk | null {
  if (!body) return null;
  for (const line of candidateLines(body)) {
    const match = RISK_LINE.exec(line);
    if (!match) continue;
    const level = Number(match[1]) as RiskLevel;
    const reason = match[2]?.trim() ?? '';
    return { level, reason: reason.length > 0 ? reason : null };
  }
  return null;
}

/**
 * The first `risk: N/5` score written in the body, in or out of range, or null
 * when none is written. Lets the gate say "6 is not a risk level" instead of
 * "missing".
 */
export function findWrittenRiskScore(body: string | null | undefined): number | null {
  if (!body) return null;
  for (const line of candidateLines(body)) {
    const match = RISK_ANY_LINE.exec(line);
    if (match) return Number(match[1]);
  }
  return null;
}
