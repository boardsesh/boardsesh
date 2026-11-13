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
];

describe('auth compatibility CI has an independent complete budget', () => {
  it('owns its services and runs once for the same inputs as backend tests', () => {
    expect(compatibility.needs).toEqual(['changes']);
    expect(compatibility.if).toBe(backend.if);
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
