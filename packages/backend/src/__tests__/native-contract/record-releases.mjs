import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'vite-plus';

const fixtureDirectory = fileURLToPath(new URL('./fixtures/', import.meta.url));
const versions = new Set(['2.2.0', '2.2.1', '2.2.2', '2.3.0', '2.3.1', '2.4.0', '2.5.0', '2.6.0', '2.7.0']);
const git = (...arguments_) =>
  execFileSync('git', arguments_, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const sourceCache = new Map();
const blobs = new Map();
const digest = (source) => createHash('sha256').update(source).digest('hex');
const boundaryPaths = [
  '/privacy/privacy-cache.ts',
  '/error-reporting.ts',
  '/connectivity/connectivity-store.ts',
  '/consent-state.ts',
  '/analytics.ts',
];
const seeds = ['auth.ts', 'auth-interceptor.ts', 'auth-store.ts', 'auth-session.ts'];
const callbackNames = new Set([
  'resetAnalyticsForSignedOutTransition',
  'clearPersistedUserStores',
  'clearLocalOfflineUserData',
  'runSignedOutCleanup',
  'handleSignedOutTransition',
  'checkAuth',
]);
function read(ref, path) {
  const key = `${ref}:${path}`;
  if (!sourceCache.has(key)) {
    try {
      sourceCache.set(key, git('show', key));
    } catch {
      sourceCache.set(key, null);
    }
  }
  return sourceCache.get(key);
}
function record(ref, path, modules) {
  const source = read(ref, path);
  if (source === null) return null;
  const sha256 = digest(source);
  blobs.set(sha256, source);
  modules[path] = { sha256, gitBlob: git('rev-parse', `${ref}:${path}`).trim() };
  return source;
}
function resolve(ref, from, specifier) {
  if (specifier === '@boardsesh/analytics') return 'packages/shared/analytics/src/account-creation.ts';
  if (specifier === '@boardsesh/shared-schema/client-identity') return 'packages/shared-schema/src/client-identity.ts';
  if (!specifier.startsWith('.')) return null;
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((path) => read(ref, path) !== null) ?? null;
}
function captureGraph(ref, path, modules, visiting = new Set()) {
  if (visiting.has(path)) return;
  visiting.add(path);
  const source = record(ref, path, modules);
  if (source === null || boundaryPaths.some((suffix) => path.endsWith(suffix))) return;
  const parsed = parseSync(path, source);
  if (parsed.errors.length) throw new Error('Released source did not parse');
  for (const node of parsed.program.body) {
    if (
      node.type !== 'ImportDeclaration' &&
      node.type !== 'ExportNamedDeclaration' &&
      node.type !== 'ExportAllDeclaration'
    )
      continue;
    if (!node.source || node.importKind === 'type' || node.exportKind === 'type') continue;
    const next = resolve(ref, path, node.source.value);
    if (next) captureGraph(ref, next, modules, visiting);
  }
}
function providerEvidence(ref, modules) {
  const path = 'packages/mobile/src/providers/auth-provider.tsx';
  const source = record(ref, path, modules);
  const parsed = parseSync(path, source);
  const declaration = parsed.program.body.find(
    (node) =>
      node.type === 'ExportNamedDeclaration' &&
      node.declaration?.type === 'FunctionDeclaration' &&
      node.declaration.id?.name === 'AuthProvider',
  )?.declaration;
  const callbacks = {};
  for (const statement of declaration?.body?.body ?? []) {
    if (statement.type !== 'VariableDeclaration') continue;
    for (const variable of statement.declarations) {
      if (variable.id.type === 'Identifier' && callbackNames.has(variable.id.name)) {
        callbacks[variable.id.name] = { start: statement.start, end: statement.end };
      }
    }
  }
  const connectionPath = 'packages/mobile/src/db/connection.ts';
  const connection = record(ref, connectionPath, modules);
  const connectionAst = parseSync(connectionPath, connection);
  let clearFunction;
  let clearTables;
  for (const node of connectionAst.program.body) {
    if (
      node.type === 'ExportNamedDeclaration' &&
      node.declaration?.type === 'FunctionDeclaration' &&
      node.declaration.id?.name === 'clearUserData'
    )
      clearFunction = { start: node.start, end: node.end };
    if (
      node.type === 'VariableDeclaration' &&
      node.declarations.some((item) => item.id?.name === 'USER_DATA_TABLES_TO_CLEAR')
    )
      clearTables = { start: node.start, end: node.end };
  }
  let checkpointPath;
  let clearCheckpointFunction;
  if (/-v2\.2\./.test(ref)) {
    checkpointPath = [
      'packages/shared/offline-sync/src/sync/checkpoints.ts',
      'packages/mobile/src/sync/checkpoints.ts',
    ].find((candidate) => read(ref, candidate) !== null);
    if (!checkpointPath) throw new Error('Frozen checkpoint module missing');
    captureGraph(ref, checkpointPath, modules);
    const checkpointSource = read(ref, checkpointPath);
    const checkpointAst = parseSync(checkpointPath, checkpointSource);
    const checkpointDeclaration = checkpointAst.program.body.find(
      (node) =>
        node.type === 'ExportNamedDeclaration' &&
        node.declaration?.type === 'FunctionDeclaration' &&
        node.declaration.id?.name === 'deleteUserCheckpoints',
    );
    if (!checkpointDeclaration) throw new Error('Frozen checkpoint cleanup function missing');
    clearCheckpointFunction = { start: checkpointDeclaration.start, end: checkpointDeclaration.end };
  }
  return {
    providerPath: path,
    callbacks,
    connectionPath,
    clearFunction,
    clearTables,
    checkpointPath,
    clearCheckpointFunction,
  };
}
const releases = git('tag', '-l', 'release/*')
  .trim()
  .split('\n')
  .flatMap((tag) => {
    const match = /^release\/(android|ios)-v(\d+\.\d+\.\d+)-([a-f0-9]+)$/.exec(tag);
    if (!match || !versions.has(match[2])) return [];
    const modules = {};
    for (const seed of seeds) captureGraph(tag, `packages/mobile/src/lib/${seed}`, modules);
    record(tag, 'packages/mobile/src/hooks/use-native-oauth-sign-in.ts', modules);
    const evidence = providerEvidence(tag, modules);
    if (match[2].startsWith('2.2.') && Object.keys(evidence.callbacks).length !== callbackNames.size)
      throw new Error('Legacy provider callback coverage incomplete');
    return [
      {
        tag,
        platform: match[1],
        version: match[2],
        commit: git('rev-parse', `${tag}^{commit}`).trim(),
        modules,
        evidence,
      },
    ];
  });
if (
  releases.filter((release) => release.platform === 'android').length !== 11 ||
  releases.filter((release) => release.platform === 'ios').length !== 9
)
  throw new Error('Supported release inventory changed; review it explicitly');
const garmin = [
  {
    name: 'main-before-g2',
    commit: 'fdb54642eff996c364b43e903488d1578e04174b',
    paths: [
      'net/BsClient.mc',
      'net/BsEndpoints.mc',
      'auth/TokenStore.mc',
      'state/TickQueue.mc',
      'views/PairingView.mc',
      'views/LoadingView.mc',
    ],
  },
  {
    name: 'g2-reviewed',
    commit: '73e85b88102caeed139f5df8ee0db3517f227cd4',
    paths: [
      'net/BsClient.mc',
      'net/BsEndpoints.mc',
      'auth/TokenStore.mc',
      'auth/AuthState.mc',
      'state/TickQueue.mc',
      'views/PairingView.mc',
      'views/LoadingView.mc',
    ],
  },
].map(({ name, commit, paths }) => {
  const modules = {};
  for (const path of paths) record(commit, `garmin/source/${path}`, modules);
  return { name, commit: git('rev-parse', `${commit}^{commit}`).trim(), modules };
});
mkdirSync(`${fixtureDirectory}/sources`, { recursive: true });
for (const [sha256, source] of blobs) writeFileSync(`${fixtureDirectory}/sources/${sha256}.txt`, source);
writeFileSync(
  `${fixtureDirectory}/releases.json`,
  JSON.stringify(
    { version: 1, evidence: 'git-source-only; installs and OTA coverage unproven', releases, garmin },
    null,
    2,
  ) + '\n',
);
console.log(
  `Recorded ${releases.length} released tag sources, ${garmin.length} Garmin sources, ${blobs.size} unique blobs`,
);
