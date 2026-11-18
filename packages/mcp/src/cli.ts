import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server';
import { Runtime } from './runtime';
import { login, logout } from './auth';
import { withProfileLock } from './profile-lock';
import { LocalStore } from './storage';
import { LEGACY_PUBLIC_CLIENT_IDS, McpError, PUBLIC_CLIENT_ID, type Profile } from './types';

declare const __BOARDSESH_MCP_CLIENT_ID__: string;
const releaseClientId =
  (typeof __BOARDSESH_MCP_CLIENT_ID__ === 'string' && __BOARDSESH_MCP_CLIENT_ID__) || PUBLIC_CLIENT_ID;
const help = `boardsesh-mcp [serve|login|sync|status|logout] [options]

  serve                  Serve MCP over stdio (default); no interactive login
  login                  Connect Boardsesh in your system browser
  sync                   Pull a bounded batch of logbook changes
  status                 Show login and history freshness
  logout                 Disable local access and revoke this saved token family

  --data-dir PATH         Override the private local profile directory
  --client-id ID          Public OAuth client override for developer testing
  --no-browser           Print the login URL without opening a browser
  --help                 Show this help

History searches work offline after a complete sync. Remote revocation is
detected on the next online request. Tokens are never accepted in chat.
`;

export function defaultDataDir(environment: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32')
    return join(environment.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Boardsesh', 'mcp');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Boardsesh', 'mcp');
  return join(environment.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'boardsesh', 'mcp');
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? (['open', [url]] as const)
      : process.platform === 'win32'
        ? (['rundll32.exe', ['url.dll,FileProtocolHandler', url]] as const)
        : (['xdg-open', [url]] as const);
  const child = spawn(command, [...args], { stdio: 'ignore', detached: true, shell: false });
  child.on('error', () => process.stderr.write('Could not open a browser. Open the printed URL yourself.\n'));
  child.unref();
}

function reportError(error: unknown): void {
  process.stderr.write(
    `${error instanceof McpError ? `${error.code}: ${error.message}` : 'The operation failed. Check your connection and local profile permissions.'}\n`,
  );
}

export function selectClient(
  explicit: string | undefined,
  environment: string | undefined,
  profile: Profile | undefined,
  bundled = releaseClientId,
): { clientId: string; clientIdSource: 'bundled' | 'override' } {
  const override = explicit ?? environment;
  if (override !== undefined) return { clientId: override, clientIdSource: 'override' };
  // The first release stored no provenance. Preserve its custom registrations,
  // while treating its known official ID as the bundled default.
  if (
    profile?.clientIdSource === 'override' ||
    (profile && !profile.clientIdSource && !LEGACY_PUBLIC_CLIENT_IDS.includes(profile.clientId))
  ) {
    return { clientId: profile.clientId, clientIdSource: 'override' };
  }
  return { clientId: bundled, clientIdSource: 'bundled' };
}

export function parseCommandArguments(argumentsList: string[]) {
  try {
    return parseArgs({
      args: argumentsList,
      allowPositionals: true,
      options: {
        'data-dir': { type: 'string' },
        'client-id': { type: 'string' },
        'no-browser': { type: 'boolean' },
        help: { type: 'boolean' },
      },
    });
  } catch {
    throw new McpError('invalid_command', 'Unknown option or missing option value. Use --help for options.');
  }
}

export async function main(argumentsList = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseCommandArguments(argumentsList);
  if (values.help) {
    process.stdout.write(help);
    return;
  }
  const command = positionals[0] ?? 'serve';
  if (positionals.length > 1 || !['serve', 'login', 'sync', 'status', 'logout'].includes(command)) {
    throw new McpError('invalid_command', 'Choose serve, login, sync, status, or logout. Use --help for options.');
  }
  const dataDir = resolve(values['data-dir'] ?? defaultDataDir());
  const runtime = new Runtime(dataDir);
  if (command === 'serve') {
    const handle = serveStdio(() => createServer(runtime), { onerror: reportError });
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (delay: number) => {
      if (!stopped) {
        timer = setTimeout(() => void backgroundSync(), delay);
        timer.unref();
      }
    };
    const backgroundSync = async () => {
      try {
        const result = await runtime.withStore(async (store, client) => {
          const profile = store.getProfile();
          if (profile?.authStatus !== 'connected' || !profile.scopes.includes('logbook:read')) return undefined;
          const state = store.getSyncStatus(profile);
          if (
            !state.syncing &&
            !state.fullSyncRequired &&
            state.lastSyncedAt &&
            Date.now() - Date.parse(state.lastSyncedAt) < 15 * 60_000
          )
            return undefined;
          const { syncLogbook } = await import('./sync');
          return syncLogbook(store, client, profile);
        });
        schedule(result?.hasMore ? 30_000 : 15 * 60_000);
      } catch (error) {
        reportError(error);
        schedule(
          error instanceof McpError && error.retryAfterSeconds
            ? Math.max(30_000, error.retryAfterSeconds * 1000)
            : 60_000,
        );
      }
    };
    const stop = () => {
      stopped = true;
      clearTimeout(timer);
      void handle.close();
    };
    process.stdin.once('end', stop);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    schedule(1000);
    return;
  }
  if (command === 'login' || command === 'logout') {
    const result = await withProfileLock(dataDir, async (guard) => {
      const store = new LocalStore(dataDir, () => guard.assertHeld());
      try {
        if (command === 'logout') return await logout({ dataDir, store, guard });
        const { clientId, clientIdSource } = selectClient(
          values['client-id'],
          process.env.BOARDSESH_MCP_CLIENT_ID,
          store.getProfile(),
        );
        if (!clientId)
          throw new McpError(
            'client_not_configured',
            'The public client ID cannot be empty. Omit --client-id to use the registered MCP app; no client secret is needed.',
          );
        const profile = await login({
          dataDir,
          store,
          guard,
          clientId,
          clientIdSource,
          onAuthorizationUrl: (url) => {
            process.stderr.write(`Open this URL in your system browser:\n${url}\n`);
            if (!values['no-browser']) openBrowser(url);
          },
        });
        return {
          connected: true,
          subject: profile.subject,
          nextAction: 'Start your MCP client or run boardsesh-mcp sync.',
        };
      } finally {
        store.close();
      }
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `${JSON.stringify(command === 'sync' ? await runtime.sync() : await runtime.status(), null, 2)}\n`,
  );
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  main().catch((error: unknown) => {
    reportError(error);
    process.exitCode = 1;
  });
}
