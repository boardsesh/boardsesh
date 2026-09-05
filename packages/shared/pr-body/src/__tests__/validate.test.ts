import { describe, expect, it } from 'vitest';
import { SKIP_QA_GATE_LABEL, validatePrBody } from '../validate';

const GOOD = [
  '## Summary',
  'Does a thing.',
  '## Test plan',
  '1. Open Boards → list loads',
  '2. Tap Kilter → detail opens',
  '## Risk',
  'Risk: 2/5 — isolated UI',
].join('\n');

describe('validatePrBody', () => {
  it('passes a compliant body with no warnings', () => {
    const result = validatePrBody(GOOD);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.testPlan?.steps).toHaveLength(2);
    expect(result.risk).toEqual({ level: 2, reason: 'isolated UI' });
  });

  it('fails a plan that tells the tester what the author ran', () => {
    const body = [
      '## Test plan',
      '1. CI green.',
      '2. Run `vp run typecheck:mobile` → clean.',
      '## Risk',
      'Risk: 1/5 — CI only',
    ].join('\n');
    const result = validatePrBody(body);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Step 2');
    expect(result.errors[0]).toContain('Summary');
  });

  it('fails the untouched template', () => {
    const template = ['## Test plan', '<!-- guide -->', '1.', '## Risk', '<!-- rubric -->', 'Risk: /5 —'].join('\n');
    const result = validatePrBody(template);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      'The "## Test plan" section has no steps. Write 1–5 numbered steps: "1. Do X → see Y".',
      'Missing a risk score. Add a "## Risk" section with "Risk: N/5 — why" (N from 1 to 5).',
    ]);
  });

  it('fails when the sections are missing altogether', () => {
    const result = validatePrBody('## Summary\nnothing else');
    expect(result.errors).toEqual([
      'Missing a "## Test plan" section. Add 1–5 numbered steps: "1. Do X → see Y".',
      'Missing a risk score. Add a "## Risk" section with "Risk: N/5 — why" (N from 1 to 5).',
    ]);
  });

  it('accepts "1. CI green." as a plan for an internal change', () => {
    expect(validatePrBody('## Test plan\n1. CI green.\n## Risk\nRisk: 1/5 — deps').ok).toBe(true);
  });

  it('fails on more than five steps and on a step over 140 characters', () => {
    const steps = Array.from({ length: 6 }, (_, index) => `${index + 1}. step ${index + 1}`).join('\n');
    expect(validatePrBody(`## Test plan\n${steps}\n## Risk\nRisk: 1/5 — x`).errors).toEqual([
      'The test plan has 6 steps; keep it to 5 or fewer.',
    ]);
    const long = `1. ${'a'.repeat(141)}`;
    expect(validatePrBody(`## Test plan\n${long}\n## Risk\nRisk: 1/5 — x`).errors).toEqual([
      'Step 1 is 141 characters; keep each step under 140.',
    ]);
  });

  it('warns on a wordy step and a bare risk score', () => {
    const wordy = '1. open the app then go to the boards tab and pick the first board you see there';
    const result = validatePrBody(`## Test plan\n${wordy}\n## Risk\nRisk: 3/5`);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([
      'Step 1 is 17 words; aim for 12 or fewer.',
      'The risk score has no reason — add a few words after the dash.',
    ]);
  });

  it('reports an out-of-range risk score as such', () => {
    expect(validatePrBody('## Test plan\n1. x\n## Risk\nRisk: 6/5 — too much').errors).toEqual([
      'Risk must be between 1 and 5 (got 6).',
    ]);
  });

  it('short-circuits on the skip label', () => {
    const result = validatePrBody('## Summary\nnothing', [SKIP_QA_GATE_LABEL]);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual(['"skip-qa-gate" label present — test plan and risk not checked.']);
  });
});
