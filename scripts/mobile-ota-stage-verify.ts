/// <reference types="node" />

// Fail closed if the staged branch is not offered to a binary matching the
// exact platform fingerprint recorded beside the archived export.
import { readFileSync } from 'node:fs';
import {
  findSurfableBranch,
  probeBranchList,
  stripManifestSuffix,
  SURFABILITY_PROBE_DELAYS_MS,
} from './lib/ota-branch-probe';

type Receipt = { platforms: { ios: { runtimeVersion: string }; android: { runtimeVersion: string } } };
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function main(): Promise<void> {
  const serverUrl = process.env.EXPO_UPDATES_URL;
  if (!serverUrl) throw new Error('EXPO_UPDATES_URL is required');
  const receipt = JSON.parse(readFileSync(process.argv[2] ?? '', 'utf8')) as Receipt;
  for (const platform of ['ios', 'android'] as const) {
    const runtimeVersion = receipt.platforms[platform]?.runtimeVersion;
    if (!runtimeVersion) throw new Error(`Missing ${platform} runtimeVersion`);
    let detail = 'no response';
    let found = false;
    for (let attempt = 0; attempt <= SURFABILITY_PROBE_DELAYS_MS.length; attempt++) {
      const outcome = await probeBranchList(fetch, stripManifestSuffix(serverUrl), runtimeVersion, platform);
      detail = outcome.detail;
      if (findSurfableBranch(outcome, 'pr-staging')) {
        found = true;
        break;
      }
      if (attempt < SURFABILITY_PROBE_DELAYS_MS.length) await sleep(SURFABILITY_PROBE_DELAYS_MS[attempt]);
    }
    if (!found) throw new Error(`${platform} staged branch is not offered for ${runtimeVersion}: ${detail}`);
    console.log(`${platform} staging update is visible to compatible binaries`);
  }
}

main().catch((error: unknown) => {
  console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
