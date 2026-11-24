/// <reference types="node" />

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const repoRoot = resolve(import.meta.dirname, '../..');

const BACKEND_RUNTIME_PACKAGES = [
  '@better-auth/cimd',
  '@better-auth/drizzle-adapter',
  '@better-auth/oauth-provider',
  'better-auth',
];
const PINNED_VERSION = '1.7.17';
const BACKEND_MANIFEST_PATH = 'packages/backend/package.json';
/** Better Auth stays inside the two backend-owned authority implementations. */
const PARTNER_ROOT = 'packages/backend/src/auth/partner/';
const FIRST_PARTY_AUTHORITY_ROOT = 'packages/backend/src/auth/authority/';
/** Reviewed runtime importers. The transport wrapper alone imports its runtime only when called. */
const PARTNER_SAFE_TRANSPORT_MODULE = 'secure-resource-fetch.ts';
const PARTNER_RUNTIME_IMPORTERS = [
  'authority.ts',
  'consent.ts',
  'family-guard.ts',
  'fence.ts',
  'registration.ts',
  // Gym client discovery and its consent policy belong to this same authority.
  'gym-mcp-clients.ts',
  'gym-mcp-guard.ts',
  PARTNER_SAFE_TRANSPORT_MODULE,
];
/**
 * The only production modules outside the partner folder that may reach into
 * it, and what each may load. None of these constructs an authority or opens a
 * pool: the authority itself comes only through the loader.
 */
const PARTNER_ENTRY_POINTS: Readonly<Record<string, readonly string[]>> = {
  // The OAuth routes on the API host (F9).
  'packages/backend/src/handlers/partner-auth.ts': [
    '../auth/partner/load-authority',
    '../auth/partner/mode',
    '../auth/partner/routes',
  ],
  // The public /v1 API on the API host (F10).
  'packages/backend/src/handlers/public-api/router.ts': [
    '../../auth/partner/load-authority',
    '../../auth/partner/mode',
  ],
  // Hosted gym tools share the issuer's opaque-token checks and revocation
  // lock order. Authority construction still comes only through the loader.
  'packages/backend/src/mcp/gyms/auth.ts': [
    '../../auth/partner/load-authority',
    '../../auth/partner/bearer',
    '../../auth/partner/locks',
    'type ../../auth/partner/tables',
  ],
  'packages/backend/src/mcp/gyms/configuration.ts': ['../../auth/partner/mode'],
  'packages/backend/src/mcp/gyms/transport.ts': ['../../auth/partner/mode', 'type ../../auth/partner/bearer'],
  // Images reuse only the DNS-pinned network primitive, with no auth/runtime
  // initialization until an authorized tool explicitly requests a fetch.
  'packages/backend/src/mcp/gyms/media.ts': ['../../auth/partner/secure-resource-fetch'],
  // The developer console's GraphQL operations (F12).
  'packages/backend/src/graphql/resolvers/oauth-clients/partner-registration.ts': [
    '../../../auth/partner/developer-access',
    '../../../auth/partner/developer-email',
    '../../../auth/partner/load-authority',
    '../../../auth/partner/mode',
    '../../../auth/partner/registration-rules',
  ],
  // The retention sweep's job (F11), which runs whatever the mode and so must never load Better Auth.
  'packages/backend/src/services/partner-oauth-sweep.ts': ['../auth/partner/retention'],
  // The ops script's set-publisher command applies registration's own name rules.
  'packages/backend/src/scripts/partner-app-admin.ts': ['../auth/partner/registration-rules'],
  // Account deletion takes a developer's partner app locks in the partner order
  // before its cascade reaches them (plain SQL, whatever the mode).
  'packages/backend/src/graphql/resolvers/users/mutations.ts': ['../../../auth/partner/locks'],
  // Connected apps' GraphQL operations (F16), which serve every mode and so must never load Better Auth.
  'packages/backend/src/graphql/resolvers/connected-apps/connected-apps.ts': [
    '../../../auth/partner/connected-apps',
    '../../../auth/partner/mode',
  ],
  // A type-only dependency cannot be promoted to a runtime import without review.
  'packages/backend/src/server.ts': ['./auth/partner/mode'],
  'packages/backend/src/graphql/resolvers/app-workouts/index.ts': [
    '../../../auth/partner/mode',
    'type ../../../auth/partner/tables',
  ],
  'packages/backend/src/graphql/resolvers/sessions/mutations.ts': [
    '../../../auth/partner/mode',
    'type ../../../auth/partner/tables',
  ],
  'packages/backend/src/graphql/resolvers/sessions/session-workouts.ts': ['type ../../../auth/partner/tables'],
  'packages/backend/src/handlers/public-api/workouts.ts': ['type ../../auth/partner/bearer'],
  'packages/backend/src/services/app-workout-maintenance.ts': ['type ../auth/partner/tables'],
  'packages/backend/src/services/public-api/workout-lifecycle.ts': [
    '../../auth/partner/locks',
    'type ../../auth/partner/tables',
  ],
  'packages/backend/src/services/public-api/workout-results.ts': ['type ../../auth/partner/tables'],
  'packages/backend/src/services/public-api/workout-seed.ts': ['type ../../auth/partner/tables'],
  'packages/backend/src/services/public-api/workouts.ts': [
    '../../auth/partner/api-access',
    '../../auth/partner/bearer',
    '../../auth/partner/configuration',
    '../../auth/partner/locks',
    '../../auth/partner/transaction',
    'type ../../auth/partner/tables',
  ],
  'packages/backend/src/services/room-manager/session-discovery.ts': ['type ../../auth/partner/tables'],
  // Webhooks share token checks and registration guards without loading the issuer.
  'packages/backend/src/services/partner-webhooks/authorization.ts': ['../../auth/partner/configuration'],
  'packages/backend/src/services/partner-webhooks/crypto.ts': ['../../auth/partner/configuration'],
  'packages/backend/src/services/partner-webhooks/events.ts': [
    '../../auth/partner/api-access',
    'type ../../auth/partner/tables',
  ],
  'packages/backend/src/services/partner-webhooks/settings.ts': [
    '../../auth/partner/developer-change',
    '../../auth/partner/registration-rules',
    '../../auth/partner/transaction',
    'type ../../auth/partner/tables',
  ],
  'packages/backend/src/services/partner-webhooks/worker.ts': ['../../auth/partner/mode'],
};
/** The sweep itself: plain SQL on the partner tables. */
const PARTNER_SWEEP_MODULE = `${PARTNER_ROOT}retention.ts`;
/**
 * Connected apps (F16): a climber's list and Disconnect, which work in every
 * mode. Plain SQL through the same Disconnect path as `DELETE /v1/connection`,
 * and these are every partner module it loads, at any depth.
 */
const CONNECTED_APPS_MODULE = `${PARTNER_ROOT}connected-apps.ts`;
const CONNECTED_APPS_PARTNER_CLOSURE = ['connected-apps.ts', 'connection.ts', 'locks.ts', 'transaction.ts'];
// Runtime dependencies within the partner folder, including all transitive targets.
// The loader, Connected apps and retention have their own checks below.
const PARTNER_ENTRY_TARGETS: Readonly<Record<string, readonly string[]>> = {
  'api-access.ts': ['./bearer', './connection', './locks', './transaction'],
  'bearer.ts': [],
  'configuration.ts': [],
  'connection.ts': ['./locks', './transaction'],
  'developer-access.ts': [],
  'developer-change.ts': ['./registration-rules'],
  'developer-email.ts': ['./registration-rules'],
  'locks.ts': [],
  'mode.ts': [],
  'registration-rules.ts': [],
  'routes.ts': [],
  'transaction.ts': [],
  [PARTNER_SAFE_TRANSPORT_MODULE]: [],
};

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface DependabotConfig {
  updates: { directory: string; ignore?: { 'dependency-name': string }[] }[];
}

const readRepoFile = (path: string): string => readFileSync(join(repoRoot, path), 'utf8');

const trackedPackageFiles = execFileSync('git', ['ls-files', 'packages'], {
  cwd: repoRoot,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
  .split('\n')
  .filter(Boolean);

const trackedSourceFiles = trackedPackageFiles.filter((path) => /\.[cm]?[jt]sx?$/.test(path));

const IMPORT_SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"`]([^'"`]+)['"`]/g;

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(IMPORT_SPECIFIER)].map(([, specifier]) => specifier);
}

function isBetterAuthSpecifier(specifier: string): boolean {
  return specifier === 'better-auth' || specifier.startsWith('better-auth/') || specifier.startsWith('@better-auth/');
}

function runtimeImportSpecifiers(source: string): string[] {
  // A bare `import type` is erased at compile time, so it cannot pull a module in.
  return importSpecifiers(source.replace(/import\s+type\s[^;]*;/g, ''));
}

function filesImporting(paths: string[], matches: (specifier: string) => boolean): string[] {
  return paths.filter((path) => importSpecifiers(readRepoFile(path)).some(matches));
}

function resolvesIntoPartnerFolder(importerPath: string, specifier: string): boolean {
  if (!specifier.startsWith('.')) return /(^|\/)auth\/partner(\/|$)/.test(specifier);
  return `${posix.join(posix.dirname(importerPath), specifier)}/`.startsWith(PARTNER_ROOT);
}

function isAllowedBetterAuthImporter(path: string): boolean {
  return [PARTNER_ROOT, FIRST_PARTY_AUTHORITY_ROOT].some((root) => path.startsWith(root));
}

function isProductionSource(path: string): boolean {
  return !path.includes('/__tests__/') && !/\.test\.[cm]?[jt]sx?$/.test(path);
}

describe('import scanner', () => {
  it.each([
    [`import { betterAuth } from 'better-auth';`],
    [`import 'better-auth/api';`],
    [`const loaded = await import('@better-auth/oauth-provider');`],
    [`const loaded = require("@better-auth/drizzle-adapter");`],
    [`export { oauthProvider } from '@better-auth/oauth-provider';`],
  ])('finds %s', (source) => {
    expect(importSpecifiers(source).some(isBetterAuthSpecifier)).toBe(true);
  });

  it.each([[`const cookie = 'better-auth.session_token';`], [`import { hash } from 'bcryptjs';`]])(
    'ignores %s',
    (source) => {
      expect(importSpecifiers(source).some(isBetterAuthSpecifier)).toBe(false);
    },
  );
});

describe('first-party authority boundary', () => {
  it.each([
    ['packages/backend/src/auth/partner/authority.ts', true],
    ['packages/backend/src/auth/authority/authority.ts', true],
    ['packages/backend/src/auth/authority/adapter.ts', true],
    ['packages/backend/src/auth/authority-extra.ts', false],
    ['packages/web/app/auth/authority/page.ts', false],
    ['packages/mobile/src/auth/authority.ts', false],
    ['packages/shared/auth/authority.ts', false],
  ])('keeps the backend-only boundary for %s', (path, allowed) => {
    expect(isAllowedBetterAuthImporter(path)).toBe(allowed);
  });

  it('confines direct runtime imports to the reviewed unmounted factory and adapter', () => {
    const importers = trackedSourceFiles
      .filter((path) => path.startsWith(FIRST_PARTY_AUTHORITY_ROOT) && isProductionSource(path))
      .filter((path) => runtimeImportSpecifiers(readRepoFile(path)).some(isBetterAuthSpecifier))
      .map((path) => path.slice(FIRST_PARTY_AUTHORITY_ROOT.length));
    expect(importers.sort()).toEqual(['adapter.ts', 'authority.ts']);
  });
});

describe('www browser session cutover list', () => {
  const MODE_MODULE = 'packages/web/app/lib/auth/browser-session-mode.server.ts';
  const RESOLVER_CALL = /browserSessionRouteModeResolver\(([^)]*)\)/g;

  it('builds the production resolver from the frozen list, and only tests and proofs pass another', () => {
    const callers = trackedSourceFiles.filter((path) =>
      readRepoFile(path).includes('browserSessionRouteModeResolver('),
    );
    for (const path of callers) {
      const lists = [...readRepoFile(path).matchAll(RESOLVER_CALL)].map(([, argument]) => argument.trim());
      if (!isProductionSource(path) || path.startsWith('packages/web/auth-proofs/')) continue;
      expect(path).toBe(MODE_MODULE);
      expect(lists).toEqual(['cutoverBlockers: readonly string[]', 'BROWSER_SESSION_WEB_CUTOVER_BLOCKERS']);
    }
    expect(callers).toContain(MODE_MODULE);
  });
});

describe('partner folder resolution', () => {
  const importer = 'packages/backend/src/auth/session.ts';

  it.each([
    [importer, './partner/mode'],
    [importer, './partner'],
    ['packages/backend/src/handlers/oauth.ts', '../auth/partner/load-authority'],
    ['packages/backend/src/handlers/deep/route.ts', '../../auth/partner'],
    [importer, 'boardsesh-backend/src/auth/partner/mode'],
  ])('%s importing %s is caught', (path, specifier) => {
    expect(resolvesIntoPartnerFolder(path, specifier)).toBe(true);
  });

  it.each([
    [importer, './partners'],
    ['packages/backend/src/handlers/oauth.ts', '../utils/partner'],
  ])('%s importing %s is not', (path, specifier) => {
    expect(resolvesIntoPartnerFolder(path, specifier)).toBe(false);
  });
});

describe('Better Auth dependency boundary', () => {
  it('is a backend runtime dependency, pinned exactly', () => {
    const manifest = JSON.parse(readRepoFile(BACKEND_MANIFEST_PATH)) as Manifest;
    for (const packageName of BACKEND_RUNTIME_PACKAGES) {
      expect(manifest.dependencies?.[packageName], packageName).toBe(PINNED_VERSION);
      expect(manifest.devDependencies?.[packageName], packageName).toBeUndefined();
    }
  });

  it('is declared by no other workspace package', () => {
    const offenders = trackedPackageFiles
      .filter((path) => path.endsWith('package.json') && path !== BACKEND_MANIFEST_PATH)
      .filter((path) => {
        const manifest = JSON.parse(readRepoFile(path)) as Manifest;
        return Object.keys({
          ...manifest.dependencies,
          ...manifest.devDependencies,
          ...manifest.optionalDependencies,
          ...manifest.peerDependencies,
        }).some(isBetterAuthSpecifier);
      });
    expect(offenders).toEqual([]);
  });

  it('is imported only by backend authority modules, so web and mobile can never bundle it', () => {
    const importers = filesImporting(trackedSourceFiles, isBetterAuthSpecifier);
    expect(importers.length).toBeGreaterThan(0);
    expect(importers.filter((path) => !isAllowedBetterAuthImporter(path))).toEqual([]);
  });

  it('confines runtime Better Auth imports inside the partner folder to the listed modules', () => {
    const partnerModules = trackedSourceFiles.filter(
      (path) => path.startsWith(PARTNER_ROOT) && isProductionSource(path),
    );
    expect(partnerModules.length).toBeGreaterThan(0);
    const runtimeImporters = partnerModules
      .filter((path) => runtimeImportSpecifiers(readRepoFile(path)).some(isBetterAuthSpecifier))
      .map((path) => path.slice(PARTNER_ROOT.length));
    expect(runtimeImporters.sort()).toEqual([...PARTNER_RUNTIME_IMPORTERS].sort());
  });

  it('lets only the listed production modules outside the partner folder reach into it', () => {
    const productionModules = trackedSourceFiles.filter(
      (path) => path.startsWith('packages/backend/src/') && !path.startsWith(PARTNER_ROOT) && isProductionSource(path),
    );
    expect(productionModules.length).toBeGreaterThan(0);
    const importers = productionModules.filter((path) =>
      importSpecifiers(readRepoFile(path)).some((specifier) => resolvesIntoPartnerFolder(path, specifier)),
    );
    expect(importers.sort()).toEqual(Object.keys(PARTNER_ENTRY_POINTS).sort());
  });

  it.each(Object.entries(PARTNER_ENTRY_POINTS))(
    'limits %s to modules that build nothing, and to the loader for the authority',
    (entryPoint, allowedImports) => {
      const entrySource = readRepoFile(entryPoint);
      const runtimeImports = new Set(runtimeImportSpecifiers(entrySource));
      const partnerImports = importSpecifiers(entrySource)
        .filter((specifier) => resolvesIntoPartnerFolder(entryPoint, specifier))
        .map((specifier) => (runtimeImports.has(specifier) ? specifier : `type ${specifier}`));
      expect([...new Set(partnerImports)].sort()).toEqual([...allowedImports].sort());
      expect(entrySource).not.toMatch(/import\(['"`][^'"`]*auth\/partner/);
      expect(importSpecifiers(entrySource).some(isBetterAuthSpecifier)).toBe(false);
    },
  );

  it.each(Object.entries(PARTNER_ENTRY_TARGETS))(
    'limits %s, which an entry point loads, to its reviewed authority dependencies',
    (file, allowedPartnerImports) => {
      const path = `${PARTNER_ROOT}${file}`;
      const specifiers = runtimeImportSpecifiers(readRepoFile(path));
      expect(specifiers.filter(isBetterAuthSpecifier)).toEqual(
        file === PARTNER_SAFE_TRANSPORT_MODULE ? ['@better-auth/cimd/node'] : [],
      );
      expect(specifiers).not.toContain('@boardsesh/db/client');
      expect(specifiers.filter((specifier) => resolvesIntoPartnerFolder(path, specifier)).sort()).toEqual(
        [...allowedPartnerImports].sort(),
      );
    },
  );

  it('loads only the DNS-pinned transport at call time from its narrow network wrapper', () => {
    const source = readRepoFile(`${PARTNER_ROOT}${PARTNER_SAFE_TRANSPORT_MODULE}`);
    expect(source).toContain("await import('@better-auth/cimd/node')");
    expect(runtimeImportSpecifiers(source)).toEqual(['@better-auth/cimd/node']);
    expect(source).not.toMatch(/\b(?:betterAuth|oauthProvider|createDedicatedPool|createPartnerAuthority)\s*\(/);
  });

  it('checks every reachable partner runtime module from the permitted entry points', () => {
    const directAndTransitive = [
      ...Object.values(PARTNER_ENTRY_POINTS).flat(),
      ...Object.values(PARTNER_ENTRY_TARGETS).flat(),
    ];
    const reachable = directAndTransitive
      .filter((specifier) => !specifier.startsWith('type '))
      .map((specifier) => `${posix.basename(specifier)}.ts`);
    const guardedTargets = [
      ...Object.keys(PARTNER_ENTRY_TARGETS),
      'load-authority.ts',
      'retention.ts',
      'connected-apps.ts',
    ];
    expect([...new Set(reachable)].sort()).toEqual(guardedTargets.sort());
  });

  it('keeps the sweep off every other partner module, so running it with the mode off loads nothing more', () => {
    const sweepSource = readRepoFile(PARTNER_SWEEP_MODULE);
    const relativeImports = runtimeImportSpecifiers(sweepSource).filter((specifier) => specifier.startsWith('.'));
    expect(relativeImports).toEqual(['../../utils/postgres-errors']);
    expect(importSpecifiers(sweepSource).some(isBetterAuthSpecifier)).toBe(false);
  });

  it('keeps Connected apps, which run whatever the mode, off Better Auth and the authority at any depth', () => {
    const loaded = new Set<string>();
    const pending = [CONNECTED_APPS_MODULE];
    while (pending.length > 0) {
      const path = pending.pop() as string;
      if (loaded.has(path)) continue;
      loaded.add(path);
      const specifiers = runtimeImportSpecifiers(readRepoFile(path));
      expect(specifiers.filter(isBetterAuthSpecifier), path).toEqual([]);
      for (const specifier of specifiers.filter((candidate) => candidate.startsWith('./'))) {
        pending.push(`${PARTNER_ROOT}${specifier.slice(2)}.ts`);
      }
    }
    expect([...loaded].map((path) => path.slice(PARTNER_ROOT.length)).sort()).toEqual(
      [...CONNECTED_APPS_PARTNER_CLOSURE].sort(),
    );
  });

  it('reaches the authority only through a dynamic import in the loader', () => {
    const loaderPath = `${PARTNER_ROOT}load-authority.ts`;
    const partnerModules = trackedSourceFiles.filter(
      (path) => path.startsWith(PARTNER_ROOT) && isProductionSource(path),
    );
    const authorityImporters = partnerModules.filter((path) =>
      runtimeImportSpecifiers(readRepoFile(path)).includes('./authority'),
    );
    expect(authorityImporters).toEqual([loaderPath]);
    expect(readRepoFile(loaderPath)).toContain("await import('./authority')");
  });

  it('keeps Dependabot from opening Better Auth upgrades', () => {
    const config = parse(readRepoFile('.github/dependabot.yml')) as DependabotConfig;
    const rootUpdate = config.updates.find((update) => update.directory === '/');
    const ignoredNames = rootUpdate?.ignore?.map((rule) => rule['dependency-name']);
    expect(ignoredNames).toEqual(expect.arrayContaining(['better-auth', '@better-auth/*']));
  });

  it('carries no release-age exclusions for the pinned packages', () => {
    const workspace = parse(readRepoFile('pnpm-workspace.yaml')) as { minimumReleaseAgeExclude?: string[] };
    const excluded = workspace.minimumReleaseAgeExclude ?? [];
    expect(excluded.filter((entry) => /^(?:better-auth|@better-auth\/|better-call)/.test(entry))).toEqual([]);
  });
});

/**
 * One credential writer (BA-03 #6977): a direct write to an identity table
 * (`users`, `user_credentials`, provider `accounts`, `verificationTokens`,
 * `mobile_refresh_tokens` or any `auth_*` table) outside the two authority
 * folders must be reviewed into this list, with the gate it sits behind. The
 * reasons are in docs/auth/better-auth-writer-inventory.md, "Writer gate
 * classification". The auth `sessions` table is left out: NextAuth issues JWTs
 * and never writes it, and the backend's `sessions` is board sessions. Web
 * writers are catalogued under #7596; mobile has no database.
 */
const IDENTITY_WRITE_PATTERNS = [
  /\.(?:insert|update|delete)\(\s*(?:[\w$]+\.)?(?:users|userCredentials|accounts|verificationTokens|mobileRefreshTokens|auth[A-Z]\w*)\s*\)/g,
  /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:public\.)?"?(?:users|user_credentials|accounts|verificationTokens|verification_tokens|mobile_refresh_tokens|auth_[a-z_]+)\b/g,
];
/**
 * The authority module and the staged commands: every write there runs under
 * the gate by construction, except the ones named in UNGATED_AUTHORITY_WRITES.
 */
const IDENTITY_AUTHORITY_ROOTS = [FIRST_PARTY_AUTHORITY_ROOT, 'packages/backend/src/auth/current-store/'];
/**
 * Functions inside the authority folders that write an identity table without
 * the gate, each with its reason. The text scan cannot see gating, so whoever
 * adds such a write names it here.
 */
const UNGATED_AUTHORITY_WRITES: Readonly<Record<string, readonly string[]>> = {
  // rollWebSession (#7596, owner decision 2): one conditional UPDATE of a web
  // session's expiry. It writes no identity, generation, credential or token,
  // and every reader re-checks the row's liveness, so it can only extend a
  // session that is still valid. The gate would add a statement to every roll
  // and fence nothing.
  'packages/backend/src/auth/authority/web-session.ts': ['rollWebSession'],
};

interface ReviewedIdentityWriter {
  /** Direct writes in the file. Outside the authority folders a new one needs review here. */
  readonly writes?: number;
  /** The gate the file's legacy writes sit behind, which must stay in the file. */
  readonly gate?: string;
}

const REVIEWED_IDENTITY_WRITERS: Readonly<Record<string, ReviewedIdentityWriter>> = {
  // Legacy writers: the shared gate and manifest check before the first write.
  'packages/backend/src/handlers/native-auth.ts': { writes: 6, gate: 'assertLegacyIdentityWriterAllowed(' },
  'packages/backend/src/graphql/resolvers/users/mutations.ts': {
    writes: 1,
    gate: 'beginLegacyAccountDeletion(',
  },
  'packages/backend/src/graphql/resolvers/board-presence/shared.ts': {
    writes: 1,
    gate: 'assertLegacyIdentityWriterAllowed(',
  },
  'packages/backend/src/auth/email-resolution/resolution.ts': { writes: 8, gate: 'lockLegacyIdentityWriterManifest(' },
  'packages/backend/src/auth/current-store/password-identity.ts': { gate: 'assertLegacyIdentityWriterAllowed(' },
  'packages/backend/src/auth/current-store/system-identities.ts': { gate: 'assertLegacyIdentityWriterAllowed(' },
  // The operator switch itself: the gate held exclusively.
  'packages/backend/src/scripts/auth-authority.ts': { writes: 3, gate: 'lockAuthorityGateExclusively(' },
  // Per-account password guess counter (#7656): no identity, credential or user
  // id, only rejected-password counts by keyed digest. Fails open in 250 ms, so
  // it must never wait on the authority gate.
  // The fifth write is a give-back replay record in verificationTokens, which the existing cleanup removes.
  'packages/backend/src/auth/password-guess-windows.ts': { writes: 5 },
  // Documented legacy branches of the worker jobs; their staged modes go through the backend.
  'packages/db/src/jobs/system-user.ts': { writes: 1 },
  'packages/location-sync/src/upsert.ts': { writes: 1 },
  // Local fixtures, each refusing a non-loopback or non-development target.
  'packages/backend/src/scripts/seed-instructional-video.ts': { writes: 2 },
  'packages/db/scripts/create-test-user.ts': { writes: 2 },
  'packages/db/scripts/seed-ios-performance.ts': { writes: 1 },
  'packages/db/scripts/seed-social.ts': { writes: 2 },
  'packages/db/src/testing/dedup-replay.ts': { writes: 1 },
};

function countIdentityWrites(source: string): number {
  return IDENTITY_WRITE_PATTERNS.reduce((total, pattern) => total + [...source.matchAll(pattern)].length, 0);
}

const isInIdentityAuthorityRoot = (path: string): boolean =>
  IDENTITY_AUTHORITY_ROOTS.some((root) => path.startsWith(root));

describe('identity writer catalog', () => {
  const identityWriteCounts = new Map(
    trackedSourceFiles
      .filter(
        (path) =>
          isProductionSource(path) &&
          !path.startsWith('packages/web/') &&
          !path.startsWith('packages/mobile/') &&
          // Integration proofs seed fixtures directly; they are tests, not writers.
          !/\.proof\.[cm]?[jt]sx?$/.test(path),
      )
      .map((path) => [path, countIdentityWrites(readRepoFile(path))] as const)
      .filter(([, writes]) => writes > 0),
  );

  it.each([
    ['await tx.insert(users).values(row);'],
    ['await transaction.update(dbSchema.users).set({ email });'],
    ['await transaction\n  .delete(authEmailReservations)\n  .where(condition);'],
    ['await transaction.execute(sql`INSERT INTO users (id, name) VALUES (1, 2)`);'],
    ['sql`DELETE FROM public.mobile_refresh_tokens WHERE user_id = 1`'],
  ])('finds the identity write in %s', (source) => {
    expect(countIdentityWrites(source)).toBe(1);
  });

  it.each([
    ['await db.select().from(users).where(condition);'],
    ['await tx.insert(userProfiles).values(row);'],
    ['await tx.update(sessions).set({ lastActivity });'],
    ['await tx.insert(boardUsers).values(rows);'],
    ['// update users when their profile changes'],
  ])('ignores %s', (source) => {
    expect(countIdentityWrites(source)).toBe(0);
  });

  it('lists every file outside the authority folders that writes an identity table', () => {
    const unreviewed = [...identityWriteCounts.keys()].filter(
      (path) => !isInIdentityAuthorityRoot(path) && !(path in REVIEWED_IDENTITY_WRITERS),
    );
    expect(unreviewed).toEqual([]);
    const stale = Object.keys(REVIEWED_IDENTITY_WRITERS).filter((path) => !identityWriteCounts.has(path));
    expect(stale).toEqual([]);
  });

  it('keeps the reviewed number of writes in each file outside the authority folders', () => {
    const counted = Object.entries(REVIEWED_IDENTITY_WRITERS)
      .filter(([, reviewed]) => reviewed.writes !== undefined)
      .map(([path]) => [path, identityWriteCounts.get(path)]);
    const expected = Object.entries(REVIEWED_IDENTITY_WRITERS)
      .filter(([, reviewed]) => reviewed.writes !== undefined)
      .map(([path, reviewed]) => [path, reviewed.writes]);
    expect(counted).toEqual(expected);
    const uncounted = Object.entries(REVIEWED_IDENTITY_WRITERS).filter(
      ([path, reviewed]) => reviewed.writes === undefined && !isInIdentityAuthorityRoot(path),
    );
    expect(uncounted).toEqual([]);
  });

  it('names every ungated write inside the authority folders where it still lives', () => {
    for (const [path, functions] of Object.entries(UNGATED_AUTHORITY_WRITES)) {
      expect(isInIdentityAuthorityRoot(path)).toBe(true);
      const source = readRepoFile(path);
      for (const name of functions) expect(source).toContain(`function ${name}(`);
    }
  });

  it('keeps each legacy writer behind its gate', () => {
    const ungated = Object.entries(REVIEWED_IDENTITY_WRITERS)
      .filter(([path, reviewed]) => reviewed.gate !== undefined && !readRepoFile(path).includes(reviewed.gate))
      .map(([path]) => path);
    expect(ungated).toEqual([]);
  });
});

const BROWSER_SESSION_MODE_MODULE = `${FIRST_PARTY_AUTHORITY_ROOT}browser-session-mode.ts`;
const BROWSER_SESSION_CHECKER_CALL = /(?<!function\s)\bbrowserSessionModeChecker\s*\(([^)]*)\)/g;

/** Each production call of the startup-check builder, with its argument. */
function browserSessionCheckerCalls(source: string): string[] {
  return [...source.matchAll(BROWSER_SESSION_CHECKER_CALL)].map(([, argument]) => argument.trim());
}

describe('browser session cutover blockers', () => {
  it('finds the builder calls and skips its definition', () => {
    expect(
      browserSessionCheckerCalls(
        'export function browserSessionModeChecker(cutoverBlockers: readonly string[]) {}\n' +
          'const check = browserSessionModeChecker([]);',
      ),
    ).toEqual(['[]']);
  });

  it('lets only tests build the startup check with a list other than BROWSER_SESSION_CUTOVER_BLOCKERS', () => {
    const calls = trackedSourceFiles
      .filter((path) => isProductionSource(path) && !/\.proof\.[cm]?[jt]sx?$/.test(path))
      .flatMap((path) => browserSessionCheckerCalls(readRepoFile(path)).map((argument) => `${path}: ${argument}`));
    expect(calls).toEqual([`${BROWSER_SESSION_MODE_MODULE}: BROWSER_SESSION_CUTOVER_BLOCKERS`]);
  });
});

describe('the browser acceptance cutover seam', () => {
  const VARIABLE = 'BOARDSESH_E2E_BROWSER_SESSION_CUTOVER';
  const CONSTANT = 'E2E_BROWSER_SESSION_CUTOVER_ENV';
  const SEAM_MODULES = [BROWSER_SESSION_MODE_MODULE, 'packages/web/app/lib/auth/browser-session-mode.server.ts'];
  const isTestHarness = (path: string) =>
    path.startsWith('packages/web/e2e/') ||
    path.startsWith('packages/web/auth-proofs/') ||
    /\.proof\.[cm]?[jt]sx?$/.test(path);
  const count = (source: string, needle: string) => source.split(needle).length - 1;

  it('is read in production code by one function per service, and nowhere else', () => {
    const readers = trackedSourceFiles.filter(
      (path) =>
        isProductionSource(path) &&
        !isTestHarness(path) &&
        (readRepoFile(path).includes(VARIABLE) || readRepoFile(path).includes(CONSTANT)),
    );
    expect(readers.sort()).toEqual([...SEAM_MODULES].sort());
    for (const path of SEAM_MODULES) {
      const source = readRepoFile(path);
      const seam = /function cutoverBlockersInEffect\([\s\S]*?\n}\n/.exec(source)?.[0] ?? '';
      // The name once, in its constant; the constant read once, inside the seam.
      expect(count(source, `'${VARIABLE}'`), path).toBe(1);
      expect(count(seam, `[${CONSTANT}]`), path).toBe(1);
      expect(count(source.replace(seam, ''), CONSTANT), path).toBe(1);
    }
  });
});

describe('the browser-session e2e provider stand-ins (#7596 B7c)', () => {
  const VARIABLES = ['BOARDSESH_E2E_GOOGLE_OIDC_WELL_KNOWN', 'BOARDSESH_E2E_APPLE_OIDC_WELL_KNOWN'];
  const MODULE = 'packages/web/app/lib/auth/oidc-stand-in.server.ts';
  const isTestHarness = (path: string) =>
    path.startsWith('packages/web/e2e/') ||
    path.startsWith('packages/web/auth-proofs/') ||
    /\.proof\.[cm]?[jt]sx?$/.test(path);

  it('are named in production code by one module only, which names each once', () => {
    const readers = trackedSourceFiles.filter(
      (path) =>
        isProductionSource(path) &&
        !isTestHarness(path) &&
        VARIABLES.some((variable) => readRepoFile(path).includes(variable)),
    );
    expect(readers).toEqual([MODULE]);
    for (const variable of VARIABLES) expect(readRepoFile(MODULE).split(`'${variable}'`).length - 1).toBe(1);
  });
});
