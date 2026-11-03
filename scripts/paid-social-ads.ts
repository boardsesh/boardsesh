/**
 * Meta (Instagram) and Reddit ads as code. See docs/paid-social-ads.md.
 *
 *   vp run ads:meta -- --action plan
 *   vp run ads:reddit -- --action plan --offline
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMetaAdsClient, metaTokenFromEnv } from './lib/meta-ads-client';
import {
  offlinePlan,
  toCents,
  reconcile,
  validateConfig,
  type PaidSocialClient,
  type PaidSocialConfig,
  type Platform,
} from './lib/paid-social';
import type { FetchLike } from './lib/paid-social-http';
import { createRedditAdsClient, redditCredentialsFromEnv } from './lib/reddit-ads-client';

export interface MainDependencies {
  env: NodeJS.ProcessEnv;
  fetch: FetchLike;
  now: () => Date;
  stdout: (text: string) => void;
}

export function clientFor(config: PaidSocialConfig, env: NodeJS.ProcessEnv, fetchImpl: FetchLike): PaidSocialClient {
  return config.platform === 'meta'
    ? createMetaAdsClient(config, metaTokenFromEnv(env), fetchImpl)
    : createRedditAdsClient(config, redditCredentialsFromEnv(env), fetchImpl);
}

/**
 * The ceiling a PR cannot raise: PAID_SOCIAL_MAX_DAILY lives on the GitHub Production environment, outside the
 * repo. The config's maxDailyBudgetTotal must sit at or under it, and an apply refuses to run without it.
 */
export function assertSpendCeiling(config: PaidSocialConfig, action: string, env: NodeJS.ProcessEnv): void {
  const ceiling = env.PAID_SOCIAL_MAX_DAILY;
  if (!ceiling) {
    if (action === 'apply') throw new Error('Missing PAID_SOCIAL_MAX_DAILY (the out-of-repo spend ceiling)');
    return;
  }
  if (toCents(config.maxDailyBudgetTotal) > toCents(ceiling, 'PAID_SOCIAL_MAX_DAILY'))
    throw new Error(
      `maxDailyBudgetTotal ${config.maxDailyBudgetTotal} is above the Production ceiling PAID_SOCIAL_MAX_DAILY ${ceiling}`,
    );
}

/** Creative paths are validated to sit under app-stores/paid-social/creatives/ before they reach here. */
async function readCreativeFile(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(resolve(path)));
}

export async function main(args: string[], dependencies: MainDependencies): Promise<number> {
  const allowed = new Set(['--platform', '--action', '--config', '--output', '--offline']);
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--') continue;
    if (!allowed.has(key) || options.has(key)) throw new Error(`Unknown or duplicate argument ${key}`);
    if (key === '--offline') options.set(key, 'true');
    else {
      const argument = args[++index];
      if (!argument || argument.startsWith('--')) throw new Error(`Missing value for ${key}`);
      options.set(key, argument);
    }
  }
  const platform = options.get('--platform');
  if (platform !== 'meta' && platform !== 'reddit') throw new Error('--platform must be meta or reddit');
  const action = options.get('--action') ?? 'plan';
  if (action !== 'audit' && action !== 'plan' && action !== 'apply')
    throw new Error('--action must be audit, plan or apply');
  const config = validateConfig(
    JSON.parse(await readFile(resolve(options.get('--config') ?? `app-stores/${platform}/ads.json`), 'utf8')),
    platform as Platform,
  );

  let report: unknown;
  let exitCode = 0;
  if (options.has('--offline')) {
    if (action !== 'plan') throw new Error('Offline mode supports plan only');
    report = await offlinePlan(config, readCreativeFile);
  } else {
    const client = clientFor(config, dependencies.env, dependencies.fetch);
    assertSpendCeiling(config, action, dependencies.env);
    const result = await reconcile(config, client, action, {
      readCreativeFile,
      now: dependencies.now,
    });
    if (result.readbackMismatches?.length) exitCode = 1;
    report = result;
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.has('--output')) await writeFile(resolve(options.get('--output')!), serialized);
  dependencies.stdout(serialized);
  if (exitCode) console.error('Read-back found differences after apply; see readbackMismatches');
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2), {
    env: process.env,
    fetch: (url, init) => fetch(url, init),
    now: () => new Date(),
    stdout: (text) => process.stdout.write(text),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : 'Paid social ads operation failed');
      process.exitCode = 1;
    },
  );
}
