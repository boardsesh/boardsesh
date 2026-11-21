import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { notifyPublicHealth, previousProbeConclusion, probePublicHealth } from './ota-public-health';

describe('public OTA probes', () => {
  it('makes only anonymous GETs and records status and latency without reading response bodies', async () => {
    const responses = [new Response('private response body'), new Response('private response body')];
    const readers = responses.flatMap((response) => [vi.spyOn(response, 'text'), vi.spyOn(response, 'json')]);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(responses[0]).mockResolvedValueOnce(responses[1]);
    let time = 0;
    const result = await probePublicHealth({ fetchImpl, now: () => ++time });
    expect(result.healthy).toBe(true);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'https://updates.boardsesh.com/hc',
      'https://updates.boardsesh.com/ready',
    ]);
    for (const [, options] of fetchImpl.mock.calls) {
      expect(options).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal) });
      expect(options?.headers).toBeUndefined();
      expect(options?.body).toBeUndefined();
    }
    expect(result.attempts.map(({ status }) => status)).toEqual([200, 200]);
    expect(result.attempts.every(({ latencyMs }) => latencyMs >= 0)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private response body');
    for (const reader of readers) expect(reader).not.toHaveBeenCalled();
  });

  it('fails if either endpoint keeps returning an error, after three bounded attempts', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async (url) => new Response(null, { status: typeof url === 'string' && url.endsWith('/hc') ? 503 : 200 }),
      );
    const sleepImpl = vi.fn(async () => {});
    const result = await probePublicHealth({ fetchImpl, sleepImpl });
    expect(result.healthy).toBe(false);
    expect(result.attempts.filter(({ path }) => path === '/hc').map(({ status }) => status)).toEqual([503, 503, 503]);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(sleepImpl.mock.calls).toEqual([[5000], [5000]]);
  });

  it('recovers from a transient transport error without exposing its message', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('credential-bearing error'))
      .mockImplementation(async () => new Response(null));
    const result = await probePublicHealth({ fetchImpl, sleepImpl: async () => {} });
    expect(result.healthy).toBe(true);
    expect(result.attempts.map(({ status }) => status)).toEqual([0, 200, 200]);
    expect(JSON.stringify(result)).not.toContain('credential');
  });

  it('refuses redirects rather than following a login or challenge to HTTP 200', async () => {
    const result = await probePublicHealth({
      fetchImpl: async () =>
        new Response(null, { status: 302, headers: { location: 'https://example.invalid/login' } }),
      sleepImpl: async () => {},
    });
    expect(result.healthy).toBe(false);
    expect(result.attempts).toHaveLength(6);
    expect(result.attempts.every(({ status }) => status === 302)).toBe(true);
  });

  it('aborts hung requests and exhausts retries without hanging the monitor', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('timed out')), { once: true });
        }),
    );
    const result = await probePublicHealth({ fetchImpl, sleepImpl: async () => {}, timeoutMs: 5 });
    expect(result.healthy).toBe(false);
    expect(result.attempts).toHaveLength(6);
    expect(result.attempts.every(({ status }) => status === 0)).toBe(true);
  });
});

const runsResponse = () =>
  Response.json({
    workflow_runs: [
      { id: 102, head_branch: 'main', event: 'schedule' },
      { id: 101, head_branch: 'feature', event: 'workflow_dispatch' },
      { id: 100, head_branch: 'main', event: 'schedule' },
      { id: 99, head_branch: 'main', event: 'workflow_dispatch' },
      { id: 98, head_branch: 'main', event: 'push' },
    ],
  });

describe('public OTA notifications', () => {
  it('uses the prior main probe result, excluding current, future, branch and foreign-event runs', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(runsResponse())
      .mockResolvedValueOnce(
        Response.json({
          jobs: [
            { name: 'probe', conclusion: 'failure' },
            { name: 'notify', conclusion: 'success' },
          ],
        }),
      );
    expect(await previousProbeConclusion(100, 'github-token', fetchImpl)).toBe('failure');
    expect(fetchImpl.mock.calls[1][0]).toContain('/actions/runs/99/jobs');
  });

  it('does not treat a Discord failure as an OTA outage', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(runsResponse())
      .mockResolvedValueOnce(
        Response.json({
          jobs: [
            { name: 'probe', conclusion: 'success' },
            { name: 'notify', conclusion: 'failure' },
          ],
        }),
      );
    expect(
      await notifyPublicHealth({
        healthy: true,
        runId: 100,
        token: 'github-token',
        webhook: 'https://discord.invalid/webhook',
        fetchImpl,
      }),
    ).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('posts outage alerts without relying on history and disables all Discord mentions', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    expect(
      await notifyPublicHealth({
        healthy: false,
        runId: 100,
        token: 'github-token',
        webhook: 'https://discord.invalid/webhook',
        fetchImpl,
      }),
    ).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://discord.invalid/webhook');
    expect(options?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(options?.redirect).toBe('error');
    expect(typeof options?.body).toBe('string');
    const body = JSON.parse(options?.body as string);
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.content).toContain('health failed');
    expect(body.content).toContain('/actions/runs/100');
    expect(body.content).not.toContain('github-token');
  });

  it('posts recovery only after a preceding failed probe', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(runsResponse())
      .mockResolvedValueOnce(Response.json({ jobs: [{ name: 'probe', conclusion: 'timed_out' }] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(
      await notifyPublicHealth({
        healthy: true,
        runId: 100,
        token: 'github-token',
        webhook: 'https://discord.invalid/webhook',
        fetchImpl,
      }),
    ).toBe(true);
    expect(JSON.parse(fetchImpl.mock.calls[2][1]?.body as string).content).toContain('health recovered');
  });

  it('does not invent recovery when history is unavailable or contains no prior probe', async () => {
    const unavailable = vi.fn<typeof fetch>().mockResolvedValue(new Response('private error', { status: 403 }));
    await expect(
      notifyPublicHealth({
        healthy: true,
        runId: 100,
        token: 'github-token',
        webhook: 'https://discord.invalid/webhook',
        fetchImpl: unavailable,
      }),
    ).rejects.toThrow('previous public-health results');
    expect(unavailable).toHaveBeenCalledTimes(1);
    expect(
      await previousProbeConclusion(100, 'github-token', async () => Response.json({ workflow_runs: [] })),
    ).toBeNull();
  });

  it('fails delivery without exposing webhook response content', async () => {
    await expect(
      notifyPublicHealth({ healthy: false, runId: 100, token: '', webhook: '', fetchImpl: vi.fn() }),
    ).rejects.toThrow('DISCORD_DEPLOY_WEBHOOK');
    await expect(
      notifyPublicHealth({
        healthy: false,
        runId: 100,
        token: '',
        webhook: 'https://discord.invalid/webhook',
        fetchImpl: async () => new Response('private webhook body', { status: 500 }),
      }),
    ).rejects.toThrow('Discord delivery failed');
  });
});

describe('public OTA workflow boundary', () => {
  const source = readFileSync(new URL('../.github/workflows/ota-public-health.yml', import.meta.url), 'utf8');
  const workflow = parse(source);

  it('performs no network requests while Railway owns hosting or the run is outside main', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ota-public-health-')));
    try {
      mkdirSync(join(root, 'scripts'));
      mkdirSync(join(root, 'infra/ota'), { recursive: true });
      writeFileSync(
        join(root, 'scripts/ota-public-health.ts'),
        readFileSync(new URL('./ota-public-health.ts', import.meta.url)),
      );
      writeFileSync(join(root, 'infra/ota/hosting.json'), JSON.stringify({ provider: 'railway' }));
      const guard = join(root, 'no-network.mjs');
      writeFileSync(
        guard,
        'globalThis.fetch = async () => { console.error("UNEXPECTED_NETWORK"); throw new Error("blocked"); };',
      );
      for (const ref of ['refs/heads/main', 'refs/heads/feature']) {
        const result = spawnSync(
          process.execPath,
          ['--import', guard, '--experimental-strip-types', join(root, 'scripts/ota-public-health.ts'), 'probe'],
          {
            env: {
              PATH: process.env.PATH,
              GITHUB_REF: ref,
              GITHUB_REPOSITORY: 'boardsesh/boardsesh',
              GITHUB_OUTPUT: join(root, 'output'),
            },
            encoding: 'utf8',
            timeout: 1500,
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(ref === 'refs/heads/main' ? 0 : 1);
        expect(`${result.stdout}${result.stderr}`).not.toContain('UNEXPECTED_NETWORK');
      }
      expect(readFileSync(join(root, 'output'), 'utf8')).toBe('enabled=false\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs every fifteen minutes and manually, on a hosted runner with its own bounded lane', () => {
    expect(workflow.on).toEqual({ schedule: [{ cron: '7,22,37,52 * * * *' }], workflow_dispatch: null });
    expect(workflow.concurrency).toEqual({ group: 'ota-public-health', 'cancel-in-progress': false });
    expect(workflow.jobs.probe['runs-on']).toBe('ubuntu-latest');
    expect(workflow.jobs.probe['timeout-minutes']).toBe(5);
    expect(workflow.jobs.probe.if).toBe("github.ref == 'refs/heads/main'");
    expect(workflow.jobs.probe.environment).toBeUndefined();
    expect(workflow.permissions).toEqual({ contents: 'read' });
  });

  it('uses current main ownership, pins actions, and keeps credentials out of the probe', () => {
    for (const job of Object.values(workflow.jobs) as {
      steps: { uses?: string; with?: Record<string, unknown> }[];
    }[]) {
      for (const step of job.steps) if (step.uses) expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
      expect(job.steps[0].with).toEqual({ ref: 'main', 'persist-credentials': false });
    }
    expect(JSON.stringify(workflow.jobs.probe)).not.toContain('secrets.');
    expect(workflow.jobs.notify.if).toContain("needs.probe.outputs.enabled == 'true'");
    expect(workflow.jobs.notify.environment).toBe('ota-stable-release');
    expect(workflow.jobs.notify.permissions).toEqual({ contents: 'read', actions: 'read' });
    expect(source).not.toMatch(/OTA_ADMIN|EOO_TOKEN|HOMELAB_DISPATCH_TOKEN|setup-vp|self-hosted/);
  });
});
