/// <reference types="node" />

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { freemem, homedir, tmpdir, totalmem } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveDevServerOrigins } from './lib/dev-server-origins';
import { allocateDevServerPorts } from './lib/dev-server-port-allocation';
import {
  criticalChildProcessSpawnOptions,
  CriticalChildProcessGroup,
  type CriticalChildTermination,
} from './lib/dev-child-process-lifecycle';
import { isDevServerPortInUse } from './lib/dev-server-port-availability';
import { createExpoWebStartArgs } from './lib/expo-web-start-command';
import { prewarmExpoWeb } from './lib/expo-web-readiness';
import { resolveTailscaleHostname as resolveTailscaleHostResolution } from './lib/tailscale-hostname';

// `vp run dev` always launches its own backend so that two worktrees / two
// branches can never accidentally share one backend instance — that path
// silently lets the frontend on branch A talk to the backend built from
// branch B's code, hiding real bugs and surfacing fake ones.

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '..');

const DEFAULT_BACKEND_PORT = 8080;
const DEFAULT_WEB_PORT = 3000;
const DEFAULT_EXPO_WEB_PORT = 8082;
// 5s was not enough for a cold tsx boot on a loaded box — the backend came up
// healthy moments after the orchestrator had already given up and exited.
const HEALTH_CHECK_TIMEOUT_MS = 60_000;
const HEALTH_CHECK_INTERVAL_MS = 500;
const HEALTH_CHECK_MAX_ATTEMPTS = HEALTH_CHECK_TIMEOUT_MS / HEALTH_CHECK_INTERVAL_MS;

const TAILSCALE_CERT_TIMEOUT_MS = 60_000;

// OOM guard configuration. The dev host has crashed twice from running too many
// `vp run dev` sessions in parallel — each spawns a `next dev --turbopack`
// server that holds 3–5 GB of RSS, so a few forgotten worktrees can exhaust
// 32 GB and trip the kernel OOM-killer (see 2026-05-10 and 2026-05-12 crashes).
// These knobs let the user override the guard without editing the script.
const DEV_SESSION_LOCK_PREFIX = 'boardsesh-dev-';
const DEV_SESSION_LOCK_SUFFIX = '.lock.json';

// Per-session memory envelope. Empirically a real session peaks at ~5 GB for
// next-server + ~0.5 GB for the backend/tsx watcher + esbuild workers; 8 GB
// is a conservative cap that covers compile spikes. The 2026-05-12 crash
// happened with only 2 concurrent sessions on a 32 GB host, so we don't want
// to be aggressive here.
const DEFAULT_SESSION_BUDGET_MB = 8 * 1024;
// Reserved for OS + browser + IDE + AI agents (Claude Code, codex, etc.).
// On a dev box with lots of agents running concurrently this can easily be
// 4–8 GB; pick the middle.
const DEFAULT_RESERVED_HOST_MB = 6 * 1024;
// Pre-flight: refuse-with-override when MemAvailable is below this. Half of
// a per-session budget — if we don't have at least this much we definitely
// can't fit another session without immediate paging.
const DEFAULT_MIN_FREE_MEM_MB = DEFAULT_SESSION_BUDGET_MB / 2;

// Per-child V8 heap cap. Turbopack is mostly Rust so this only caps the
// orchestrator + tsx loaders + Node-side Next bits, but it still prevents
// runaway JS-side leaks from gobbling several GB before the kernel notices.
const CHILD_NODE_HEAP_CAP_MB = 2048;

type DevSessionLock = {
  pid: number;
  rootDir: string;
  startedAt: number;
  backendPort: number | null;
  webPort: number | null;
  expoWebPort?: number | null;
};

type ActiveDevSession = DevSessionLock & {
  lockFile: string;
};
/**
 * Certs older than this are regenerated on startup. Tailscale serves valid
 * Let's Encrypt certs (90-day lifetime) and caches them in its own state, so
 * a day-old file is a cheap roundtrip to refresh.
 */
const CERT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type TlsBundle = {
  hostname: string;
  certFile: string;
  keyFile: string;
};

type ProcessRef = {
  process: ReturnType<typeof spawn> | null;
};

type DevDbEnv = Record<string, string>;

type CliOptions = {
  qaNotesFilePath: string | null;
  killOldest: boolean;
  expoWeb: boolean;
};

type SessionTombstone = {
  killedAt: number;
  killedByPid: number;
  killedByRootDir: string;
  reason: string;
};

type DevBuildMetadata = {
  branchName: string | null;
  qaNotes: string | null;
  qaNotesFilePath: string | null;
};

const processes: { backend: ProcessRef; web: ProcessRef; expoWeb: ProcessRef } = {
  backend: { process: null },
  web: { process: null },
  expoWeb: { process: null },
};

const criticalChildProcesses = new CriticalChildProcessGroup({
  onUnexpectedTermination: handleUnexpectedChildTermination,
});

let backendHealthy = false;
let shutdownPromise: Promise<void> | null = null;

function handleUnexpectedChildTermination(termination: CriticalChildTermination): void {
  if (termination.type === 'error') {
    console.error(`[dev] ${termination.name} process error:`, termination.error);
  } else if (termination.signal) {
    console.error(`[dev] ${termination.name} terminated unexpectedly by signal ${termination.signal}`);
  } else {
    console.error(`[dev] ${termination.name} exited unexpectedly with code ${termination.code ?? 'unknown'}`);
  }

  void shutdown(1);
}

function parseCliOptions(args: string[]): CliOptions {
  let qaNotesFilePath: string | null = null;
  let killOldest = false;
  let expoWeb = false;

  for (let argumentIndex = 0; argumentIndex < args.length; argumentIndex++) {
    const argument = args[argumentIndex];
    if (argument === '--') continue;

    if (argument === '--kill-oldest') {
      killOldest = true;
      continue;
    }

    if (argument === '--expo-web') {
      expoWeb = true;
      continue;
    }

    if (argument === '--qa-notes-file' || argument === '--qa-plan-file') {
      const nextArgument = args[argumentIndex + 1];
      if (!nextArgument || nextArgument.startsWith('--')) {
        throw new Error(`${argument} requires a file path`);
      }
      qaNotesFilePath = nextArgument;
      argumentIndex++;
      continue;
    }

    for (const qaNotesPrefix of ['--qa-notes-file=', '--qa-plan-file=']) {
      if (argument.startsWith(qaNotesPrefix)) {
        const pathArgument = argument.slice(qaNotesPrefix.length).trim();
        if (!pathArgument) {
          throw new Error(`${qaNotesPrefix.slice(0, -1)} requires a file path`);
        }
        qaNotesFilePath = pathArgument;
        break;
      }
    }

    if (argument.startsWith('--qa-notes-file=') || argument.startsWith('--qa-plan-file=')) {
      continue;
    }

    console.warn(`[dev] Ignoring unrecognized argument: ${argument}`);
  }

  return { qaNotesFilePath, killOldest, expoWeb };
}

function runGitCommand(args: string[]): string | null {
  try {
    const output = execFileSync('git', args, {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return output || null;
  } catch {
    return null;
  }
}

function resolveCurrentBranchName(): string | null {
  const branchName = runGitCommand(['branch', '--show-current']);
  if (branchName) return branchName;

  const shortCommitSha = runGitCommand(['rev-parse', '--short', 'HEAD']);
  return shortCommitSha ? `detached:${shortCommitSha}` : null;
}

function readQaNotesFile(qaNotesFilePath: string | null): string | null {
  const defaultQaNotesPath = join(ROOT_DIR, '.boardsesh', 'qa-notes.md');
  const selectedQaNotesFilePath = qaNotesFilePath ?? (existsSync(defaultQaNotesPath) ? defaultQaNotesPath : null);
  if (!selectedQaNotesFilePath) return null;

  const resolvedQaNotesFilePath = resolve(ROOT_DIR, selectedQaNotesFilePath);
  try {
    return readFileSync(resolvedQaNotesFilePath, 'utf8').split(String.fromCharCode(0)).join('').trim();
  } catch (error) {
    if (!qaNotesFilePath) return null;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read --qa-notes-file at ${resolvedQaNotesFilePath}: ${message}`);
  }
}

function resolveDevBuildMetadata(cliOptions: CliOptions): DevBuildMetadata {
  const defaultQaNotesPath = join(ROOT_DIR, '.boardsesh', 'qa-notes.md');
  const selectedQaNotesFilePath =
    cliOptions.qaNotesFilePath ?? (existsSync(defaultQaNotesPath) ? defaultQaNotesPath : null);

  return {
    branchName: resolveCurrentBranchName(),
    qaNotes: readQaNotesFile(cliOptions.qaNotesFilePath),
    qaNotesFilePath: selectedQaNotesFilePath ? resolve(ROOT_DIR, selectedQaNotesFilePath) : null,
  };
}

function loadGeneratedDevDbEnv(): DevDbEnv {
  const envFile = join(ROOT_DIR, '.boardsesh', 'dev-db.env');
  if (!existsSync(envFile)) return {};

  const env: DevDbEnv = {};
  const inheritedKeys = new Set(Object.keys(process.env));
  const lines = readFileSync(envFile, 'utf8').split(/\r?\n/);

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith('#')) continue;

    const separatorIndex = trimmedLine.indexOf('=');
    if (separatorIndex <= 0) continue;

    const key = trimmedLine.slice(0, separatorIndex);
    if (!/^[A-Z0-9_]+$/.test(key)) continue;
    if (inheritedKeys.has(key)) continue;

    env[key] = trimmedLine.slice(separatorIndex + 1);
  }

  return env;
}

// Resolve the Tailscale hostname using the shared helper, narrowing to
// `string | null` since the orchestrator only cares about "do we have a
// Tailnet hostname or not?" — the structured fallback reason is only useful
// for the dev-script logging paths.
function resolveTailscaleHostname(): string | null {
  const resolution = resolveTailscaleHostResolution();
  return resolution.source === 'fallback' ? null : resolution.hostname;
}

type ProvisionResult = {
  ok: boolean;
  stderr: string;
};

function provisionTailscaleCert(hostname: string, certFile: string, keyFile: string): ProvisionResult {
  const result = spawnSync('tailscale', ['cert', `--cert-file=${certFile}`, `--key-file=${keyFile}`, hostname], {
    cwd: ROOT_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: TAILSCALE_CERT_TIMEOUT_MS,
    encoding: 'utf8',
  });
  return {
    ok: result.status === 0 && existsSync(certFile) && existsSync(keyFile),
    stderr: (result.stderr || '').toString().trim(),
  };
}

/**
 * Interactive y/n prompt. Returns `null` when stdin/stdout aren't a TTY
 * (e.g. running under CI, a detached shell, or piped output) so callers can
 * skip the prompt entirely in non-interactive contexts.
 */
async function promptYesNo(question: string, defaultYes: boolean): Promise<boolean | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    if (!answer) return defaultYes;
    return answer.startsWith('y');
  } finally {
    rl.close();
  }
}

/**
 * Try to provision a TLS cert for the Tailscale hostname via `tailscale cert`.
 * On success, returns cert+key paths usable by both Next.js and the backend.
 *
 * Requires the tailnet's "HTTPS Certificates" feature enabled + the local
 * user to be the Tailscale operator. If we detect the well-known operator
 * permission failure and we're running interactively, we offer to run the
 * one-shot fix (`sudo tailscale set --operator=$USER`) ourselves and then
 * retry. Any failure falls back to plain HTTP with a targeted hint.
 */
async function resolveTlsBundle(): Promise<TlsBundle | null> {
  const hostname = resolveTailscaleHostname();
  if (!hostname) return null;

  // Cache under $XDG_CACHE_HOME (fallback ~/.cache), not node_modules —
  // otherwise a clean install or `rm -rf node_modules` wipes the cert and
  // we spend another roundtrip with Tailscale on the next `vp run dev`.
  const cacheRoot = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  const certDir = join(cacheRoot, 'boardsesh-dev-certs');
  const certFile = join(certDir, `${hostname}.crt`);
  const keyFile = join(certDir, `${hostname}.key`);

  try {
    mkdirSync(certDir, { recursive: true });
  } catch (error) {
    console.warn('[dev] HTTPS: could not create cert cache dir — falling back to HTTP', error);
    return null;
  }

  const cached =
    existsSync(certFile) && existsSync(keyFile) && Date.now() - statSync(certFile).mtimeMs < CERT_MAX_AGE_MS;

  if (cached) {
    console.info(`[dev] HTTPS: reusing cached Tailscale cert for ${hostname}`);
    return { hostname, certFile, keyFile };
  }

  console.info(`[dev] HTTPS: requesting Tailscale cert for ${hostname} (may take a few seconds the first time)...`);
  const initial = provisionTailscaleCert(hostname, certFile, keyFile);
  if (initial.ok) {
    console.info(`[dev] HTTPS: provisioned cert for ${hostname}`);
    return { hostname, certFile, keyFile };
  }
  let stderr = initial.stderr;

  // Self-heal path: the most common first-run failure is that the Tailscale
  // daemon runs as root and the current user doesn't have operator rights on
  // it. Tailscale prints the exact fix in its own stderr — we detect that,
  // ask consent, and run it.
  const isOperatorDenied = stderr.includes('--operator=') && /operator|denied|root/i.test(stderr);
  const user = process.env.USER || process.env.LOGNAME;
  if (isOperatorDenied && user) {
    const accept = await promptYesNo(
      `[dev] HTTPS: Tailscale requires operator permission for your user. ` +
        `Run 'sudo tailscale set --operator=${user}' now? [Y/n] `,
      true,
    );
    if (accept === true) {
      console.info(`[dev] HTTPS: running 'sudo tailscale set --operator=${user}' (sudo may prompt for your password)`);
      const setResult = spawnSync('sudo', ['tailscale', 'set', `--operator=${user}`], { stdio: 'inherit' });
      if (setResult.status === 0) {
        console.info('[dev] HTTPS: operator set — retrying cert provisioning...');
        const retry = provisionTailscaleCert(hostname, certFile, keyFile);
        if (retry.ok) {
          console.info(`[dev] HTTPS: provisioned cert for ${hostname}`);
          return { hostname, certFile, keyFile };
        }
        stderr = retry.stderr || stderr;
      } else {
        console.warn('[dev] HTTPS: sudo command failed — continuing with HTTP fallback.');
      }
    } else if (accept === null) {
      console.warn('[dev] HTTPS: non-interactive shell; skipping auto-fix prompt.');
    }
    // accept === false → user declined; fall through to the hint + HTTP fallback.
  }

  console.warn(`[dev] HTTPS: 'tailscale cert' failed — falling back to HTTP. ${stderr || '(no error output)'}`);

  // Targeted hints based on what Tailscale actually said.
  if (isOperatorDenied) {
    console.warn(
      `[dev] HTTPS: fix with ONE command: 'sudo tailscale set --operator=${user ?? '$USER'}'. ` +
        `Grants your user permission to talk to the Tailscale daemon (one-time).`,
    );
  } else if (/HTTPS.*not enabled|not configured|dnsname/i.test(stderr)) {
    console.warn(
      `[dev] HTTPS: enable "HTTPS Certificates" for your tailnet at ` +
        `https://login.tailscale.com/admin/dns (one-time setup).`,
    );
  } else {
    console.warn(
      `[dev] HTTPS: check that MagicDNS + HTTPS Certificates are enabled at ` +
        `https://login.tailscale.com/admin/dns and that 'tailscale cert <host>' works from this shell.`,
    );
  }
  return null;
}

/**
 * Check if backend is already running and healthy
 */
async function checkBackendHealth(port: number, tls: TlsBundle | null): Promise<boolean> {
  // When TLS is active, fetch via the Tailscale hostname — certs are issued
  // for that name, so a localhost fetch would fail verification.
  const origin = tls ? `https://${tls.hostname}:${port}` : `http://localhost:${port}`;

  for (let attempt = 0; attempt < HEALTH_CHECK_MAX_ATTEMPTS; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1000);

      const response = await fetch(`${origin}/health`, { method: 'GET', signal: controller.signal });

      clearTimeout(timeoutId);

      if (response.ok) {
        return true;
      }
    } catch {
      // Not ready yet, try again
    }

    await delay(HEALTH_CHECK_INTERVAL_MS);
  }

  return false;
}

/**
 * Start the backend in the background
 */
function startBackend(port: number, tls: TlsBundle | null, devDbEnv: DevDbEnv): ReturnType<typeof spawn> {
  console.info(`[dev] Starting backend on port ${port}...`);

  const backendProcess = spawn('vp', ['exec', 'pnpm', '--filter', 'boardsesh-backend', 'run', 'dev'], {
    ...criticalChildProcessSpawnOptions,
    cwd: ROOT_DIR,
    stdio: ['inherit', 'inherit', 'inherit'],
    env: {
      ...devDbEnv,
      ...process.env,
      PORT: String(port),
      NODE_OPTIONS: composeNodeOptions(process.env.NODE_OPTIONS),
      ...(tls
        ? {
            DEV_HTTPS_CERT_FILE: tls.certFile,
            DEV_HTTPS_KEY_FILE: tls.keyFile,
            TAILSCALE_HOSTNAME: tls.hostname,
          }
        : {}),
    },
  });

  return backendProcess;
}

/**
 * Start the Next.js development server
 */
function startWeb(
  port: number,
  backendPort: number,
  tls: TlsBundle | null,
  devDbEnv: DevDbEnv,
  devBuildMetadata: DevBuildMetadata,
  expoWebOrigin: string | null,
): ReturnType<typeof spawn> {
  console.info(`[dev] Starting web on port ${port}...`);

  const webProcess = spawn('vp', ['exec', 'pnpm', 'run', 'dev'], {
    ...criticalChildProcessSpawnOptions,
    cwd: join(ROOT_DIR, 'packages/web'),
    stdio: ['inherit', 'inherit', 'inherit'],
    env: {
      ...devDbEnv,
      ...process.env,
      PORT: String(port),
      BACKEND_PORT: String(backendPort),
      NODE_OPTIONS: composeNodeOptions(process.env.NODE_OPTIONS),
      ...(devBuildMetadata.branchName ? { BOARDSESH_DEV_BRANCH_NAME: devBuildMetadata.branchName } : {}),
      ...(devBuildMetadata.qaNotes ? { BOARDSESH_DEV_QA_NOTES: devBuildMetadata.qaNotes } : {}),
      ...(devBuildMetadata.qaNotesFilePath ? { BOARDSESH_DEV_QA_NOTES_FILE: devBuildMetadata.qaNotesFilePath } : {}),
      ...(expoWebOrigin
        ? {
            BOARDSESH_WEB: '1',
            BOARDSESH_EXPO_WEB_ORIGIN: expoWebOrigin,
            // If cert provisioning failed, keep NextAuth and the Expo shell on
            // the localhost HTTP fallback even when Tailscale is discoverable.
            // Successful TLS setup overrides this below with the public host.
            TAILSCALE_HOSTNAME: 'localhost',
          }
        : {}),
      ...(tls
        ? {
            DEV_HTTPS_CERT_FILE: tls.certFile,
            DEV_HTTPS_KEY_FILE: tls.keyFile,
            TAILSCALE_HOSTNAME: tls.hostname,
          }
        : {}),
    },
  });

  return webProcess;
}

function startExpoWeb(
  port: number,
  webOrigin: string,
  backendOrigin: string,
  webSocketUrl: string,
  devBuildMetadata: DevBuildMetadata,
): ReturnType<typeof spawn> {
  console.info(`[dev] Starting Expo web on port ${port}...`);

  const expoWebProcess = spawn('vp', ['exec', 'pnpm', ...createExpoWebStartArgs(port)], {
    ...criticalChildProcessSpawnOptions,
    cwd: ROOT_DIR,
    stdio: ['inherit', 'inherit', 'inherit'],
    env: {
      ...process.env,
      BOARDSESH_WEB: '1',
      BROWSER: 'none',
      EXPO_NO_TELEMETRY: '1',
      // The vp task installs the isolated web runtime first. Expo's package
      // prerequisite only checks packages/mobile/package.json and cannot see
      // that nested install, so skip its misleading missing-RNW warning.
      EXPO_NO_WEB_SETUP: '1',
      EXPO_PUBLIC_WEB_URL: webOrigin,
      EXPO_PUBLIC_BACKEND_URL: backendOrigin,
      EXPO_PUBLIC_WS_URL: webSocketUrl,
      NODE_OPTIONS: composeNodeOptions(process.env.NODE_OPTIONS),
      ...(devBuildMetadata.branchName ? { BOARDSESH_DEV_BRANCH_NAME: devBuildMetadata.branchName } : {}),
      ...(devBuildMetadata.qaNotesFilePath ? { BOARDSESH_DEV_QA_NOTES_FILE: devBuildMetadata.qaNotesFilePath } : {}),
    },
  });

  return expoWebProcess;
}

/**
 * Resolve the directory we drop dev-session lockfiles into. Prefer
 * $XDG_RUNTIME_DIR on Linux — it's per-user (mode 0700) and cleared on
 * reboot, so we don't need to worry about cross-user collisions or stale-
 * after-reboot entries. On macOS there's no XDG_RUNTIME_DIR; `os.tmpdir()`
 * returns `$TMPDIR` (a per-user `/var/folders/...` path on macOS) which has
 * the same per-user-isolation property. Linux without systemd falls back to
 * `os.tmpdir()` too (typically `/tmp`).
 */
function resolveSessionLockDir(): string {
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (runtimeDir && existsSync(runtimeDir)) return runtimeDir;
  return tmpdir();
}

function getSessionLockPath(lockDir: string, pid: number): string {
  return join(lockDir, `${DEV_SESSION_LOCK_PREFIX}${pid}${DEV_SESSION_LOCK_SUFFIX}`);
}

/**
 * Tombstone path for a given dying session. The killer writes here BEFORE
 * sending SIGTERM; the killed orchestrator's shutdown handler reads it and
 * prints a banner so the agent owning that terminal knows what happened.
 */
function getSessionTombstonePath(lockDir: string, pid: number): string {
  return join(lockDir, `${DEV_SESSION_LOCK_PREFIX}${pid}.killed.json`);
}

/**
 * Read and remove our own tombstone if it exists. Called from `shutdown` so
 * the banner fires regardless of how we got the signal (SIGTERM from the
 * killer, SIGINT from the user, exit hook).
 */
function printOwnTombstoneIfPresent(lockDir: string): void {
  const tombstonePath = getSessionTombstonePath(lockDir, process.pid);
  let body: SessionTombstone;
  try {
    body = JSON.parse(readFileSync(tombstonePath, 'utf8')) as SessionTombstone;
  } catch {
    return;
  }
  try {
    unlinkSync(tombstonePath);
  } catch {
    // best-effort
  }

  const banner = '─'.repeat(72);
  const killedAtIso = body.killedAt ? new Date(body.killedAt).toISOString() : 'unknown';
  console.warn('');
  console.warn(banner);
  console.warn('[dev] ⚠ THIS DEV SESSION WAS EVICTED BY ANOTHER `vp run dev`');
  console.warn(`[dev]   Reason: ${body.reason || 'oldest-session-evicted'}`);
  console.warn(`[dev]   Killed by pid ${body.killedByPid} in: ${body.killedByRootDir}`);
  console.warn(`[dev]   At: ${killedAtIso}`);
  console.warn('[dev]');
  console.warn('[dev]   Your session was the oldest active `vp run dev` and was assumed');
  console.warn('[dev]   to be idle. The OOM guard evicts the oldest to keep the host');
  console.warn('[dev]   from running out of memory (each `next dev --turbopack` holds');
  console.warn('[dev]   3–5 GB of RAM). If you still need this worktree running,');
  console.warn('[dev]   re-run `vp run dev` here — but the other session will likely');
  console.warn('[dev]   evict yours back if both are needed concurrently.');
  console.warn(banner);
  console.warn('');
}

function getErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH = no such process; EPERM = process exists but we can't signal it
    // (still alive, just owned by another uid — treat as live).
    return getErrorCode(error) === 'EPERM';
  }
}

/**
 * Scan the lock directory for live dev-session entries. Stale lockfiles
 * (process gone, malformed JSON) are pruned in the same pass — there's no
 * point asking the user about them.
 */
function listActiveDevSessions(lockDir: string): ActiveDevSession[] {
  let entries: string[];
  try {
    entries = readdirSync(lockDir);
  } catch {
    return [];
  }

  const sessions: ActiveDevSession[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(DEV_SESSION_LOCK_PREFIX) || !entry.endsWith(DEV_SESSION_LOCK_SUFFIX)) continue;
    const lockFile = join(lockDir, entry);
    let parsed: DevSessionLock;
    try {
      parsed = JSON.parse(readFileSync(lockFile, 'utf8')) as DevSessionLock;
    } catch {
      try {
        unlinkSync(lockFile);
      } catch {
        // best-effort cleanup; ignore
      }
      continue;
    }
    if (!parsed || typeof parsed.pid !== 'number' || !isProcessAlive(parsed.pid)) {
      try {
        unlinkSync(lockFile);
      } catch {
        // best-effort cleanup; ignore
      }
      continue;
    }
    sessions.push({ ...parsed, lockFile });
  }
  return sessions;
}

function formatRelativeMinutes(timestampMs: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - timestampMs) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes === 1) return '1 min ago';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h ago` : `${hours}h ${remainder}m ago`;
}

function printActiveSessions(sessions: ActiveDevSession[]): void {
  for (const session of sessions) {
    const ports = [
      session.backendPort != null ? `backend:${session.backendPort}` : null,
      session.webPort != null ? `web:${session.webPort}` : null,
      session.expoWebPort != null ? `expo-web:${session.expoWebPort}` : null,
    ]
      .filter(Boolean)
      .join(', ');
    console.warn(
      `[dev]   pid ${session.pid}  ${session.rootDir}` +
        (ports ? `  (${ports})` : '') +
        `  — started ${formatRelativeMinutes(session.startedAt)}`,
    );
  }
}

function readMemAvailableMbLinux(): number | null {
  try {
    const meminfo = readFileSync('/proc/meminfo', 'utf8');
    const match = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
    if (!match) return null;
    return Math.floor(parseInt(match[1], 10) / 1024);
  } catch {
    return null;
  }
}

/**
 * macOS equivalent of Linux's MemAvailable: sum of pages that can be made
 * free without triggering swap or paging. `vm_stat` is part of the base
 * system; no Homebrew required. Page size is reported in vm_stat's header
 * (typically 4 KB on Intel, 16 KB on Apple Silicon).
 */
function readMemAvailableMbDarwin(): number | null {
  try {
    const vmStatOutput = execFileSync('vm_stat', [], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pageSizeMatch = vmStatOutput.match(/page size of (\d+) bytes/);
    const pageSizeBytes = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : 4096;
    const readPages = (label: string): number => {
      const labelMatch = vmStatOutput.match(new RegExp(`^${label}:\\s+(\\d+)`, 'm'));
      return labelMatch ? parseInt(labelMatch[1], 10) : 0;
    };
    // Free + inactive (clean pages reclaimable instantly) + speculative
    // (prefetched, drop-on-demand) + purgeable (apps marked them as such).
    // We deliberately exclude active and wired, which are not safe to reclaim.
    const reclaimablePages =
      readPages('Pages free') +
      readPages('Pages inactive') +
      readPages('Pages speculative') +
      readPages('Pages purgeable');
    if (reclaimablePages === 0) return null;
    return Math.floor((reclaimablePages * pageSizeBytes) / 1024 / 1024);
  } catch {
    return null;
  }
}

/**
 * Return the host's available memory in MiB, using the most accurate source
 * for the current platform. Falls back to `os.freemem()` if the platform-
 * specific path fails — that's coarser (excludes reclaimable caches) but
 * it's better than refusing to read and silently disabling the pre-flight.
 */
function readMemAvailableMb(): number | null {
  if (process.platform === 'linux') {
    const linuxValue = readMemAvailableMbLinux();
    if (linuxValue !== null) return linuxValue;
  } else if (process.platform === 'darwin') {
    const darwinValue = readMemAvailableMbDarwin();
    if (darwinValue !== null) return darwinValue;
  }
  // Cross-platform fallback. Imperfect (Linux underreports because buffers/
  // caches don't count; macOS underreports because inactive doesn't count)
  // but always non-null.
  return Math.floor(freemem() / 1024 / 1024);
}

function getTotalMemMb(): number {
  return Math.floor(totalmem() / 1024 / 1024);
}

/**
 * Auto-derive the concurrent-session cap from total RAM. Formula:
 *
 *   max(1, floor((totalMb - reservedMb) / perSessionMb))
 *
 * Examples (defaults: per-session 8 GiB, reserved 6 GiB):
 *
 *   16 GiB MBP  → max( 1, floor((16 − 6) / 8) )  = 1
 *   32 GiB host → max( 1, floor((32 − 6) / 8) )  = 3
 *   64 GiB host → max( 1, floor((64 − 6) / 8) )  = 7
 *
 * Override the numerator with BOARDSESH_DEV_SESSION_BUDGET_MB and the
 * subtrahend with BOARDSESH_DEV_RESERVED_HOST_MB. To override the result
 * directly, set BOARDSESH_MAX_DEV_SESSIONS=N — that takes precedence.
 */
function computeAutoMaxSessions(): { maxSessions: number; totalMb: number; perSessionMb: number; reservedMb: number } {
  const totalMb = getTotalMemMb();
  const perSessionMb = Math.max(
    1024,
    parseInt(process.env.BOARDSESH_DEV_SESSION_BUDGET_MB ?? String(DEFAULT_SESSION_BUDGET_MB), 10) ||
      DEFAULT_SESSION_BUDGET_MB,
  );
  const reservedMb = Math.max(
    0,
    parseInt(process.env.BOARDSESH_DEV_RESERVED_HOST_MB ?? String(DEFAULT_RESERVED_HOST_MB), 10) ||
      DEFAULT_RESERVED_HOST_MB,
  );
  const usableMb = Math.max(0, totalMb - reservedMb);
  const maxSessions = Math.max(1, Math.floor(usableMb / perSessionMb));
  return { maxSessions, totalMb, perSessionMb, reservedMb };
}

const KILL_WAIT_TIMEOUT_MS = 5000;
const KILL_WAIT_POLL_MS = 200;

/**
 * Evict the oldest active session to make room. The killed orchestrator reads
 * the tombstone we leave behind and prints a banner so its terminal explains
 * what happened — important when an AI agent owns that terminal and would
 * otherwise see only a bare "[dev] Terminated by signal SIGTERM".
 */
async function evictOldestSession(active: ActiveDevSession[], lockDir: string): Promise<void> {
  if (active.length === 0) return;
  const oldest = [...active].sort((sessionA, sessionB) => sessionA.startedAt - sessionB.startedAt)[0];

  console.warn(
    `[dev] OOM guard: evicting oldest session pid ${oldest.pid} ` +
      `(${oldest.rootDir}, started ${formatRelativeMinutes(oldest.startedAt)}) — --kill-oldest was set.`,
  );

  // Write tombstone BEFORE SIGTERM so the killed session's shutdown handler
  // can pick it up and print the explanatory banner before exiting.
  const tombstonePath = getSessionTombstonePath(lockDir, oldest.pid);
  const tombstoneBody: SessionTombstone = {
    killedAt: Date.now(),
    killedByPid: process.pid,
    killedByRootDir: ROOT_DIR,
    reason: 'oldest-session-evicted',
  };
  try {
    writeFileSync(tombstonePath, JSON.stringify(tombstoneBody), { encoding: 'utf8' });
  } catch (error) {
    console.warn('[dev] OOM guard: could not write tombstone file — continuing without banner.', error);
  }

  try {
    process.kill(oldest.pid, 'SIGTERM');
  } catch (error) {
    console.warn(`[dev] OOM guard: SIGTERM to pid ${oldest.pid} failed — assuming already gone.`, error);
  }

  // The killed orchestrator's shutdown handler waits 1s for its children
  // before SIGKILL'ing them. Give it KILL_WAIT_TIMEOUT_MS total before we
  // escalate ourselves.
  const startedAt = Date.now();
  while (Date.now() - startedAt < KILL_WAIT_TIMEOUT_MS) {
    if (!isProcessAlive(oldest.pid)) break;
    await delay(KILL_WAIT_POLL_MS);
  }

  if (isProcessAlive(oldest.pid)) {
    console.warn(`[dev] OOM guard: pid ${oldest.pid} did not exit after SIGTERM; sending SIGKILL.`);
    try {
      process.kill(oldest.pid, 'SIGKILL');
    } catch {
      // already gone
    }
    await delay(500);
  }

  // The killed orchestrator removes its own lockfile on exit, but if we had
  // to SIGKILL or the exit hook didn't run, clean up here.
  try {
    unlinkSync(oldest.lockFile);
  } catch {
    // already gone
  }
  // Same for the tombstone — normally read+removed by the killed process,
  // but if SIGKILL'd, the file would linger and confuse a future pid reuse.
  try {
    unlinkSync(tombstonePath);
  } catch {
    // already gone
  }

  console.info(`[dev] OOM guard: pid ${oldest.pid} terminated, proceeding.`);
}

/**
 * Block startup if another dev session is already running (or too many are),
 * unless the user explicitly opts in. The OOM crashes that motivated this
 * guard always followed a "I forgot another worktree was running" pattern —
 * the lockfile makes that visible BEFORE we spawn another 4 GB Next server.
 *
 * Honors:
 *  - BOARDSESH_DEV_SKIP_OOM_GUARD=1   → skip every check
 *  - BOARDSESH_MAX_DEV_SESSIONS=<n>   → allow N concurrent sessions
 *  - --kill-oldest                    → evict the oldest active session
 */
async function runOomGuard(lockDir: string, killOldest: boolean): Promise<void> {
  if (process.env.BOARDSESH_DEV_SKIP_OOM_GUARD === '1') {
    console.info('[dev] OOM guard: skipped (BOARDSESH_DEV_SKIP_OOM_GUARD=1)');
    return;
  }

  const explicitMaxRaw = process.env.BOARDSESH_MAX_DEV_SESSIONS;
  const auto = computeAutoMaxSessions();
  let maxSessions: number;
  let limitSource: string;
  if (explicitMaxRaw !== undefined && explicitMaxRaw !== '') {
    maxSessions = Math.max(1, parseInt(explicitMaxRaw, 10) || auto.maxSessions);
    limitSource = `BOARDSESH_MAX_DEV_SESSIONS=${explicitMaxRaw}`;
  } else {
    maxSessions = auto.maxSessions;
    limitSource =
      `auto from ${Math.round((auto.totalMb / 1024) * 10) / 10} GiB total RAM ` +
      `(per-session ${auto.perSessionMb} MiB, reserved ${auto.reservedMb} MiB)`;
  }

  const active = listActiveDevSessions(lockDir);
  if (active.length >= maxSessions) {
    console.warn(
      `[dev] ⚠ ${active.length} dev session${active.length === 1 ? '' : 's'} already running ` +
        `(limit ${maxSessions}; ${limitSource}):`,
    );
    printActiveSessions(active);

    if (killOldest) {
      await evictOldestSession(active, lockDir);
    } else {
      const proceed = await promptYesNo(
        `[dev] Start another anyway? Each next dev --turbopack uses 3–5 GB of RAM. [y/N] `,
        false,
      );
      if (proceed === null) {
        console.error('[dev] ✗ Refusing to start a parallel session in non-interactive shell.');
        console.error('[dev]   To proceed, choose one of:');
        console.error('[dev]     - re-run with --kill-oldest (evicts the oldest active session)');
        console.error(`[dev]     - re-run with BOARDSESH_MAX_DEV_SESSIONS=${active.length + 1}`);
        console.error('[dev]     - re-run with BOARDSESH_DEV_SKIP_OOM_GUARD=1');
        console.error('[dev]     - stop the running session(s) manually (see scripts/dev-sessions.sh)');
        process.exit(1);
      }
      if (proceed === false) {
        console.info('[dev] Exiting without starting a second dev server.');
        process.exit(0);
      }
    }
  }

  const minFreeMb = Math.max(
    0,
    parseInt(process.env.BOARDSESH_MIN_FREE_MEM_MB ?? String(DEFAULT_MIN_FREE_MEM_MB), 10) || DEFAULT_MIN_FREE_MEM_MB,
  );
  const availableMb = readMemAvailableMb();
  if (availableMb !== null && availableMb < minFreeMb) {
    console.warn(
      `[dev] ⚠ Only ${availableMb} MiB of MemAvailable; threshold is ${minFreeMb} MiB ` +
        `(override with BOARDSESH_MIN_FREE_MEM_MB=N or BOARDSESH_DEV_SKIP_OOM_GUARD=1).`,
    );
    const proceed = await promptYesNo('[dev] Start anyway? A Next dev server can easily exceed this. [y/N] ', false);
    if (proceed === null) {
      console.error('[dev] ✗ Refusing to start under low memory in non-interactive shell.');
      process.exit(1);
    }
    if (proceed === false) {
      console.info('[dev] Exiting; free some memory and try again.');
      process.exit(0);
    }
  }
}

function writeOwnSessionLock(lockDir: string, lock: DevSessionLock): string {
  const lockFile = getSessionLockPath(lockDir, lock.pid);
  try {
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(lockFile, JSON.stringify(lock), { encoding: 'utf8' });
  } catch (error) {
    console.warn('[dev] OOM guard: could not write session lockfile — continuing without one.', error);
    return '';
  }
  return lockFile;
}

function releaseOwnSessionLock(lockFile: string | null): void {
  if (!lockFile) return;
  try {
    unlinkSync(lockFile);
  } catch {
    // best-effort cleanup; ignore
  }
}

let ownSessionLockFile: string | null = null;

/**
 * Append our V8 heap cap to whatever NODE_OPTIONS the user already has, only
 * if they haven't already set --max-old-space-size themselves. Turbopack does
 * most heavy lifting in Rust, so this primarily catches JS-side leaks in tsx
 * watchers and Next.js server components — not Turbopack itself. The cgroup
 * wrapper in scripts/dev-with-cgroup.sh is the real hard cap.
 */
function composeNodeOptions(existing: string | undefined): string {
  const existingTrimmed = (existing ?? '').trim();
  if (/(^|\s)--max-old-space-size(=|\s)/.test(existingTrimmed)) {
    return existingTrimmed;
  }
  const ours = `--max-old-space-size=${CHILD_NODE_HEAP_CAP_MB}`;
  return existingTrimmed ? `${existingTrimmed} ${ours}` : ours;
}

/**
 * Cleanup handler for graceful shutdown
 */
function shutdown(exitCode = 0): Promise<void> {
  criticalChildProcesses.beginShutdown(exitCode);
  process.exitCode = criticalChildProcesses.shutdownExitCode;

  shutdownPromise ??= performShutdown();
  return shutdownPromise;
}

async function performShutdown(): Promise<void> {
  // Surface the eviction banner FIRST so it lands at the top of whatever the
  // owning agent sees. Cheap if no tombstone exists — just a missing-file
  // read that returns immediately.
  printOwnTombstoneIfPresent(resolveSessionLockDir());

  console.info('\n[dev] Shutting down...');

  if (processes.backend.process) {
    console.info('[dev] Stopping backend...');
  }

  if (processes.web.process) {
    console.info('[dev] Stopping web...');
  }

  if (processes.expoWeb.process) {
    console.info('[dev] Stopping Expo web...');
  }

  await criticalChildProcesses.terminate();

  releaseOwnSessionLock(ownSessionLockFile);
  ownSessionLockFile = null;

  process.exit(criticalChildProcesses.shutdownExitCode);
}

/**
 * Main orchestrator
 */
async function main(): Promise<void> {
  const cliOptions = parseCliOptions(process.argv.slice(2));
  const devBuildMetadata = resolveDevBuildMetadata(cliOptions);

  // Run the OOM guard BEFORE Tailscale (which is slow) so the user sees the
  // "another session is running" message immediately and can Ctrl-C without
  // waiting on cert provisioning.
  const sessionLockDir = resolveSessionLockDir();
  await runOomGuard(sessionLockDir, cliOptions.killOldest);

  // Provision one Tailscale cert bundle for Next and the backend. Expo web is
  // still an internal localhost HTTP upstream; browsers reach it through the
  // public Next /app URL, so its app/backend URLs must follow this TLS choice.
  // Null preserves the localhost HTTP fallback for non-Tailscale developers.
  const tls = await resolveTlsBundle();

  const requestedBackendPort = parseInt(process.env.BACKEND_PORT || String(DEFAULT_BACKEND_PORT), 10);
  const requestedWebPort = parseInt(process.env.PORT || String(DEFAULT_WEB_PORT), 10);
  const requestedExpoWebPort = parseInt(process.env.EXPO_WEB_PORT || String(DEFAULT_EXPO_WEB_PORT), 10);
  const devDbEnv = loadGeneratedDevDbEnv();

  // Allocate the complete port set before starting any child. A selected
  // fallback is reserved immediately, even though its server has not bound it
  // yet, so backend/web/Expo can never receive the same port.
  const { backendPort, webPort, expoWebPort } = await allocateDevServerPorts(
    {
      backend: {
        port: requestedBackendPort,
        envName: 'BACKEND_PORT',
        explicit: Boolean(process.env.BACKEND_PORT),
      },
      web: {
        port: requestedWebPort,
        envName: 'PORT',
        explicit: Boolean(process.env.PORT),
      },
      expoWeb: cliOptions.expoWeb
        ? {
            port: requestedExpoWebPort,
            envName: 'EXPO_WEB_PORT',
            explicit: Boolean(process.env.EXPO_WEB_PORT),
          }
        : null,
    },
    isDevServerPortInUse,
  );

  for (const [requestedPort, allocatedPort] of [
    [requestedBackendPort, backendPort],
    [requestedWebPort, webPort],
    ...(expoWebPort === null ? [] : [[requestedExpoWebPort, expoWebPort]]),
  ]) {
    if (requestedPort !== allocatedPort) {
      console.info(`[dev] Port ${requestedPort} unavailable, using ${allocatedPort} instead`);
    }
  }

  const origins = resolveDevServerOrigins({
    webPort,
    backendPort,
    expoWebPort,
    tlsHostname: tls?.hostname ?? null,
  });

  console.info(`[dev] Boardsesh Development Orchestrator`);
  console.info(`[dev] Backend port: ${backendPort}`);
  console.info(`[dev] Web port: ${webPort}`);
  if (expoWebPort !== null) {
    console.info(`[dev] Expo web port: ${expoWebPort}`);
    console.info(`[dev] Expo web proxy: ${origins.expoWebProxyOrigin}`);
    console.info(`[dev] Expo web app: ${origins.expoWebAppUrl}`);
  }
  if (tls) {
    console.info(`[dev] HTTPS enabled — https://${tls.hostname}:${webPort}`);
  }
  if (devDbEnv.DATABASE_URL) {
    console.info(
      `[dev] Database: ${devDbEnv.BOARDSESH_DEV_DB_HOST ?? 'configured host'} ` +
        `(${devDbEnv.BOARDSESH_DEV_DB_SOURCE ?? 'generated'})`,
    );
  }
  if (devBuildMetadata.branchName) {
    console.info(`[dev] Branch: ${devBuildMetadata.branchName}`);
  }
  if (devBuildMetadata.qaNotesFilePath) {
    console.info(`[dev] QA notes: ${devBuildMetadata.qaNotesFilePath}`);
  }
  console.info();

  ownSessionLockFile = writeOwnSessionLock(sessionLockDir, {
    pid: process.pid,
    rootDir: ROOT_DIR,
    startedAt: Date.now(),
    backendPort,
    webPort,
    expoWebPort,
  });

  // Release the lockfile on hard exits too — `shutdown` covers SIGINT/SIGTERM,
  // but a crash inside the orchestrator process would otherwise leave a stale
  // file until the next session prunes it.
  process.on('exit', () => releaseOwnSessionLock(ownSessionLockFile));

  // Install signal handlers BEFORE spawning anything — if another session
  // evicts us mid-startup via `--kill-oldest`, the shutdown handler still
  // needs to fire to read the tombstone and print the eviction banner.
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  if (criticalChildProcesses.isShuttingDown) return;
  processes.backend.process = startBackend(backendPort, tls, devDbEnv);
  if (!criticalChildProcesses.register('Backend', processes.backend.process)) return;

  console.info(`[dev] Waiting for backend to be healthy...`);
  backendHealthy = await checkBackendHealth(backendPort, tls);
  if (criticalChildProcesses.isShuttingDown) return;

  if (!backendHealthy) {
    console.error(`[dev] ✗ Backend failed to start or become healthy`);
    await shutdown(1);
    return;
  }
  console.info(`[dev] ✓ Backend is healthy`);

  if (expoWebPort !== null) {
    if (criticalChildProcesses.isShuttingDown) return;
    const expoWebProcess = startExpoWeb(
      expoWebPort,
      origins.publicWebOrigin,
      origins.publicBackendOrigin,
      origins.publicWebSocketUrl,
      devBuildMetadata,
    );
    processes.expoWeb.process = expoWebProcess;
    if (!criticalChildProcesses.register('Expo web', expoWebProcess)) return;

    if (!origins.expoWebProxyOrigin) {
      throw new Error('Expo web proxy origin is missing');
    }

    console.info('[dev] Waiting for Expo web to compile its browser bundle...');
    const prewarmResult = await prewarmExpoWeb({
      origin: origins.expoWebProxyOrigin,
      isProcessRunning: () => expoWebProcess.exitCode === null && expoWebProcess.signalCode === null,
    });
    if (criticalChildProcesses.isShuttingDown) return;

    console.info(`[dev] ✓ Expo web bundle is ready (${new URL(prewarmResult.bundleUrl).pathname})`);
  }
  if (criticalChildProcesses.isShuttingDown) return;
  processes.web.process = startWeb(webPort, backendPort, tls, devDbEnv, devBuildMetadata, origins.expoWebProxyOrigin);
  if (!criticalChildProcesses.register('Web', processes.web.process)) return;
}

main().catch((error) => {
  // A signal may terminate Expo while prewarm is awaiting its bundle. That
  // rejection belongs to the already-running graceful shutdown and must not
  // upgrade its exit status to a failure.
  if (criticalChildProcesses.isShuttingDown) return;

  console.error('[dev] Fatal error:', error);
  void shutdown(1);
});
