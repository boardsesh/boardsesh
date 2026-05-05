/// <reference types="node" />

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// `vp run dev` always launches its own backend so that two worktrees / two
// branches can never accidentally share one backend instance — that path
// silently lets the frontend on branch A talk to the backend built from
// branch B's code, hiding real bugs and surfacing fake ones.

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '..');

const DEFAULT_BACKEND_PORT = 8080;
const DEFAULT_WEB_PORT = 3000;
const HEALTH_CHECK_TIMEOUT_MS = 5000;
const HEALTH_CHECK_INTERVAL_MS = 500;
const HEALTH_CHECK_MAX_ATTEMPTS = HEALTH_CHECK_TIMEOUT_MS / HEALTH_CHECK_INTERVAL_MS;

const TAILSCALE_STATUS_TIMEOUT_MS = 1500;
const TAILSCALE_CERT_TIMEOUT_MS = 60_000;
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
};

type DevBuildMetadata = {
  branchName: string | null;
  qaNotes: string | null;
  qaNotesFilePath: string | null;
};

const processes: { backend: ProcessRef; web: ProcessRef } = {
  backend: { process: null },
  web: { process: null },
};

let backendHealthy = false;

// When we run a non-default distDir, Next.js writes the new path into
// packages/web/tsconfig.json's `include` array on first compile. That file
// is checked in, so the side effect would dirty the working tree on every
// parallel-dev start. Snapshot the original bytes here and restore on
// shutdown so the pollution stays scoped to the running process.
type TsconfigSnapshot = { path: string; content: string };
let tsconfigSnapshot: TsconfigSnapshot | null = null;

function snapshotTsconfig(): void {
  const path = join(ROOT_DIR, 'packages/web/tsconfig.json');
  try {
    tsconfigSnapshot = { path, content: readFileSync(path, 'utf8') };
  } catch (error) {
    console.warn(
      '[dev] Could not snapshot packages/web/tsconfig.json — Next.js may leave per-port paths behind:',
      error,
    );
  }
}

function restoreTsconfig(): void {
  if (!tsconfigSnapshot) return;
  const { path, content } = tsconfigSnapshot;
  try {
    const current = readFileSync(path, 'utf8');
    if (current !== content) {
      writeFileSync(path, content);
      console.info('[dev] Reverted packages/web/tsconfig.json (Next.js had auto-added per-port type paths)');
    }
  } catch (error) {
    console.warn('[dev] Could not restore packages/web/tsconfig.json:', error);
  }
}

function parseCliOptions(args: string[]): CliOptions {
  let qaNotesFilePath: string | null = null;

  for (let argumentIndex = 0; argumentIndex < args.length; argumentIndex++) {
    const argument = args[argumentIndex];
    if (argument === '--') continue;

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

  return { qaNotesFilePath };
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

/**
 * Resolve the Tailscale hostname from `tailscale status --json`. Returns null
 * if Tailscale isn't installed, not logged in, or not reporting a DNS name.
 */
function resolveTailscaleHostname(): string | null {
  try {
    const statusJson = execFileSync('tailscale', ['status', '--json'], {
      encoding: 'utf8',
      timeout: TAILSCALE_STATUS_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(statusJson) as { Self?: { DNSName?: string } };
    const dns = parsed.Self?.DNSName?.trim().replace(/\.$/, '');
    return dns && /^[a-zA-Z0-9.-]+$/.test(dns) ? dns.toLowerCase() : null;
  } catch {
    return null;
  }
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

type PortBindResult = 'available' | 'in-use' | 'unsupported';

function getErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

async function checkWildcardPortBind(port: number): Promise<PortBindResult> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', (error) => {
      resolve(getErrorCode(error) === 'EADDRINUSE' ? 'in-use' : 'unsupported');
    });
    server.once('listening', () => {
      server.close(() => {
        resolve('available');
      });
    });
    server.listen({ port, host: '0.0.0.0', exclusive: true });
  });
}

async function isLocalhostPortInUse(port: number, timeout = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: 'localhost' }, () => {
      socket.destroy();
      resolve(true);
    });

    socket.setTimeout(timeout);
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });

    socket.on('error', () => {
      resolve(false);
    });
  });
}

/**
 * Check if a port is in use by first attempting the same wildcard bind the dev
 * servers use. If that probe is unsupported in a restricted environment, fall
 * back to the older localhost connection probe.
 */
async function isPortInUse(port: number): Promise<boolean> {
  const bindResult = await checkWildcardPortBind(port);
  if (bindResult !== 'unsupported') {
    return bindResult === 'in-use';
  }

  return isLocalhostPortInUse(port);
}

/**
 * Find an available port by incrementing from the base port
 */
async function findAvailablePort(basePort: number, maxAttempts = 10): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = basePort + i;
    const inUse = await isPortInUse(port);
    if (!inUse) {
      if (i > 0) {
        console.info(`[dev] Port ${basePort} in use, using ${port} instead`);
      }
      return port;
    }
  }

  console.error(`[dev] Could not find available port starting from ${basePort}`);
  process.exit(1);
}

/**
 * Start the backend in the background
 */
function startBackend(port: number, tls: TlsBundle | null, devDbEnv: DevDbEnv): ReturnType<typeof spawn> {
  console.info(`[dev] Starting backend on port ${port}...`);

  const backendProcess = spawn('bun', ['run', '--filter=boardsesh-backend', 'dev'], {
    cwd: ROOT_DIR,
    stdio: ['inherit', 'inherit', 'inherit'],
    env: {
      ...devDbEnv,
      ...process.env,
      PORT: String(port),
      ...(tls ? { DEV_HTTPS_CERT_FILE: tls.certFile, DEV_HTTPS_KEY_FILE: tls.keyFile } : {}),
    },
  });

  backendProcess.on('error', (error) => {
    console.error(`[dev] Backend failed to start:`, error);
    process.exit(1);
  });

  backendProcess.on('exit', (code, signal) => {
    if (signal) {
      console.info(`[dev] Backend terminated by signal ${signal}`);
    } else if (code !== 0) {
      console.error(`[dev] Backend exited with code ${code}`);
    }
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
): ReturnType<typeof spawn> {
  console.info(`[dev] Starting web on port ${port}...`);

  // Each parallel dev instance needs its own distDir; otherwise `next dev`
  // refuses to start with "Unable to acquire lock at .next/dev/lock". The
  // canonical `.next` is reserved for the default-port instance so existing
  // tooling (vercel deploys, debuggers attached to .next/...) keeps working;
  // any auto-incremented or explicit non-default port gets `.next-<port>`.
  const distDir = port === DEFAULT_WEB_PORT ? undefined : `.next-${port}`;
  if (distDir) {
    console.info(`[dev] Using distDir ${distDir} (per-port to avoid next-dev lock collision)`);
  }

  const webProcess = spawn('bun', ['run', 'dev'], {
    cwd: join(ROOT_DIR, 'packages/web'),
    stdio: ['inherit', 'inherit', 'inherit'],
    env: {
      ...devDbEnv,
      ...process.env,
      PORT: String(port),
      BACKEND_PORT: String(backendPort),
      ...(devBuildMetadata.branchName ? { BOARDSESH_DEV_BRANCH_NAME: devBuildMetadata.branchName } : {}),
      ...(devBuildMetadata.qaNotes ? { BOARDSESH_DEV_QA_NOTES: devBuildMetadata.qaNotes } : {}),
      ...(devBuildMetadata.qaNotesFilePath ? { BOARDSESH_DEV_QA_NOTES_FILE: devBuildMetadata.qaNotesFilePath } : {}),
      ...(distDir ? { NEXT_DIST_DIR: distDir } : {}),
      ...(tls
        ? {
            DEV_HTTPS_CERT_FILE: tls.certFile,
            DEV_HTTPS_KEY_FILE: tls.keyFile,
            TAILSCALE_HOSTNAME: tls.hostname,
          }
        : {}),
    },
  });

  webProcess.on('error', (error) => {
    console.error(`[dev] Web failed to start:`, error);
    process.exit(1);
  });

  webProcess.on('exit', (code, signal) => {
    if (signal) {
      console.info(`[dev] Web terminated by signal ${signal}`);
    } else if (code !== 0) {
      console.error(`[dev] Web exited with code ${code}`);
    }
  });

  return webProcess;
}

/**
 * Cleanup handler for graceful shutdown
 */
async function shutdown() {
  console.info('\n[dev] Shutting down...');

  if (processes.backend.process) {
    console.info('[dev] Stopping backend...');
    processes.backend.process.kill('SIGTERM');
  }

  if (processes.web.process) {
    console.info('[dev] Stopping web...');
    processes.web.process.kill('SIGTERM');
  }

  // Give processes time to shut down gracefully
  await delay(1000);

  // Force kill if still running
  if (processes.backend.process && !processes.backend.process.killed) {
    processes.backend.process.kill('SIGKILL');
  }

  if (processes.web.process && !processes.web.process.killed) {
    processes.web.process.kill('SIGKILL');
  }

  // Best-effort revert of any tsconfig.json edits Next.js made for our
  // per-port distDir. Skipped if the orchestrator is SIGKILL'd; users can
  // recover with `git checkout -- packages/web/tsconfig.json`.
  restoreTsconfig();

  process.exit(0);
}

/**
 * Main orchestrator
 */
async function main(): Promise<void> {
  const cliOptions = parseCliOptions(process.argv.slice(2));
  const devBuildMetadata = resolveDevBuildMetadata(cliOptions);

  // Try to provision a Tailscale HTTPS cert so real phones (which require a
  // secure context for DeviceMotion, Web Bluetooth, clipboard, etc.) can
  // actually use those APIs against the dev server. Null → HTTP fallback.
  const tls = await resolveTlsBundle();

  const requestedBackendPort = parseInt(process.env.BACKEND_PORT || String(DEFAULT_BACKEND_PORT), 10);
  const requestedWebPort = parseInt(process.env.PORT || String(DEFAULT_WEB_PORT), 10);
  const devDbEnv = loadGeneratedDevDbEnv();

  // Backend port: explicit BACKEND_PORT must be respected (and must be free —
  // we won't shoot a process the user explicitly aimed us at). Otherwise we
  // auto-increment from the default so two worktrees can run side-by-side.
  let backendPort: number;
  if (process.env.BACKEND_PORT) {
    backendPort = requestedBackendPort;
    if (await isPortInUse(backendPort)) {
      console.warn(`[dev] ⚠ Port ${backendPort} (BACKEND_PORT) is in use`);
      console.warn(`[dev] ⚠ Try 'lsof -i :${backendPort}' to find the holder, or unset BACKEND_PORT to auto-pick`);
      process.exit(1);
    }
  } else {
    backendPort = await findAvailablePort(requestedBackendPort);
  }

  // Web port follows the same rule.
  const webPort = process.env.PORT ? requestedWebPort : await findAvailablePort(requestedWebPort);

  console.info(`[dev] Boardsesh Development Orchestrator`);
  console.info(`[dev] Backend port: ${backendPort}`);
  console.info(`[dev] Web port: ${webPort}`);
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

  // Only snapshot tsconfig if we're going to use a per-port distDir; the
  // canonical-port instance lets Next manage `.next/types` in tsconfig as
  // it always has.
  if (webPort !== DEFAULT_WEB_PORT) {
    snapshotTsconfig();
  }

  processes.backend.process = startBackend(backendPort, tls, devDbEnv);

  console.info(`[dev] Waiting for backend to be healthy...`);
  backendHealthy = await checkBackendHealth(backendPort, tls);
  if (!backendHealthy) {
    console.error(`[dev] ✗ Backend failed to start or become healthy`);
    process.exit(1);
  }
  console.info(`[dev] ✓ Backend is healthy`);

  processes.web.process = startWeb(webPort, backendPort, tls, devDbEnv, devBuildMetadata);

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('[dev] Fatal error:', error);
  process.exit(1);
});
