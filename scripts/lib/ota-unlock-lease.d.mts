export const MAX_UNLOCK_LEASE_MS: number;
export const UNLOCK_WRITE_HEADROOM_MS: number;
export interface UnlockCaller {
  workflowPath: string;
  headBranch: string;
  runId: number;
  runAttempt: number;
  headSha: string;
  jobKey: string;
  runnerName: string;
}
export interface UnlockCallerLease extends UnlockCaller {
  version: 1;
  repository: string;
  requestId: string;
  issuedAtMs: number;
  expiresAtMs: number;
  stepName: string;
  jobId: number;
  stepNumber: number;
  branch: string;
  runtimes: { ios: string; android: string };
}
export function unlockCallerFromEnvironment(environment: NodeJS.ProcessEnv, repository: string): UnlockCaller;
export function discoverUnlockCallerLease(
  options: {
    caller: UnlockCaller;
    repository: string;
    requestId: string;
    issuedAtMs: number;
    expiresAtMs: number;
    branch: string;
    iosRuntime: string;
    androidRuntime: string;
  },
  dependencies: { api: (path: string) => Promise<unknown>; now: () => number; sleep: (ms: number) => Promise<void> },
): Promise<UnlockCallerLease>;
export function createUnlockLeaseGuard(
  options: {
    requestId?: string;
    serializedLease?: string;
    repository?: string;
    token?: string;
    branch?: string;
    iosRuntime?: string;
    androidRuntime?: string;
  },
  dependencies?: { now?: () => number; fetchImpl?: typeof fetch },
): (target?: { branch: string; runtimeVersion: string }) => Promise<void>;
export function protectUnlockWrites<
  Client extends {
    revertUpdateRollout: (branch: string, runtime: string, expectedUpdateId: string | number) => Promise<void>;
  },
>(client: Client, guard: (target?: { branch: string; runtimeVersion: string }) => Promise<void>): Client;
