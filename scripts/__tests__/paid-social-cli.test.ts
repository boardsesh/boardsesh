import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { main, type MainDependencies } from '../paid-social-ads';

function dependencies(env: NodeJS.ProcessEnv = {}) {
  const printed: string[] = [];
  const fetched: string[] = [];
  const deps: MainDependencies = {
    env,
    fetch: async (url) => {
      fetched.push(url);
      return new Response('{}', { status: 500 });
    },
    now: () => new Date('2026-11-03T00:00:00Z'),
    stdout: (text) => printed.push(text),
  };
  return { deps, printed, fetched };
}
function configWithAccount(platform: 'meta' | 'reddit') {
  const directory = mkdtempSync(join(tmpdir(), 'ads-cli-'));
  const path = join(directory, 'ads.json');
  const config = JSON.parse(readFileSync(`app-stores/${platform}/ads.json`, 'utf8')) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...config, adAccountId: 'acct1' }));
  return path;
}

describe('paid-social-ads CLI', () => {
  it('prints an offline plan without credentials or network', async () => {
    const { deps, printed, fetched } = dependencies();
    expect(await main(['--platform', 'reddit', '--offline'], deps)).toBe(0);
    expect(JSON.parse(printed[0])).toMatchObject({
      platform: 'reddit',
      offline: true,
      plannedActiveDailyBudget: '0.00',
    });
    expect(fetched).toEqual([]);
  });

  it('accepts the -- separator vp run passes through', async () => {
    const { deps } = dependencies();
    expect(await main(['--', '--platform', 'meta', '--action', 'plan', '--offline'], deps)).toBe(0);
  });

  it('fails a live action when Meta credentials are missing, before any request', async () => {
    const { deps, fetched } = dependencies();
    await expect(main(['--platform', 'meta', '--config', configWithAccount('meta')], deps)).rejects.toThrow(
      'Missing META_ADS_ACCESS_TOKEN',
    );
    expect(fetched).toEqual([]);
  });

  it('fails a live action when Reddit credentials are missing, before any request', async () => {
    const { deps, fetched } = dependencies({ REDDIT_ADS_CLIENT_ID: 'id' });
    await expect(
      main(['--platform', 'reddit', '--action', 'apply', '--config', configWithAccount('reddit')], deps),
    ).rejects.toThrow('Missing REDDIT_ADS_CLIENT_SECRET, REDDIT_ADS_REFRESH_TOKEN');
    expect(fetched).toEqual([]);
  });

  it('refuses a live action on the seeded config, which has no account id yet', async () => {
    const { deps, fetched } = dependencies({ META_ADS_ACCESS_TOKEN: 'token' });
    await expect(main(['--platform', 'meta', '--action', 'audit'], deps)).rejects.toThrow(/Set adAccountId/);
    expect(fetched).toEqual([]);
  });

  it.each([
    [['--platform', 'tiktok'], /--platform/],
    [['--platform', 'meta', '--action', 'delete'], /--action/],
    [['--platform', 'meta', '--action', 'apply', '--offline'], /plan only/],
    [['--platform', 'meta', '--force'], /Unknown or duplicate/],
    [['--platform', 'reddit', '--config', 'app-stores/meta/ads.json', '--offline'], /is for meta/],
  ])('rejects %j', async (args, message) => {
    const { deps } = dependencies();
    await expect(main(args, deps)).rejects.toThrow(message);
  });
});
