/// <reference types="node" />

// Fail closed if the staged branch is not offered to a binary matching the
// exact platform fingerprint recorded beside the archived export.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  findSurfableBranch,
  probeBranchList,
  stripManifestSuffix,
  SURFABILITY_PROBE_DELAYS_MS,
  type Platform,
  type ProbeOutcome,
} from './lib/ota-branch-probe';

type Receipt = { platforms: { ios: { runtimeVersion: string }; android: { runtimeVersion: string } } };
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function parseStageVerifyArgs(
  argv: string[],
  serverUrl: string | undefined,
): { receiptPath: string; serverUrl: string } {
  if (!serverUrl) throw new Error('EXPO_UPDATES_URL is required');
  if (argv.length !== 1 || !argv[0]) throw new Error('Provide one staged receipt path');
  return { receiptPath: argv[0], serverUrl };
}

export async function verifyStagedBranches(
  receipt: Receipt,
  serverUrl: string,
  options: {
    probe?: (baseUrl: string, runtimeVersion: string, platform: Platform) => Promise<ProbeOutcome>;
    delaysMs?: readonly number[];
    sleepMs?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<void> {
  const baseUrl = stripManifestSuffix(serverUrl);
  const probe = options.probe ?? ((url, runtime, platform) => probeBranchList(fetch, url, runtime, platform));
  const delaysMs = options.delaysMs ?? SURFABILITY_PROBE_DELAYS_MS;
  const sleepMs = options.sleepMs ?? sleep;
  for (const platform of ['ios', 'android'] as const) {
    const runtimeVersion = receipt?.platforms?.[platform]?.runtimeVersion;
    if (!runtimeVersion || !/^[0-9a-f]{40}$/i.test(runtimeVersion)) {
      throw new Error(`Missing or invalid ${platform} runtimeVersion`);
    }
    let detail = 'no response';
    let found = false;
    for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
      const outcome = await probe(baseUrl, runtimeVersion, platform);
      detail = outcome.detail;
      if (findSurfableBranch(outcome, 'pr-staging')) {
        found = true;
        break;
      }
      if (attempt < delaysMs.length) await sleepMs(delaysMs[attempt]);
    }
    if (!found) throw new Error(`${platform} staged branch is not offered for ${runtimeVersion}: ${detail}`);
    console.log(`${platform} staging update is visible to compatible binaries`);
  }
}

async function main(): Promise<void> {
  const { receiptPath, serverUrl } = parseStageVerifyArgs(process.argv.slice(2), process.env.EXPO_UPDATES_URL);
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Receipt;
  await verifyStagedBranches(receipt, serverUrl);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
