/// <reference types="node" />

/**
 * Read and steer per-update rollouts on the xprem server.
 *
 *   status  [--branch production] [--runtime-version <rtv>] [--json]
 *           Live rollouts per platform. Without --runtime-version it walks EVERY
 *           runtime version of the branch, so a rollout left on an old one shows.
 *   set     --runtime-version <rtv> --percentage <1-99> [--branch] [--platform] [--expected-update-id]
 *   finish  --runtime-version <rtv> [--branch] [--platform] [--expected-update-id]
 *           Deliver the update to everyone (percentage 100) and end the rollout.
 *   revert  --runtime-version <rtv> [--branch] [--platform] [--expected-update-id] [--if-live]
 *           End the rollout by republishing the previous update as a new one.
 *           With --if-live, finding no rollout is a clean no-op, not an error.
 *   health  --runtime-version <rtv> [--branch] [--json]
 *           Health and a verdict for each platform of the live rollout.
 *   health  --update-id <updateUUID> [--control-update-id <updateUUID>] [--json]
 *           The same for named updates. Health is keyed on the update UUID a
 *           device reports, not the numeric id the rollout endpoints use.
 *
 * `--platform` is ios, android or all (default). Every write sends the update id
 * read from the server a moment earlier as `expectedUpdateId`, so a rollout that
 * was replaced in between is refused. `--expected-update-id` (the numeric id from
 * `status`) additionally refuses to act on any rollout but that one.
 *
 *   OTA_ADMIN_EMAIL=... OTA_ADMIN_PASSWORD=... \
 *     node --experimental-strip-types scripts/mobile-ota-rollout.ts status
 *
 * Verdicts use the thresholds in infra/ota/config.ts. `health` exits 0 whatever
 * the verdict: it reports, and the caller decides.
 *
 * Dependency-free: runs with no install in jobs that hold the admin login.
 * See docs/mobile-ota-updates.md, "Managing xprem as code".
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { STABLE_BRANCH, desiredOtaState, otaReleasePolicy } from '../infra/ota/config.ts';
import type { OtaHealthPolicy } from '../infra/ota/config.ts';
import {
  listActiveRollouts,
  readRollout,
  readRolloutHealth,
  readUpdateHealth,
  revertRollout,
  setRolloutPercentage,
} from './lib/ota-rollout.ts';
import type { ActiveRollout, RolloutPlatform } from './lib/ota-rollout.ts';
import { adminClientFromEnvironment } from './lib/xprem-admin.mts';
import type { XpremAdminClient } from './lib/xprem-admin.mts';

const LOG = '[ota-rollout]';
const COMMANDS = ['status', 'set', 'finish', 'revert', 'health'] as const;
type RolloutCommand = (typeof COMMANDS)[number];

const VALUE_FLAGS = [
  '--branch',
  '--runtime-version',
  '--platform',
  '--percentage',
  '--expected-update-id',
  '--update-id',
  '--control-update-id',
] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];

const UPDATE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RolloutArgs {
  command: RolloutCommand;
  branch: string;
  runtimeVersion: string | null;
  platform: RolloutPlatform;
  percentage: number | null;
  expectedUpdateId: string | null;
  updateUUID: string | null;
  controlUpdateUUID: string | null;
  json: boolean;
  ifLive: boolean;
}

export function parseRolloutArgs(argv: string[]): RolloutArgs {
  const [commandInput, ...rest] = argv.filter((argument) => argument !== '--');
  const command = COMMANDS.find((candidate) => candidate === commandInput);
  if (!command) throw new Error(`Unknown command "${commandInput ?? ''}". Expected one of: ${COMMANDS.join(', ')}.`);

  const flags = new Map<ValueFlag, string>();
  let json = false;
  let ifLive = false;
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index];
    if (argument === '--json') {
      json = true;
      continue;
    }
    if (argument === '--if-live') {
      ifLive = true;
      continue;
    }
    const flag = VALUE_FLAGS.find((candidate) => candidate === argument);
    if (!flag) throw new Error(`Unknown argument: ${argument}.`);
    const flagInput = rest[++index];
    if (!flagInput || flagInput.startsWith('--')) throw new Error(`${flag} needs a value.`);
    flags.set(flag, flagInput);
  }

  const platformInput = flags.get('--platform') ?? 'all';
  if (platformInput !== 'ios' && platformInput !== 'android' && platformInput !== 'all') {
    throw new Error('--platform must be ios, android or all.');
  }
  const runtimeVersion = flags.get('--runtime-version') ?? null;
  const updateUUID = flags.get('--update-id') ?? null;
  const controlUpdateUUID = flags.get('--control-update-id') ?? null;
  for (const [flag, uuid] of [
    ['--update-id', updateUUID],
    ['--control-update-id', controlUpdateUUID],
  ] as const) {
    if (uuid !== null && !UPDATE_UUID.test(uuid)) throw new Error(`${flag} must be an update UUID.`);
  }

  let percentage: number | null = null;
  if (command === 'set') {
    percentage = Number(flags.get('--percentage'));
    // 100 is `finish`: it ends the rollout, which deserves its own word.
    if (!Number.isInteger(percentage) || percentage < 1 || percentage > 99) {
      throw new Error('set needs --percentage as a whole number from 1 to 99. Use finish for 100.');
    }
  } else if (flags.has('--percentage')) {
    throw new Error(`--percentage only applies to set, not ${command}.`);
  }

  if (command === 'set' || command === 'finish' || command === 'revert') {
    if (!runtimeVersion) throw new Error(`${command} needs --runtime-version. Run status to find it.`);
  }
  if (ifLive && command !== 'revert') throw new Error(`--if-live only applies to revert, not ${command}.`);
  if (command === 'health') {
    if (!runtimeVersion && !updateUUID) throw new Error('health needs --runtime-version or --update-id.');
    if (controlUpdateUUID && !updateUUID) throw new Error('--control-update-id needs --update-id.');
  }

  return {
    command,
    branch: flags.get('--branch') ?? STABLE_BRANCH,
    runtimeVersion,
    platform: platformInput,
    percentage,
    expectedUpdateId: flags.get('--expected-update-id') ?? null,
    updateUUID,
    controlUpdateUUID,
    json,
    ifLive,
  };
}

function rolloutLine(rollout: ActiveRollout): string {
  return `${rollout.branch} ${rollout.platform} runtime ${rollout.runtimeVersion}: update ${rollout.updateId} at ${rollout.percentage}%`;
}

/** Run one parsed command against a client. Returns the lines to print. */
export async function runRolloutCommand(
  client: XpremAdminClient,
  args: RolloutArgs,
  policy: OtaHealthPolicy,
): Promise<string[]> {
  const target = {
    branch: args.branch,
    runtimeVersion: args.runtimeVersion ?? '',
    platform: args.platform,
    ...(args.expectedUpdateId === null ? {} : { expectedUpdateId: args.expectedUpdateId }),
  };

  if (args.command === 'status') {
    const rollouts = (
      args.runtimeVersion
        ? await readRollout(client, args.branch, args.runtimeVersion)
        : await listActiveRollouts(client, args.branch)
    ).filter((rollout) => args.platform === 'all' || rollout.platform === args.platform);
    if (args.json) return [JSON.stringify({ branch: args.branch, rollouts }, null, 2)];
    if (rollouts.length === 0) return [`${LOG} No live rollout on "${args.branch}".`];
    return rollouts.map((rollout) => `${LOG} ${rolloutLine(rollout)}`);
  }

  if (args.command === 'health') {
    if (args.updateUUID) {
      const health = await readUpdateHealth(client, args.updateUUID, args.controlUpdateUUID, policy);
      if (args.json) return [JSON.stringify(health, null, 2)];
      return [`${LOG} ${args.updateUUID}: ${health.judgement.verdict}. ${health.judgement.reason}`];
    }
    const health = await readRolloutHealth(client, args.branch, target.runtimeVersion, policy);
    if (args.json) return [JSON.stringify({ branch: args.branch, health }, null, 2)];
    if (health.length === 0) return [`${LOG} No live rollout on "${args.branch}" runtime ${target.runtimeVersion}.`];
    return health.map(
      (entry) => `${LOG} ${rolloutLine(entry.rollout)}: ${entry.judgement.verdict}. ${entry.judgement.reason}`,
    );
  }

  if (args.command === 'revert') {
    const reverted = await revertRollout(client, target, { allowNone: args.ifLive });
    if (reverted.length === 0) {
      return [`${LOG} No live rollout on "${args.branch}" runtime ${target.runtimeVersion}. Nothing to revert.`];
    }
    return reverted.map((rollout) => `${LOG} Reverted ${rolloutLine(rollout)}.`);
  }

  const percentage = args.command === 'finish' ? 100 : (args.percentage ?? 0);
  const changed = await setRolloutPercentage(client, target, percentage);
  if (changed.length === 0) return [`${LOG} Already at ${percentage}%. Nothing was changed.`];
  return changed.map((rollout) =>
    args.command === 'finish' ? `${LOG} Finished ${rolloutLine(rollout)}.` : `${LOG} Raised ${rolloutLine(rollout)}.`,
  );
}

async function main(): Promise<void> {
  const args = parseRolloutArgs(process.argv.slice(2));
  const client = await adminClientFromEnvironment({
    appId: desiredOtaState.appId,
    defaultBaseUrl: desiredOtaState.baseUrl,
    environment: process.env,
  });
  for (const line of await runRolloutCommand(client, args, otaReleasePolicy.health)) console.log(line);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(`${LOG} ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
