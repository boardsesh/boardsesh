/// <reference types="node" />

/**
 * Run the screenshot backend (scripts/lib/screenshot-backend.ts) as a process.
 *
 *   vp run mobile:screenshot-backend -- --mode replay
 *   vp run mobile:screenshot-backend -- --mode record --upstream https://ws.boardsesh.com
 *
 * The capture orchestrator starts this itself for
 * `vp run mobile:screenshots -- --fixtures record|replay` and points the app at
 * it with EXPO_PUBLIC_BACKEND_URL / EXPO_PUBLIC_WS_URL; run it by hand to serve
 * a set to a dev build. See docs/mobile-screenshot-fixtures.md.
 */

import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createScreenshotBackend,
  readScreenshotFixtureManifest,
  type ScreenshotBackendServer,
} from './lib/screenshot-backend';
import {
  DEFAULT_SCREENSHOT_FIXTURES_DIR,
  SCREENSHOT_BACKEND_DEFAULT_PORT,
  resolveScreenshotBackendPort,
  startOfSecondIso,
  type ScreenshotBackendMode,
} from './lib/screenshot-fixtures';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_FIXTURES_DIR = DEFAULT_SCREENSHOT_FIXTURES_DIR;
const DEFAULT_UPSTREAM = 'https://ws.boardsesh.com';
const DEFAULT_PORT = SCREENSHOT_BACKEND_DEFAULT_PORT;

type CliOptions = {
  mode: ScreenshotBackendMode;
  port: number;
  fixturesDir: string;
  upstream: string;
  frozenNow: string | null;
  fresh: boolean;
  flow: string | null;
};

const USAGE = [
  'Usage: tsx scripts/screenshot-backend.ts --mode replay|record [options]',
  '',
  '  --mode <replay|record>  required',
  `  --port <n>              default BOARDSESH_SCREENSHOT_BACKEND_PORT or ${DEFAULT_PORT}`,
  `  --fixtures <dir>        default ${DEFAULT_FIXTURES_DIR} (relative to the repo root)`,
  `  --upstream <url>        record only, default ${DEFAULT_UPSTREAM}`,
  '  --frozen-now <iso>      record: defaults to now; replay: defaults to the manifest',
  '  --flow <name>           record only, the capture flow being recorded',
  '  --fresh                 record only, discard the existing fixture set first',
].join('\n');

function fail(message: string): never {
  console.error(`[screenshot-backend] ${message}`);
  process.exit(1);
}

function nextArgument(argv: string[], index: number, flag: string): string {
  const argumentValue = argv[index + 1];
  if (argumentValue === undefined || argumentValue.startsWith('--')) fail(`${flag} needs a value\n\n${USAGE}`);
  return argumentValue;
}

export function parseCliArguments(argv: string[]): CliOptions {
  let mode: ScreenshotBackendMode | null = null;
  let port: number | null = null;
  let fixtures: string | null = null;
  let upstream: string | null = null;
  let frozenNow: string | null = null;
  let flow: string | null = null;
  let fresh = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      // `vp run mobile:screenshot-backend -- --mode replay` puts a literal
      // `--` ahead of every flag — vp's own argument separator, not one of
      // ours. Skip it rather than fail on it (mobile-android-apk.ts and
      // cloudflare-apply.ts do the same, filtering it out ahead of their loop
      // instead of inline).
      case '--':
        break;
      case '--mode': {
        const requested = nextArgument(argv, index, flag);
        if (requested !== 'replay' && requested !== 'record') fail(`--mode must be replay or record\n\n${USAGE}`);
        mode = requested;
        index += 1;
        break;
      }
      case '--port':
        port = Number(nextArgument(argv, index, flag));
        index += 1;
        break;
      case '--fixtures':
        fixtures = nextArgument(argv, index, flag);
        index += 1;
        break;
      case '--upstream':
        upstream = nextArgument(argv, index, flag);
        index += 1;
        break;
      case '--frozen-now':
        frozenNow = nextArgument(argv, index, flag);
        index += 1;
        break;
      case '--flow':
        flow = nextArgument(argv, index, flag);
        index += 1;
        break;
      case '--fresh':
        fresh = true;
        break;
      case '--help':
      case '-h':
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        fail(`unknown argument ${flag}\n\n${USAGE}`);
    }
  }

  if (!mode) fail(`--mode is required\n\n${USAGE}`);
  const resolvedPort = port ?? resolveScreenshotBackendPort(process.env.BOARDSESH_SCREENSHOT_BACKEND_PORT);
  if (!Number.isInteger(resolvedPort) || resolvedPort < 0 || resolvedPort > 65535) {
    fail(`--port must be a port number, got ${resolvedPort}`);
  }
  if (mode === 'replay' && upstream) fail('--upstream is record-only: replay never makes an outbound request');
  if (mode === 'replay' && fresh) fail('--fresh is record-only');

  const fixturesArgument = fixtures ?? DEFAULT_FIXTURES_DIR;
  return {
    mode,
    port: resolvedPort,
    fixturesDir: isAbsolute(fixturesArgument) ? fixturesArgument : resolve(REPO_ROOT, fixturesArgument),
    upstream: upstream ?? DEFAULT_UPSTREAM,
    frozenNow,
    fresh,
    flow,
  };
}

async function main(): Promise<void> {
  const options = parseCliArguments(process.argv.slice(2));

  let frozenNow = options.frozenNow;
  if (!frozenNow) {
    if (options.mode === 'record') frozenNow = startOfSecondIso(new Date());
    else {
      // Replay reproduces the recorded run, so its frozen instant is whatever
      // the recording froze — not today.
      let manifest: ReturnType<typeof readScreenshotFixtureManifest>;
      try {
        manifest = readScreenshotFixtureManifest(options.fixturesDir);
      } catch (manifestError) {
        fail(manifestError instanceof Error ? manifestError.message : String(manifestError));
      }
      if (!manifest) fail(`no recorded fixture set under ${options.fixturesDir} — record one first`);
      frozenNow = manifest.frozenNow;
    }
  }

  let backend: ScreenshotBackendServer;
  try {
    backend = createScreenshotBackend({
      mode: options.mode,
      fixturesDir: options.fixturesDir,
      upstreamUrl: options.mode === 'record' ? options.upstream : null,
      frozenNow,
      log: (line) => console.log(line),
      fresh: options.fresh,
      ...(options.flow ? { flow: options.flow } : {}),
    });
  } catch (createError) {
    fail(createError instanceof Error ? createError.message : String(createError));
  }

  try {
    await backend.listen(options.port);
  } catch (listenError) {
    const code = (listenError as { code?: string }).code;
    if (code === 'EADDRINUSE') {
      fail(
        `port ${options.port} is already in use — stop whatever is on it, or pass --port / BOARDSESH_SCREENSHOT_BACKEND_PORT.`,
      );
    }
    fail(listenError instanceof Error ? listenError.message : String(listenError));
  }

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void backend.close().then(() => {
      const finalStats = backend.stats();
      if (finalStats.redacted > 0) {
        console.error(
          `[screenshot-backend] ${finalStats.redacted} fixture(s) carried a live auth token and were NOT written — the recording is incomplete.`,
        );
        process.exit(1);
      }
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Guarded so importing this module (e.g. from Vitest, to reach
// parseCliArguments) never starts the server or triggers SIGINT/SIGTERM
// handlers — the same pattern mobile-android-apk.ts and cloudflare-apply.ts
// use for the same reason.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
