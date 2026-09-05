import { findWrittenRiskScore, parseRisk, type Risk } from './risk';
import { parseTestPlan, type TestPlan } from './test-plan';
import { describeDeveloperVoice, findDeveloperVoice } from './tester-voice';

/** Maintainer override: a PR carrying this label passes the gate unchecked. */
export const SKIP_QA_GATE_LABEL = 'skip-qa-gate';
/** A tester on a phone gives up after five. */
export const MAX_TEST_PLAN_STEPS = 5;
/** One action plus what to see; longer than this is a paragraph. */
export const MAX_STEP_CHARS = 140;
/** Soft target per step; over it is a warning, not a failure. */
export const MAX_STEP_WORDS = 12;

export type PrBodyValidation = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  testPlan: TestPlan | null;
  risk: Risk | null;
};

function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => word.length > 0).length;
}

/**
 * The PR gate's rule set, in one place so CI, tests, and the backend agree:
 *  - `## Test plan` with 1–5 list steps; every step ≤ 140 chars (hard), ≤ 12 words (soft).
 *  - Every step addressed to the tester, not the author: no commands to run and
 *    no repo paths to open (hard) — see tester-voice.ts.
 *  - `Risk: N/5 — why` with N in 1–5 (hard); a reason (soft).
 * The test plan is always required — "1. CI green." is a valid plan for an
 * internal change. `skip-qa-gate` on the PR short-circuits everything.
 */
export function validatePrBody(body: string | null | undefined, labels: readonly string[] = []): PrBodyValidation {
  const testPlan = parseTestPlan(body);
  const risk = parseRisk(body);
  const errors: string[] = [];
  const warnings: string[] = [];

  if (labels.includes(SKIP_QA_GATE_LABEL)) {
    warnings.push(`"${SKIP_QA_GATE_LABEL}" label present — test plan and risk not checked.`);
    return { ok: true, errors, warnings, testPlan, risk };
  }

  if (testPlan === null) {
    errors.push('Missing a "## Test plan" section. Add 1–5 numbered steps: "1. Do X → see Y".');
  } else if (testPlan.steps.length === 0) {
    errors.push('The "## Test plan" section has no steps. Write 1–5 numbered steps: "1. Do X → see Y".');
  } else {
    if (testPlan.steps.length > MAX_TEST_PLAN_STEPS) {
      errors.push(`The test plan has ${testPlan.steps.length} steps; keep it to ${MAX_TEST_PLAN_STEPS} or fewer.`);
    }
    testPlan.steps.forEach((step, index) => {
      const number = index + 1;
      if (step.length > MAX_STEP_CHARS) {
        errors.push(`Step ${number} is ${step.length} characters; keep each step under ${MAX_STEP_CHARS}.`);
      } else if (countWords(step) > MAX_STEP_WORDS) {
        warnings.push(`Step ${number} is ${countWords(step)} words; aim for ${MAX_STEP_WORDS} or fewer.`);
      }

      // Length is the easy half. A step can be short, numbered, and still
      // written for the person who made the change rather than the one testing
      // it — the plan then renders in the app as an instruction nobody can follow.
      const voice = findDeveloperVoice(step);
      if (voice) errors.push(describeDeveloperVoice(number, voice));
    });
  }

  if (risk === null) {
    const written = findWrittenRiskScore(body);
    if (written === null) {
      errors.push('Missing a risk score. Add a "## Risk" section with "Risk: N/5 — why" (N from 1 to 5).');
    } else {
      errors.push(`Risk must be between 1 and 5 (got ${written}).`);
    }
  } else if (risk.reason === null) {
    warnings.push('The risk score has no reason — add a few words after the dash.');
  }

  return { ok: errors.length === 0, errors, warnings, testPlan, risk };
}
