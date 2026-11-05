import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { parse } from 'yaml';

interface WorkflowStep {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  if?: string;
  with?: Record<string, unknown>;
}
interface AdsWorkflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<string, { if: string; environment?: string; steps: WorkflowStep[] }>;
}

const platforms = {
  meta: { secrets: ['META_ADS_ACCESS_TOKEN'] },
  reddit: { secrets: ['REDDIT_ADS_CLIENT_ID', 'REDDIT_ADS_CLIENT_SECRET', 'REDDIT_ADS_REFRESH_TOKEN'] },
} as const;

function load(platform: keyof typeof platforms): AdsWorkflow {
  return parse(readFileSync(`.github/workflows/${platform}-ads.yml`, 'utf8')) as AdsWorkflow;
}

/** Run the credential gate's shell exactly as written, against a config with or without an account id. */
function runGate(platform: keyof typeof platforms, env: Record<string, string>, adAccountId: string | null) {
  const step = load(platform).jobs.reconcile.steps.find((entry) => entry.id === 'credentials')!;
  const directory = mkdtempSync(join(tmpdir(), 'ads-gate-'));
  const config = JSON.parse(readFileSync(`app-stores/${platform}/ads.json`, 'utf8')) as Record<string, unknown>;
  const configDirectory = join(directory, 'app-stores', platform);
  spawnSync('mkdir', ['-p', configDirectory]);
  writeFileSync(join(configDirectory, 'ads.json'), JSON.stringify({ ...config, adAccountId }));
  const output = join(directory, 'output');
  writeFileSync(output, '');
  const result = spawnSync('bash', ['-c', step.run!], {
    cwd: directory,
    env: { PATH: process.env.PATH ?? '', GITHUB_OUTPUT: output, ...env },
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, output: readFileSync(output, 'utf8') };
}

/** Run the action chooser's shell in a scratch repository whose last push changed one kind of file. */
function chooseAction(
  platform: keyof typeof platforms,
  changed: 'config' | 'creative' | 'script',
  eventName = 'push',
  dispatched = '',
) {
  const step = load(platform).jobs.reconcile.steps.find((entry) => entry.id === 'source')!;
  const directory = mkdtempSync(join(tmpdir(), 'ads-choose-'));
  const run = (command: string, args: string[]) =>
    spawnSync(command, args, {
      cwd: directory,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: directory },
    });
  run('mkdir', ['-p', `app-stores/${platform}`, 'app-stores/paid-social/creatives', 'scripts']);
  writeFileSync(join(directory, `app-stores/${platform}/ads.json`), '{}');
  writeFileSync(join(directory, 'scripts/x.ts'), '1');
  writeFileSync(join(directory, 'app-stores/paid-social/creatives/a.png'), '1');
  const vcs = (...args: string[]) => run('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args]);
  vcs('init', '-q');
  vcs('add', '-A');
  vcs('commit', '-qm', 'base');
  const before = run('git', ['rev-parse', 'HEAD']).stdout.trim();
  const target = {
    config: `app-stores/${platform}/ads.json`,
    creative: 'app-stores/paid-social/creatives/a.png',
    script: 'scripts/x.ts',
  }[changed];
  writeFileSync(join(directory, target), '2');
  vcs('commit', '-qam', 'change');
  const output = join(directory, 'output');
  writeFileSync(output, '');
  const env = { ...step.env, EVENT_NAME: eventName, DISPATCHED_ACTION: dispatched, BEFORE_SHA: before };
  const result = spawnSync('bash', ['-c', step.run!], {
    cwd: directory,
    env: { PATH: process.env.PATH ?? '', GITHUB_OUTPUT: output, ...env },
    encoding: 'utf8',
  });
  return { status: result.status, action: /action=(\w+)/.exec(readFileSync(output, 'utf8'))?.[1] };
}

describe.each(Object.keys(platforms) as (keyof typeof platforms)[])('%s ads workflow', (platform) => {
  const workflow = load(platform);
  const allSecrets: Record<string, string> = {
    ...Object.fromEntries(platforms[platform].secrets.map((name) => [name, `value-${name}`])),
    PAID_SOCIAL_MAX_DAILY: '20.00',
  };

  it('keeps PR previews offline and credential free', () => {
    const preview = workflow.jobs.preview;
    expect(preview.if).toBe("github.event_name == 'pull_request'");
    expect(preview.environment).toBeUndefined();
    const serialized = JSON.stringify(preview);
    expect(serialized).not.toContain('secrets.');
    expect(serialized).not.toContain('--action apply');
    expect(serialized).toContain('--offline');
    expect(workflow.on).not.toHaveProperty('pull_request_target');
  });

  it('only writes from main, in Production, one run at a time', () => {
    const reconcile = workflow.jobs.reconcile;
    expect(reconcile.if).toContain("github.event_name != 'pull_request'");
    expect(reconcile.if).toContain("github.ref == 'refs/heads/main'");
    expect(reconcile.environment).toBe('Production');
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
    expect(workflow.on).not.toHaveProperty('schedule');
    for (const step of reconcile.steps) {
      expect(step.uses ?? '').not.toContain('actions/cache');
      if (step.uses?.startsWith('actions/checkout')) {
        expect(step.with?.['persist-credentials']).toBe(false);
        // The newest main, so a run queued behind a later merge applies the later config instead of skipping.
        expect(step.with?.ref).toBe('main');
      }
    }
  });

  it('plans before applying and keeps secrets out of run lines and artifacts', () => {
    const steps = workflow.jobs.reconcile.steps;
    const reconcileStep = steps.find((entry) => entry.name?.startsWith('Reconcile'))!;
    expect(reconcileStep.if).toBe("steps.credentials.outputs.ready == 'true'");
    expect(reconcileStep.env?.REQUESTED_ACTION).toBe('${{ steps.source.outputs.action }}');
    expect(reconcileStep.env?.PAID_SOCIAL_MAX_DAILY).toBe('${{ vars.PAID_SOCIAL_MAX_DAILY }}');
    expect(reconcileStep.run).not.toContain('${{');
    expect(reconcileStep.run!.indexOf('--action plan')).toBeLessThan(
      reconcileStep.run!.indexOf('--action "$REQUESTED_ACTION"'),
    );
    for (const step of steps) {
      expect(step.run ?? '').not.toContain('secrets.');
      if (step.env && Object.values(step.env).some((value) => value.includes('secrets.')))
        expect(['credentials', undefined]).toContain(step.id);
    }
    const guard = steps.find((entry) => entry.id === 'source')!;
    expect(guard.run).toContain('action=plan');
    const credentialsIndex = steps.findIndex((entry) => entry.id === 'credentials');
    expect(credentialsIndex).toBeGreaterThan(steps.indexOf(guard));
    const artifact = steps.find((entry) => entry.uses?.startsWith('actions/upload-artifact'))!;
    expect(String(artifact.with?.path)).toMatch(/-plan\.json[\s\S]*-result\.json/);
  });

  it('applies a push only when the config or a creative changed', () => {
    expect(chooseAction(platform, 'config')).toEqual({ status: 0, action: 'apply' });
    expect(chooseAction(platform, 'creative')).toEqual({ status: 0, action: 'apply' });
    expect(chooseAction(platform, 'script')).toEqual({ status: 0, action: 'plan' });
    expect(chooseAction(platform, 'config', 'workflow_dispatch', 'audit')).toEqual({ status: 0, action: 'audit' });
    expect(chooseAction(platform, 'script', 'workflow_dispatch', 'apply')).toEqual({ status: 0, action: 'apply' });
    expect(chooseAction(platform, 'script', 'workflow_dispatch', 'delete').status).toBe(1);
  });

  it('skips a push with a notice when the spend ceiling variable is missing', () => {
    const { PAID_SOCIAL_MAX_DAILY: _ceiling, ...secretsOnly } = allSecrets;
    const result = runGate(platform, { EVENT_NAME: 'push', ...secretsOnly }, 'acct1');
    expect(result.stdout).toContain('PAID_SOCIAL_MAX_DAILY');
    expect(result.output).toContain('ready=false');
  });

  it('skips a push with a notice when credentials are missing', () => {
    const result = runGate(platform, { EVENT_NAME: 'push' }, 'acct1');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('::notice::Skipping');
    expect(result.output).toContain('ready=false');
  });

  it('skips a push with a notice while the config has no account id', () => {
    const result = runGate(platform, { EVENT_NAME: 'push', ...allSecrets }, null);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('adAccountId(config)');
    expect(result.output).toContain('ready=false');
  });

  it('fails a manual dispatch when credentials are missing', () => {
    const result = runGate(platform, { EVENT_NAME: 'workflow_dispatch' }, 'acct1');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('::error::Missing');
    expect(result.output).not.toContain('ready=true');
  });

  it('is ready when every credential and the account id are present', () => {
    const result = runGate(platform, { EVENT_NAME: 'push', ...allSecrets }, 'acct1');
    expect(result.status).toBe(0);
    expect(result.output).toContain('ready=true');
    for (const value of Object.values(allSecrets)) expect(result.stdout).not.toContain(value);
  });
});
