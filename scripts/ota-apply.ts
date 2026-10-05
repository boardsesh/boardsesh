/// <reference types="node" />

/**
 * Config-as-code for the xprem control plane at updates.boardsesh.com. Reads the
 * declared state (infra/ota/config.ts), reads the live server through the same
 * admin-session API the dashboard uses (scripts/lib/xprem-admin.mts), diffs them
 * (infra/ota/plan.ts) and reports or converges the delta. Idempotent: a second
 * run with no drift is a no-op.
 *
 * What it manages:
 *   - The `production` channel: which branch it serves, and Branch Surfing.
 *   - The long-lived branches: that they exist, and that they are protected.
 *
 * What it never does: delete anything, lift protection, touch a `pr-<number>`
 * preview branch, or remap a channel while a rollout is live. Whatever is on the
 * server and not declared is printed and left alone, and so are live rollouts.
 *
 * Modes:
 *   (default)               Plan. Print the diff and the licence state. Never writes.
 *   --apply                 Make the declared state so, then re-read and confirm.
 *   --apply --only <kinds>  Make only changes of the listed kinds (comma-separated:
 *                           create-branch, protect-branch, create-channel,
 *                           map-channel, set-branch-surfing). Everything else is
 *                           printed as "pending manual apply" and does not fail
 *                           the run. This is what an unattended run uses.
 *
 * Exit codes: 0 in sync (or, with --only, nothing left that the run may change),
 * 1 the server was read and differs, 2 the server could not be read after three
 * tries, 3 the tool itself failed (bad arguments, a refused write, a bug).
 *
 * Usage:
 *   OTA_ADMIN_EMAIL=... OTA_ADMIN_PASSWORD=... vp run ota:apply
 *   OTA_ADMIN_EMAIL=... OTA_ADMIN_PASSWORD=... vp run ota:apply -- --apply
 *
 * Env:
 *   OTA_ADMIN_EMAIL, OTA_ADMIN_PASSWORD  (required) a dashboard admin login.
 *   OTA_BASE_URL or EXPO_UPDATES_URL     (optional) defaults to the declared server.
 *
 * Runs under bare `node --experimental-strip-types` in CI, with no install: the
 * job holds the admin login. See docs/mobile-ota-updates.md, "Managing xprem as code".
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { desiredOtaState } from '../infra/ota/config.ts';
import type { OtaDesiredState } from '../infra/ota/config.ts';
import {
  OTA_CHANGE_KINDS,
  assertDeclarable,
  branchesNeedingRolloutRead,
  buildOtaPlan,
  hasDrift,
} from '../infra/ota/plan.ts';
import type { OtaChangeKind, OtaLiveState, OtaPlan, OtaPlannedChange } from '../infra/ota/plan.ts';
import { listActiveRollouts } from './lib/ota-rollout.ts';
import { XpremApiError, adminClientFromEnvironment, sameId } from './lib/xprem-admin.mts';
import type { XpremAdminClient } from './lib/xprem-admin.mts';

const LOG = '[ota-apply]';

/** Exit codes. The drift workflow tells "differs" from "could not look" by them. */
export const EXIT_IN_SYNC = 0;
/** The server was read and differs from the declaration. Nothing else exits 1. */
export const EXIT_DRIFT = 1;
export const EXIT_UNREADABLE = 2;
/** The tool itself failed: bad arguments, a refused write, an unexpected answer, a bug. */
export const EXIT_FAILED = 3;

/** The server could not be read: a failed login, a 5xx, a timeout. Not drift. */
export class ServerUnreadableError extends Error {
  constructor(cause: unknown) {
    super(`Could not read the OTA server: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'ServerUnreadableError';
  }
}

const sleep = (delayMs: number): Promise<void> => new Promise((done) => setTimeout(done, delayMs));

/**
 * Run a read up to `attempts` times. A read is safe to repeat, and one slow
 * answer from the server must not page anyone as drift.
 */
export async function withReadRetries<Result>(
  read: () => Promise<Result>,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<Result> {
  const attempts = options.attempts ?? 3;
  const delayMs = options.delayMs ?? 5_000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (attempt >= attempts) throw new ServerUnreadableError(error);
      await sleep(delayMs);
    }
  }
}

export async function readLiveState(client: XpremAdminClient, desired: OtaDesiredState): Promise<OtaLiveState> {
  const [channels, branches] = await Promise.all([client.getChannels(), client.getBranches()]);
  const live = {
    channels: channels.map((channel) => ({
      name: channel.releaseChannelName,
      branchName: channel.branchName,
      branchSurfing: channel.branchSurfing,
      rollout: channel.rollout,
    })),
    branches: branches.map((branch) => ({ name: branch.branchName, protected: branch.protected })),
  };
  const updateRollouts: OtaLiveState['updateRollouts'] = [];
  for (const branch of branchesNeedingRolloutRead(desired, live)) {
    for (const rollout of await listActiveRollouts(client, branch)) {
      updateRollouts.push({
        branch: rollout.branch,
        runtimeVersion: rollout.runtimeVersion,
        platform: rollout.platform,
        updateId: String(rollout.updateId),
        percentage: rollout.percentage,
      });
    }
  }
  return { ...live, updateRollouts };
}

/**
 * The licence line of a plan. Branch protection is an Enterprise feature in the
 * 3.2.5 dashboard, so an unlicensed server is worth saying before a protect call
 * is refused. A licence that cannot be read is reported and never fatal.
 */
export async function describeLicense(client: XpremAdminClient): Promise<{ valid: boolean | null; line: string }> {
  try {
    const license = await client.getLicense();
    if (license.valid) return { valid: true, line: `${LOG} licence: valid. Branch protection is available.` };
    const why = license.validationErrorCode ? ` (${license.validationErrorCode})` : '';
    return {
      valid: false,
      line:
        `${LOG} licence: NOT valid${why}. Branch protection is an Enterprise feature; ` +
        'the server is expected to refuse it.',
    };
  } catch (error) {
    return {
      valid: null,
      line: `${LOG} licence: could not be read (${error instanceof Error ? error.message : String(error)}).`,
    };
  }
}

/**
 * True when a refused protection call reads as a licence refusal: the server
 * answered 402 or 403 and either the licence is known to be invalid or the
 * answer says so. The exact refusal is not in the dashboard bundle, so both
 * signals are accepted.
 */
function isLicenseRefusal(error: unknown, licenseValid: boolean | null): boolean {
  if (!(error instanceof XpremApiError) || (error.status !== 402 && error.status !== 403)) return false;
  return licenseValid === false || /licen[cs]e|enterprise/i.test(error.message);
}

async function applyChange(client: XpremAdminClient, change: OtaPlannedChange): Promise<void> {
  switch (change.kind) {
    case 'create-branch':
      await client.createBranch(change.branch);
      return;
    case 'protect-branch':
      await client.setBranchProtection(change.branch, true);
      return;
    case 'create-channel':
      await client.createChannel(change.channel, change.branch);
      return;
    case 'set-branch-surfing':
      await client.setChannelBranchSurfing(change.channel, change.enabled, change.pattern);
      return;
    case 'map-channel': {
      // The mapping endpoint is addressed by ids, so read them at the moment of
      // the write: a branch this run created has an id no earlier read saw.
      const [channels, branches] = await Promise.all([client.getChannels(), client.getBranches()]);
      const channel = channels.find((candidate) => candidate.releaseChannelName === change.channel);
      const branch = branches.find((candidate) => candidate.branchName === change.branch);
      if (!channel) throw new Error(`Channel "${change.channel}" disappeared before it could be mapped.`);
      if (!branch) throw new Error(`Branch "${change.branch}" disappeared before "${change.channel}" could be mapped.`);
      if (branch.branchId === null) {
        // A "Legacy" branch: listed without an id, and the mapping endpoint has
        // nothing else to address it by.
        throw new Error(
          `Branch "${change.branch}" has no id on the server, so "${change.channel}" cannot be mapped to it.`,
        );
      }
      if (channel.branchId !== null && sameId(channel.branchId, branch.branchId)) return;
      await client.mapChannelToBranch(channel, branch.branchId);
    }
  }
}

/**
 * Apply the given changes in order. Returns the protections the server refused
 * for licence reasons; those do not stop the run, because nothing later depends
 * on a branch being protected. Any other failure stops it.
 */
export async function applyChanges(
  client: XpremAdminClient,
  changes: readonly OtaPlannedChange[],
  options: { licenseValid: boolean | null; log?: (line: string) => void },
): Promise<string[]> {
  const log = options.log ?? console.log;
  const refusedForLicense: string[] = [];
  for (const change of changes) {
    log(`${LOG} applying: ${change.summary}`);
    try {
      await applyChange(client, change);
    } catch (error) {
      if (change.kind !== 'protect-branch' || !isLicenseRefusal(error, options.licenseValid)) throw error;
      refusedForLicense.push(change.branch);
    }
  }
  return refusedForLicense;
}

/**
 * The plan as lines. With `only`, a change of any other kind is shown as waiting
 * for a manual apply, so an unattended run still says what it left alone.
 */
export function formatPlan(plan: OtaPlan, only: readonly OtaChangeKind[] | null = null): string[] {
  const lines: string[] = [];
  if (plan.changes.length === 0 && plan.blocked.length === 0) {
    lines.push(`${LOG} In sync: the server matches infra/ota/config.ts.`);
  }
  for (const change of plan.changes) {
    const label = only === null || only.includes(change.kind) ? 'drift' : 'pending manual apply';
    lines.push(`${LOG} ${label}: ${change.summary}`);
  }
  for (const blocked of plan.blocked) lines.push(`${LOG} blocked: ${blocked}`);
  for (const report of plan.reports) lines.push(`${LOG} note: ${report}`);
  return lines;
}

export interface ApplyArgs {
  apply: boolean;
  /** When set, --apply makes changes of these kinds only. */
  only: OtaChangeKind[] | null;
}

export function parseApplyArgs(argv: string[]): ApplyArgs {
  let apply = false;
  let only: OtaChangeKind[] | null = null;
  const args = argv.filter((argument) => argument !== '--');
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--apply') {
      apply = true;
    } else if (flag === '--only') {
      const list = args[++index];
      if (!list || list.startsWith('--')) throw new Error('--only needs a comma-separated list of change kinds.');
      only = list.split(',').map((entry) => {
        const kind = OTA_CHANGE_KINDS.find((candidate) => candidate === entry.trim());
        if (!kind) throw new Error(`Unknown change kind "${entry}". Expected: ${OTA_CHANGE_KINDS.join(', ')}.`);
        return kind;
      });
    } else {
      throw new Error(`Unknown argument: ${flag}. Expected --apply and, with it, --only <kinds>.`);
    }
  }
  if (only !== null && !apply) throw new Error('--only narrows --apply and means nothing without it.');
  return { apply, only };
}

/**
 * Plan, and with `apply` converge and re-plan. Returns the exit code.
 *
 * In plan mode any drift is {@link EXIT_DRIFT}. In apply mode it is what the
 * apply was allowed to change and could not. With `only`, changes of other kinds
 * and blocked changes are left for a manual apply and do not fail the run: an
 * unattended apply must not go red because it declined to move the fleet.
 */
export async function runOtaApply(
  client: XpremAdminClient,
  desired: OtaDesiredState,
  options: ApplyArgs & { log?: (line: string) => void; retryDelayMs?: number },
): Promise<number> {
  const log = options.log ?? console.log;
  const retry = { delayMs: options.retryDelayMs };
  assertDeclarable(desired);
  const plan = buildOtaPlan(desired, await withReadRetries(() => readLiveState(client, desired), retry));
  const license = await describeLicense(client);
  for (const line of formatPlan(plan, options.only)) log(line);
  log(license.line);
  if (!hasDrift(plan)) return EXIT_IN_SYNC;
  if (!options.apply) {
    log(`${LOG} ${plan.changes.length} change(s) pending. Re-run with --apply to make them.`);
    return EXIT_DRIFT;
  }

  const allowed = (change: OtaPlannedChange): boolean => options.only === null || options.only.includes(change.kind);
  const toApply = plan.changes.filter(allowed);
  const refusedForLicense = await applyChanges(client, toApply, {
    licenseValid: license.valid,
    log,
  });
  const after = buildOtaPlan(desired, await withReadRetries(() => readLiveState(client, desired), retry));
  for (const branch of refusedForLicense) {
    log(
      `${LOG} licence: the server refused to protect "${branch}". Branch protection needs a valid ` +
        'Enterprise licence on this server; nothing else failed. The branch exists and stays deletable.',
    );
  }
  if (!hasDrift(after)) {
    log(`${LOG} Applied ${toApply.length} change(s). The server now matches infra/ota/config.ts.`);
    return EXIT_IN_SYNC;
  }
  const unconverged = after.changes.filter(allowed);
  if (unconverged.length > 0 || options.only === null) {
    log(`${LOG} Drift remains after applying:`);
    for (const line of formatPlan(after, options.only)) log(line);
    return EXIT_DRIFT;
  }
  log(`${LOG} Applied what an unattended run may. Left for a manual apply:`);
  for (const line of formatPlan(after, options.only)) log(line);
  return EXIT_IN_SYNC;
}

async function main(): Promise<void> {
  const args = parseApplyArgs(process.argv.slice(2));
  // Checked here, before the retried login: a missing login is a configuration
  // error to fix, not a server that might answer on the next try.
  if (!process.env.OTA_ADMIN_EMAIL || !process.env.OTA_ADMIN_PASSWORD) {
    throw new Error('Set OTA_ADMIN_EMAIL and OTA_ADMIN_PASSWORD.');
  }
  const client = await withReadRetries(() =>
    adminClientFromEnvironment({
      appId: desiredOtaState.appId,
      defaultBaseUrl: desiredOtaState.baseUrl,
      environment: process.env,
    }),
  );
  process.exitCode = await runOtaApply(client, desiredOtaState, args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(`${LOG} ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = error instanceof ServerUnreadableError ? EXIT_UNREADABLE : EXIT_FAILED;
  });
}
