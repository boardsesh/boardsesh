import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
  name?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  'continue-on-error'?: boolean;
}
interface Job {
  needs?: string[];
  if?: string;
  'runs-on': string;
  'timeout-minutes'?: number;
  strategy?: unknown;
  services?: Record<string, unknown>;
  steps: Step[];
}
const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as { jobs: Record<string, Job> };
const compatibility = workflow.jobs['test-auth-compatibility'];
const backend = workflow.jobs['test-backend'];
const proofs = [
  'test:native-contract',
  'test:auth-prototype',
  'test:auth-authority',
  'test:auth-identities',
  'test:auth-web-credential-proof',
  'test:auth-prototype:browser',
  'test:auth-browser-proof-cookies',
];

describe('auth compatibility CI has an independent complete budget', () => {
  it('owns its services and runs once for the same inputs as backend tests', () => {
    expect(compatibility.needs).toEqual(['changes']);
    expect(backend.if).toBe(
      "needs.changes.outputs.backend == 'true' || needs.changes.outputs.sharedDeps == 'true' || needs.changes.outputs.rootCi == 'true'",
    );
    expect(compatibility.if).toBe(`${backend.if} || needs.changes.outputs.authCompatibility == 'true'`);
    expect(compatibility['runs-on']).toBe('ubuntu-latest');
    expect(compatibility.strategy).toBeUndefined();
    expect(compatibility.services).toEqual(backend.services);
    expect(compatibility['timeout-minutes']).toBe(30);
    expect(backend['timeout-minutes']).toBe(40);
  });
  it.each(proofs)('runs the complete %s task exactly once without changed-file selection', (proof) => {
    const command = `vp run ${proof}`;
    const selected = compatibility.steps.filter((step) => step.run === command);
    expect(selected).toHaveLength(1);
    expect(selected[0].if).toBe('${{ !cancelled() }}');
    expect(selected[0]['continue-on-error']).toBeUndefined();
    expect(
      selected[0].env?.[
        proof === 'test:native-contract' ? 'NATIVE_CONTRACT_DATABASE_URL' : 'AUTH_PROTOTYPE_DATABASE_URL'
      ],
    ).toBe('postgresql://postgres:postgres@localhost:5433/postgres');
    expect(
      Object.values(workflow.jobs).flatMap((job) => job.steps.filter((step) => step.run === command)),
    ).toHaveLength(1);
    expect(backend.steps.some((step) => step.run === command)).toBe(false);
  });
  it('retains serial backend execution, full-install fallback and browser installation', () => {
    const commands = backend.steps.map((step) => step.run ?? '').join('\n');
    expect(commands).toContain('vp test run --project backend $selection');
    expect(commands).toContain('vp test run --project backend-serial');
    expect(commands).toContain('install inputs changed; running the whole backend project');
    expect(
      compatibility.steps.filter((step) => step.run === 'vp exec playwright install --with-deps chromium'),
    ).toHaveLength(1);
  });
  it('runs cookie recovery after Chromium and preserves all actual proof inputs', () => {
    const install = compatibility.steps.findIndex(
      (step) => step.run === 'vp exec playwright install --with-deps chromium',
    );
    const proof = compatibility.steps.findIndex((step) => step.run === 'vp run test:auth-browser-proof-cookies');
    expect(install).toBeGreaterThanOrEqual(0);
    expect(proof).toBeGreaterThan(install);
    expect(compatibility.steps[proof].env?.AUTH_PROTOTYPE_REDIS_URL).toBe('redis://localhost:6380');
  });
  it('targets web auth/proof inputs without widening the baseline backend trigger', () => {
    const source = readFileSync('.github/workflows/ci.yml', 'utf8');
    const parsed = parse(source) as {
      jobs: { changes: { outputs: Record<string, string>; steps: { id?: string; with?: { filters?: string } }[] } };
    };
    const filter = parsed.jobs.changes.steps.find((step) => step.id === 'filter')?.with?.filters;
    expect(filter).toBeDefined();
    const filters = parse(filter!) as Record<string, string[]>;
    expect(filters.authCompatibility).toEqual(
      expect.arrayContaining([
        'packages/web/auth-prototype/**',
        'packages/web/playwright.auth-prototype.config.ts',
        'packages/web/app/lib/auth/**',
        'packages/web/app/lib/partner-oauth/**',
        'packages/web/app/api/auth/**',
        'packages/web/app/api/internal/auth/**',
        'packages/web/app/api/internal/ws-auth/**',
        'packages/web/app/lib/seo/base-url.ts',
        'packages/web/vite.config.ts',
        'packages/web/tsconfig.json',
        'packages/web/next.config.ts',
        'packages/web/middleware.ts',
      ]),
    );
    expect(filters.backend).not.toContain('packages/web/app/lib/auth/**');
    expect(filters.authCompatibility).not.toContain('packages/web/**');
    expect(parsed.jobs.changes.outputs.authCompatibility).toBe(
      "${{ github.event_name != 'pull_request' && 'true' || steps.filter.outputs.authCompatibility }}",
    );
    expect(parsed.jobs.changes.outputs.runAny).toContain("steps.filter.outputs.authCompatibility == 'true'");
  });
  it.each(['failure', 'cancelled'])('makes %s in compatibility fail the required aggregate', (result) => {
    const status = workflow.jobs['ci-status'];
    expect(status.needs).toContain('test-auth-compatibility');
    const results = Object.fromEntries(
      (status.needs ?? []).map((name) => [name, { result: name === 'test-auth-compatibility' ? result : 'success' }]),
    );
    const execution = spawnSync('bash', ['-c', status.steps[0].run ?? 'exit 0'], {
      encoding: 'utf8',
      env: { ...process.env, RESULTS: JSON.stringify(results) },
    });
    expect(execution.status).toBe(1);
    expect(execution.stdout).toContain(`test-auth-compatibility: ${result}`);
  });
  it('runs its YAML boundary guard without an affected-file gate', () => {
    const guard = workflow.jobs.guards.steps.find((step) =>
      step.run?.includes('ci-auth-compatibility-workflow.test.ts'),
    );
    expect(guard).toBeDefined();
    expect(guard?.if).not.toContain('needs.changes');
    expect(guard?.['continue-on-error']).toBeUndefined();
  });
});
