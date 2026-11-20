/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { matchesGlob } from 'node:path';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = parse(readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'));
const changes = workflow.jobs.changes;
const typecheck = workflow.jobs.typecheck;
type Step = { id?: string; name?: string; if?: string; run?: string; with?: Record<string, string> };
const steps: Step[] = typecheck.steps;
const changesStep = (changes.steps as Step[]).find((step) => step.id === 'filter');
const filters = parse(changesStep!.with!.filters) as Record<string, string[]>;

it('selects this filesystem-backed contract independently for a ci.yml-only pull request', () => {
  expect(filters.rootCi.some((glob) => matchesGlob('.github/workflows/ci.yml', glob))).toBe(true);
  const guard = (workflow.jobs.guards.steps as Step[]).find((step) =>
    step.run?.includes('scripts/__tests__/public-page-overflow-workflow.test.ts'),
  );
  expect(guard?.if).toContain("needs.changes.outputs.rootCi == 'true'");
  expect(guard?.run).toContain('vp test run --project scripts');
  expect(guard?.run).not.toContain('--changed');
});

it('includes non-JS public appearance changes and the gate itself, while mobile-only changes stay outside it', () => {
  const triggers = (file: string) => filters.publicOverflow.some((glob) => matchesGlob(file, glob));
  for (const file of [
    'packages/web/app/theme/colors.css',
    'packages/web/public/boards/kilter.webp',
    'packages/shared/i18n/locales/de/marketing.json',
    'packages/backend/src/graphql/server.ts',
    'scripts/ci/public-page-overflow.sh',
    'pnpm-lock.yaml',
    '.github/workflows/ci.yml',
  ])
    expect(triggers(file), file).toBe(true);
  expect(triggers('packages/mobile/src/screens/profile.tsx')).toBe(false);
  expect(changes.outputs.publicOverflow).toContain("github.event_name == 'pull_request'");
  expect(typecheck.if).toContain("needs.changes.outputs.publicOverflow == 'true'");
});

it('runs the browser gate after the artifact-producing typecheck and includes its failure in CI status', () => {
  const build = steps.findIndex((step) => step.run === 'vp run typecheck');
  const browser = steps.findIndex((step) => step.run === 'bash scripts/ci/public-page-overflow.sh');
  expect(build).toBeGreaterThanOrEqual(0);
  expect(browser).toBeGreaterThan(build);
  expect(steps[browser].if).toBe("needs.changes.outputs.publicOverflow == 'true'");
  expect(steps[browser]).not.toHaveProperty('continue-on-error');
  expect(workflow.jobs['ci-status'].needs).toContain('typecheck');
});
