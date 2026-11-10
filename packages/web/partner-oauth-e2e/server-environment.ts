import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';

/**
 * The environment the two servers run with, and the check that nothing in it
 * can reach a real service.
 *
 * Inherited variables come only from an allowlist of what a shell needs to run
 * `vp`, Node and Next. Everything else is set here. The servers also read
 * environment files on their own (Next loads `.env.local` and friends, the
 * backend `.boardsesh/dev-db.env` and `.env.development.local`), so those files
 * are read too and folded in the way each server would: a credential-looking key
 * from a file is blanked, which keeps the file from supplying it, and any value
 * left that names a host must name this machine or a private network.
 */

export type Environment = Record<string, string | undefined>;

/** What a shell needs to run the toolchain, and nothing that names a service. */
const INHERITED_NAMES = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
  'CI',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'PNPM_HOME',
  'COREPACK_HOME',
  'NVM_DIR',
  'VOLTA_HOME',
]);
/** Toolchain settings by prefix: Vite+ and its package manager. */
const INHERITED_PREFIXES = ['VP_', 'VITE_PLUS_'];

export function inheritedEnvironment(source: NodeJS.ProcessEnv): Environment {
  const inherited: Environment = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (INHERITED_NAMES.has(name) || INHERITED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      inherited[name] = value;
    }
  }
  return inherited;
}

/**
 * A value an environment file may not supply: credentials for an outside
 * service. Blanked rather than dropped, because both servers let a variable that
 * is already set, even to an empty string, win over their files.
 */
const CREDENTIAL_NAME =
  /(?:^|_)(?:KEY|SECRET|TOKEN|PASSWORD|DSN|CREDENTIALS?)$|^(?:SMTP|POSTHOG|NEXT_PUBLIC_POSTHOG|MEDIA|AWS|R2|S3|STRAVA|FEEDBACK_GITHUB|APNS|SENTRY|GOOGLE|APPLE|FACEBOOK|RAILWAY|CLOUDFLARE|OPENAI|ANTHROPIC)_/;

/**
 * Names whose value is a production URL on purpose and is never fetched by a
 * server: links in pages, and the origin NextAuth names its cookies after. The
 * browser's proxy refuses every production host but the three the edge serves.
 */
const LINK_ONLY_NAMES = new Set(['NEXTAUTH_URL', 'NEXT_PUBLIC_APP_URL']);

export interface EnvironmentFile {
  path: string;
  /** The backend's `.env.development.local` overrides what is already set. */
  override: boolean;
}

function parseEnvironmentFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const name = trimmed
      .slice(0, separator)
      .replace(/^export\s+/, '')
      .trim();
    values[name] = trimmed
      .slice(separator + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

export interface ServerEnvironment {
  environment: Environment;
  /** Credential-looking names an override file sets; the child cannot blank them. */
  forcedCredentials: string[];
}

/**
 * The environment the server will actually see: `explicit` (inherited plus what
 * the setup sets), then each file in load order. Credential-looking names a file
 * would add are blanked in what is returned, so the caller passes the result to
 * the child and the file loses.
 */
export function serverEnvironment(explicit: Environment, files: readonly EnvironmentFile[]): ServerEnvironment {
  const environment: Environment = { ...explicit };
  const forcedCredentials: string[] = [];
  for (const file of files) {
    for (const [name, value] of Object.entries(parseEnvironmentFile(file.path))) {
      if (file.override) {
        // Wins over anything set here, so it is checked as the value the server will use.
        if (CREDENTIAL_NAME.test(name) && value !== '') forcedCredentials.push(name);
        else environment[name] = value;
        continue;
      }
      if (environment[name] !== undefined) continue;
      environment[name] = CREDENTIAL_NAME.test(name) ? '' : value;
    }
  }
  return { environment, forcedCredentials };
}

function isLocalHost(rawHost: string): boolean {
  const host = rawHost
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  // A single label (`postgres`, `redis`) is a container or LAN name; `.local` and
  // Tailscale's `.ts.net` are the dev database's other homes.
  if (!host.includes('.') && !isIP(host)) return true;
  if (host.endsWith('.local') || host.endsWith('.ts.net')) return true;
  if (isIP(host) === 4) {
    const [first, second] = host.split('.').map(Number);
    return (
      first === 127 ||
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 100 && second >= 64 && second <= 127)
    );
  }
  if (isIP(host) === 6) return host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80');
  return false;
}

/** Every host a value names: URLs anywhere in it, or the whole value for a `*_HOST` name. */
function hostsIn(name: string, value: string): string[] {
  const hosts: string[] = [];
  for (const candidate of value.split(/[\s,]+/)) {
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) continue;
    try {
      const { hostname } = new URL(candidate);
      if (hostname) hosts.push(hostname);
    } catch {
      hosts.push(candidate);
    }
  }
  if (name.endsWith('_HOST') && value && hosts.length === 0) hosts.push(value);
  return hosts;
}

/**
 * Throws, naming only the variables, when the environment would let a server
 * reach anything but this machine: a host that is not local, or a credential an
 * override file forces in.
 */
export function assertLocalOnly(server: string, { environment, forcedCredentials }: ServerEnvironment): void {
  const problems = forcedCredentials.map((name) => `${name} (a credential an override file forces in)`);
  for (const [name, value] of Object.entries(environment)) {
    if (!value) continue;
    if (LINK_ONLY_NAMES.has(name) || INHERITED_NAMES.has(name)) continue;
    if (hostsIn(name, value).some((host) => !isLocalHost(host))) problems.push(name);
  }
  if (problems.length > 0) {
    throw new Error(
      `Refusing to start the ${server} for the partner e2e: ${problems.join(', ')} would reach a service off this machine. ` +
        'Unset them, or point them at a local service.',
    );
  }
}
