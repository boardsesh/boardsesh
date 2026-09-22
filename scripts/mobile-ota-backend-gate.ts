/// <reference types="node" />

// Decides whether a production OTA may publish yet, given what the live backend
// reports. Used by the `await-backend-schema` job in mobile-ota-production.yml.
//
// Why this exists (#5370): on 2026-09-08, #5283 changed the GraphQL schema and
// the mobile client in one commit. The OTA published at 21:36 UTC; the backend
// carrying the new argument finished deploying at 21:55. For those 19 minutes
// updated phones sent a query the live backend rejected with
// GRAPHQL_VALIDATION_FAILED.
//
// The gate FAILS OPEN. It only ever delays a publish; it never blocks one. A
// held OTA is worse than a 19-minute validation window when the backend deploy
// is wedged, and per-platform republishes dispatched by the native build
// workflows must never be stranded behind it.
//
// The decision is a pure function rather than inline shell for the same reason
// as scripts/mobile-fingerprint-match.ts: an inverted test in YAML is invisible
// to a workflow-text assertion. Invoked from YAML with
// `node --experimental-strip-types`.

/** Hard cap on how long the gate holds a publish, in seconds. */
export const MAX_WAIT_SECONDS = 60 * 60;

/**
 * How long "no production deploy is running" is not yet trusted, in seconds.
 * The deploy run and this OTA run are created by the same push, but GitHub
 * registers workflow runs asynchronously, so the first poll can land before
 * the deploy run is listed. Without this, a slow registration would read as
 * "nothing is deploying" and publish straight into the window the gate exists
 * to close.
 */
export const DEPLOY_REGISTRATION_GRACE_SECONDS = 3 * 60;

const FULL_SHA = /^[0-9a-f]{40}$/;

export interface BackendGateInput {
  /** Last commit at or before the OTA's commit that touched the schema source. Empty when none. */
  needSha: string;
  /** `release` from the backend's /health, or '' when unreadable. */
  release: string;
  /** `git merge-base --is-ancestor needSha release` succeeded. */
  isAncestor: boolean;
  /** `git diff --quiet release OTA_SHA -- <schema source>` succeeded. */
  schemaDiffEmpty: boolean;
  /** A production-deploy.yml run on main is queued, in progress or waiting. */
  deployRunning: boolean;
  /** Seconds since the gate started polling. */
  elapsedSeconds: number;
}

export type BackendGateDecision =
  | { decision: 'pass'; reason: string }
  | { decision: 'wait'; reason: string }
  | { decision: 'timeout-publish'; reason: string };

export function isFullSha(value: string): boolean {
  return FULL_SHA.test(value);
}

export function decideBackendGate(input: BackendGateInput): BackendGateDecision {
  const { needSha, release, isAncestor, schemaDiffEmpty, deployRunning, elapsedSeconds } = input;

  if (needSha === '') {
    return { decision: 'pass', reason: 'no commit in history touches the schema source' };
  }

  // A non-SHA release (`development` from an unstamped build, or an unreadable
  // /health) proves nothing, so neither git comparison is allowed to pass it.
  if (isFullSha(release)) {
    if (isAncestor) {
      return { decision: 'pass', reason: `backend release ${release} contains schema commit ${needSha}` };
    }
    // Covers a deploy hold or a rollback: the backend is behind, but on a
    // commit whose schema is identical to the one this OTA was built against.
    if (schemaDiffEmpty) {
      return {
        decision: 'pass',
        reason: `backend release ${release} has the same schema as this OTA's commit`,
      };
    }
  }

  const releaseLabel = release === '' ? 'unreadable' : release;

  if (elapsedSeconds >= MAX_WAIT_SECONDS) {
    return {
      decision: 'timeout-publish',
      reason: `waited ${Math.floor(elapsedSeconds / 60)} min and the backend (release ${releaseLabel}) still lacks schema commit ${needSha}`,
    };
  }

  if (deployRunning) {
    return {
      decision: 'wait',
      reason: `backend release ${releaseLabel} lacks schema commit ${needSha}; a production deploy is running`,
    };
  }

  if (elapsedSeconds < DEPLOY_REGISTRATION_GRACE_SECONDS) {
    return {
      decision: 'wait',
      reason: `backend release ${releaseLabel} lacks schema commit ${needSha}; no production deploy listed yet, allowing time for it to register`,
    };
  }

  return {
    decision: 'timeout-publish',
    reason: `backend release ${releaseLabel} lacks schema commit ${needSha} and no production deploy is running`,
  };
}

function readFlag(argv: string[], flag: string): string {
  const index = argv.indexOf(flag);
  return index >= 0 ? (argv[index + 1] ?? '') : '';
}

function main(): void {
  const argv = process.argv.slice(2).filter((arg) => arg !== '--');
  const elapsedSeconds = Number(readFlag(argv, '--elapsed-seconds'));
  const verdict = decideBackendGate({
    needSha: readFlag(argv, '--need'),
    release: readFlag(argv, '--release'),
    isAncestor: readFlag(argv, '--is-ancestor') === 'true',
    schemaDiffEmpty: readFlag(argv, '--schema-diff-empty') === 'true',
    deployRunning: readFlag(argv, '--deploy-running') === 'true',
    // A garbled elapsed value must not hold the publish forever.
    elapsedSeconds: Number.isFinite(elapsedSeconds) ? elapsedSeconds : MAX_WAIT_SECONDS,
  });
  // Two lines for `>> "$GITHUB_OUTPUT"` or `eval`-free parsing in the shell.
  // Always exit 0: the workflow decides what each verdict means.
  process.stdout.write(`decision=${verdict.decision}\nreason=${verdict.reason}\n`);
}

// Only run the CLI when executed directly, so the pure exports stay importable
// from tests without side effects.
if (process.argv[1]?.endsWith('mobile-ota-backend-gate.ts')) main();
