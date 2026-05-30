/// <reference types="node" />

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, createWriteStream } from 'node:fs';
import { createServer } from 'node:net';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveTailscaleHostname } from './lib/tailscale-hostname';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const METRO_DEFAULT_PORT = 8081;
const METRO_MAX_PORT = 8099;
const BOARDSESH_DIR = join(ROOT_DIR, '.boardsesh');

function resolveExplicitMetroPort(args: string[]): number | null {
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--port' || argument === '-p') {
      const next = args[index + 1];
      if (next && !next.startsWith('-')) {
        const port = Number(next);
        return Number.isInteger(port) && port > 0 ? port : null;
      }
    } else if (argument.startsWith('--port=')) {
      const port = Number(argument.slice('--port='.length));
      return Number.isInteger(port) && port > 0 ? port : null;
    }
  }
  return null;
}

function withMetroPort(args: string[], port: number): string[] {
  if (resolveExplicitMetroPort(args) !== null) return args;
  return [...args, '--port', String(port)];
}

async function isPortAvailable(port: number): Promise<boolean> {
  return await new Promise((resolveAvailable) => {
    const server = createServer();
    server.once('error', () => resolveAvailable(false));
    server.once('listening', () => {
      server.close(() => resolveAvailable(true));
    });
    server.listen(port);
  });
}

async function resolveMetroPort(args: string[]): Promise<number> {
  const explicitPort = resolveExplicitMetroPort(args);
  if (explicitPort !== null) return explicitPort;

  for (let port = METRO_DEFAULT_PORT; port <= METRO_MAX_PORT; port++) {
    if (await isPortAvailable(port)) return port;
  }

  throw new Error(`No free Metro port found in ${METRO_DEFAULT_PORT}-${METRO_MAX_PORT}`);
}
const METRO_LOG_PATH = join(BOARDSESH_DIR, 'mobile-metro.log');
const DEFAULT_QA_NOTES_PATH = join(BOARDSESH_DIR, 'qa-notes.md');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(args: string[]): { qaNotesFilePath: string | null; simulator: boolean; passthroughArgs: string[] } {
  let qaNotesFilePath: string | null = null;
  let simulator = process.env.BOARDSESH_DEV_SIMULATOR === '1';
  const passthroughArgs: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--') continue;

    if (argument === '--simulator') {
      simulator = true;
      continue;
    }

    if (argument === '--qa-notes-file' || argument === '--qa-plan-file') {
      const nextArgument = args[index + 1];
      if (!nextArgument || nextArgument.startsWith('--')) {
        throw new Error(`${argument} requires a file path`);
      }
      qaNotesFilePath = nextArgument;
      index++;
      continue;
    }

    for (const prefix of ['--qa-notes-file=', '--qa-plan-file=']) {
      if (argument.startsWith(prefix)) {
        const pathValue = argument.slice(prefix.length).trim();
        if (!pathValue) {
          throw new Error(`${prefix.slice(0, -1)} requires a file path`);
        }
        qaNotesFilePath = pathValue;
        break;
      }
    }

    if (argument.startsWith('--qa-notes-file=') || argument.startsWith('--qa-plan-file=')) {
      continue;
    }

    passthroughArgs.push(argument);
  }

  return { qaNotesFilePath, simulator, passthroughArgs };
}

// ---------------------------------------------------------------------------
// Resolve dev metadata (branch name, QA notes)
// ---------------------------------------------------------------------------

function resolveCurrentBranchName(): string | null {
  return runGitCommand(['branch', '--show-current']);
}

function runGitCommand(args: string[]): string | null {
  try {
    const output = execFileSync('git', args, {
      cwd: ROOT_DIR,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return output || null;
  } catch {
    return null;
  }
}

function resolveQaNotes(explicitPath: string | null): { contents: string | null; filePath: string | null } {
  const resolvedPath = explicitPath
    ? resolve(ROOT_DIR, explicitPath)
    : existsSync(DEFAULT_QA_NOTES_PATH)
      ? DEFAULT_QA_NOTES_PATH
      : null;

  if (!resolvedPath) return { contents: null, filePath: null };

  try {
    const contents = readFileSync(resolvedPath, 'utf-8').trim();
    return { contents: contents || null, filePath: resolvedPath };
  } catch (error) {
    if (explicitPath) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not read --qa-notes-file at ${resolvedPath}: ${message}`);
    }
    return { contents: null, filePath: null };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { qaNotesFilePath: cliQaNotesPath, simulator, passthroughArgs } = parseArgs(process.argv.slice(2));
  const branchName = resolveCurrentBranchName();
  const commitSha = runGitCommand(['rev-parse', '--short', 'HEAD']);
  const qaNotes = resolveQaNotes(cliQaNotesPath);
  // Simulator mode skips the tailnet probe entirely. The iOS Simulator's
  // CFNetwork sandbox can't reach the host's Tailscale MagicDNS hostname
  // reliably, so pinning REACT_NATIVE_PACKAGER_HOSTNAME to the tailnet name
  // makes the initial bundle load fail with "could not connect".
  const tailscale = simulator ? null : resolveTailscaleHostname();
  const metroPort = await resolveMetroPort(passthroughArgs);
  const metroPassthroughArgs = withMetroPort(passthroughArgs, metroPort);
  const startedAt = new Date().toISOString();
  const worktreeLabel = basename(ROOT_DIR);

  console.log(`[dev:mobile] Branch: ${branchName ?? '(detached)'}`);
  if (commitSha) {
    console.log(`[dev:mobile] Commit: ${commitSha}`);
  }
  if (qaNotes.filePath) {
    console.log(`[dev:mobile] QA notes: ${qaNotes.filePath}`);
  }
  console.log(`[dev:mobile] Worktree: ${worktreeLabel}`);
  if (simulator) {
    console.log(`[dev:mobile] Simulator mode: serving bundles at http://localhost:${metroPort}`);
  } else if (tailscale) {
    console.log(`[dev:mobile] Hostname: ${tailscale.hostname} (${tailscale.source})`);
    if (tailscale.reason) {
      console.log(`[dev:mobile] ${tailscale.reason}`);
    }
    if (tailscale.source !== 'fallback') {
      console.log(`[dev:mobile] Metro: http://${tailscale.hostname}:${metroPort}`);
    }
  }
  console.log(`[dev:mobile] Metro log: .boardsesh/mobile-metro.log`);

  mkdirSync(BOARDSESH_DIR, { recursive: true });
  const logStream = createWriteStream(METRO_LOG_PATH, { flags: 'w' });

  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  if (branchName) childEnv.BOARDSESH_DEV_BRANCH_NAME = branchName;
  if (commitSha) childEnv.BOARDSESH_DEV_COMMIT_SHA = commitSha;
  if (qaNotes.contents) childEnv.BOARDSESH_DEV_QA_NOTES = qaNotes.contents;
  if (qaNotes.filePath) childEnv.BOARDSESH_DEV_QA_NOTES_FILE = qaNotes.filePath;
  childEnv.BOARDSESH_DEV_ROOT_DIR = ROOT_DIR;
  childEnv.BOARDSESH_DEV_WORKTREE_LABEL = worktreeLabel;
  childEnv.BOARDSESH_DEV_STARTED_AT = startedAt;
  childEnv.BOARDSESH_METRO_PORT = String(metroPort);
  if (tailscale && tailscale.source !== 'fallback') {
    childEnv.REACT_NATIVE_PACKAGER_HOSTNAME = tailscale.hostname;
  }

  // Default to --host lan so devices on the same Tailnet/LAN can reach the
  // bundler. Simulator mode pins --host localhost — Expo's default is `lan`
  // and the LAN auto-detect can pick a Tailscale/utun interface the simulator
  // can't reach, which would re-trigger the original "could not connect" bug.
  // Respect a user-supplied --host either way.
  const userPassedHost = metroPassthroughArgs.some(
    (arg) =>
      arg === '--host' || arg.startsWith('--host=') || arg === '--localhost' || arg === '--lan' || arg === '--tunnel',
  );
  // We ship a custom dev client (EAS preview-build flow); Metro must serve the
  // dev-client bundle, not the Expo Go one. Opt out by passing --go.
  const userPickedClient = passthroughArgs.some(
    (arg) => arg === '--dev-client' || arg === '--go' || arg.startsWith('--dev-client=') || arg.startsWith('--go='),
  );
  const defaultHostArgs = userPassedHost ? [] : simulator ? ['--host', 'localhost'] : ['--host', 'lan'];
  const expoArgs = [
    'expo',
    'start',
    ...defaultHostArgs,
    ...(userPickedClient ? [] : ['--dev-client']),
    ...metroPassthroughArgs,
  ];

  const child = spawn('bunx', expoArgs, {
    cwd: join(ROOT_DIR, 'packages', 'mobile'),
    env: childEnv,
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  child.stdout!.on('data', (chunk: Buffer) => {
    process.stdout.write(chunk);
    logStream.write(chunk);
  });

  child.stderr!.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
    logStream.write(chunk);
  });

  const forwardSignal = (signal: NodeJS.Signals) => {
    child.kill(signal);
  };
  process.on('SIGINT', forwardSignal);
  process.on('SIGTERM', forwardSignal);

  child.on('close', (exitCode: number | null) => {
    logStream.end();
    process.exit(exitCode ?? 1);
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[dev:mobile] ${message}`);
  process.exit(1);
});
