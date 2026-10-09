import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  PROFILE_APP_ID,
  PROFILE_SCHEME,
  objectRecord,
  requiredString,
  sha256,
  type ProfilePlatform,
} from './mobile-profile-protocol';

export const PROFILE_TEMPLATES = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/mobile-profile');

const localRequire = createRequire(import.meta.url);
const tsxRequire = createRequire(localRequire.resolve('tsx/package.json'));
const sourceTransformer = tsxRequire('esbuild') as {
  transformSync(source: string, options: { loader: string; format: string; sourcefile: string }): { code: string };
};

export interface ProfileOptions {
  mode: 'prepare' | 'capture';
  suite: 'hig-cpu';
  sourceRef: string;
  platform: ProfilePlatform;
  device: string;
  fixtures: string;
  runDir: string;
  checkout: string | null;
  appPath: string | null;
  flow: string | null;
  backendUrl: string;
  controlUrl: string;
  controlBind: string;
  cycles: number;
  warmups: number;
  idleMs: number;
  endSettleMs: number;
  uiDriver: 'maestro' | 'wda';
  wdaUrl: string | null;
}

export interface PreparedProfile {
  diagnosticOnly?: boolean;
  acceptanceEligible?: boolean;
  schemaVersion: 1;
  suite: 'hig-cpu';
  platform: ProfilePlatform;
  device: string;
  sourceRef: string;
  sourceCommit: string;
  sourcePatchSha256: string;
  instrumentationSha256: string;
  fixtureManifestSha256: string;
  fixtureDirectory: string;
  buildId: string;
  checkout: string;
  configuration: 'Release';
  appId: string;
  scheme: string;
  backendUrl: string;
  controlUrl: string;
  createdAt: string;
}

export function parseMobileProfileArgs(argv: readonly string[]): ProfileOptions {
  const args = argv.filter((argument) => argument !== '--');
  const mode = args.shift();
  if (mode !== 'prepare' && mode !== 'capture') throw new Error('Use prepare or capture');
  const flags = new Map<string, string>();
  const allowed = new Set([
    '--suite',
    '--source-ref',
    '--platform',
    '--device',
    '--fixtures',
    '--run-dir',
    '--checkout',
    '--app-path',
    '--flow',
    '--backend-url',
    '--control-url',
    '--control-bind',
    '--cycles',
    '--warmups',
    '--idle-ms',
    '--end-settle-ms',
    '--ui-driver',
    '--wda-url',
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index],
      argument = args[index + 1];
    if (!allowed.has(flag) || !argument || argument.startsWith('--') || flags.has(flag))
      throw new Error(`Invalid profiling argument: ${flag}`);
    flags.set(flag, argument);
  }
  const required = (flag: string) => {
    const argument = flags.get(flag);
    if (!argument) throw new Error(`${flag} is required`);
    return argument;
  };
  const platform = required('--platform');
  if (platform !== 'ios' && platform !== 'android') throw new Error('Use ios or android');
  const device = required('--device');
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(device) || /emulator/i.test(device))
    throw new Error('Select an explicit physical device identifier');
  const cycles = Number(flags.get('--cycles') ?? 10),
    warmups = Number(flags.get('--warmups') ?? 2);
  const idleMs = Number(flags.get('--idle-ms') ?? 10_000);
  const endSettleMs = Number(flags.get('--end-settle-ms') ?? 0);
  const uiDriver = flags.get('--ui-driver') ?? (platform === 'ios' ? 'wda' : 'maestro');
  if (uiDriver !== 'wda' && uiDriver !== 'maestro') throw new Error('Unknown physical UI driver');
  if (platform === 'ios' && uiDriver !== 'wda')
    throw new Error('Official Maestro supports simulators only; physical iOS capture requires the owned WDA driver');
  if (platform === 'android' && uiDriver !== 'maestro') throw new Error('Android physical capture uses Maestro');
  if (
    !Number.isInteger(cycles) ||
    cycles < 1 ||
    cycles > 20 ||
    !Number.isInteger(warmups) ||
    warmups < 0 ||
    warmups > 5 ||
    !Number.isInteger(idleMs) ||
    idleMs < 0 ||
    idleMs > 30_000 ||
    !Number.isInteger(endSettleMs) ||
    endSettleMs < 0 ||
    endSettleMs > 3000
  )
    throw new Error('Invalid bounded cycle/warmup counts');
  if ((flags.get('--suite') ?? 'hig-cpu') !== 'hig-cpu') throw new Error('Unsupported profiling suite');
  const optionalPath = (flag: string) => (flags.has(flag) ? resolve(required(flag)) : null);
  return {
    mode,
    suite: 'hig-cpu',
    platform,
    device,
    sourceRef: required('--source-ref'),
    fixtures: resolve(required('--fixtures')),
    runDir: resolve(required('--run-dir')),
    checkout: optionalPath('--checkout'),
    appPath: optionalPath('--app-path'),
    flow: optionalPath('--flow'),
    backendUrl: required('--backend-url'),
    controlUrl: required('--control-url'),
    controlBind: flags.get('--control-bind') ?? '127.0.0.1',
    cycles,
    warmups,
    idleMs,
    endSettleMs,
    uiDriver,
    wdaUrl: flags.get('--wda-url') ?? null,
  };
}

export function privateAddress(address: string): boolean {
  if (address === '::1') return true;
  if (address.startsWith('::ffff:')) return privateAddress(address.slice(7));
  const bytes = address.split('.').map(Number);
  return (
    isIP(address) === 4 &&
    (bytes[0] === 127 ||
      bytes[0] === 10 ||
      (bytes[0] === 192 && bytes[1] === 168) ||
      (bytes[0] === 172 && bytes[1] >= 16 && bytes[1] <= 31))
  );
}

export async function validateLocalEndpoint(rawUrl: string, protocol: 'http:' | 'ws:'): Promise<URL> {
  const endpoint = new URL(rawUrl);
  if (
    endpoint.protocol !== protocol ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.search ||
    endpoint.pathname !== '/'
  )
    throw new Error('Use an explicit plain local origin without credentials/path/query');
  const hostname = endpoint.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !privateAddress(address)))
    throw new Error('Profiling endpoints must resolve only to RFC1918/loopback addresses');
  return endpoint;
}

export function templateHash(directory = PROFILE_TEMPLATES): string {
  const contents: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else contents.push(`${relative(directory, path)}\0${sha256(readFileSync(path))}`);
    }
  };
  visit(directory);
  return sha256(contents.join('\n') + '\nsource-injection-v3-native-telemetry-exclusion');
}

export function validateProfileFixtures(directory: string): string {
  const bytes = readFileSync(join(directory, 'manifest.json'));
  const manifest = objectRecord(JSON.parse(bytes.toString()) as unknown);
  if (!Array.isArray(manifest.graphql)) throw new Error('Fixture manifest GraphQL entries missing');
  let privacy = 0,
    deletions = 0;
  for (const candidate of manifest.graphql) {
    const entry = objectRecord(candidate);
    if (entry.operationName !== 'PrivacyChanged' && entry.operationName !== 'SyncDeletions') continue;
    const filename = requiredString(entry.file, 'fixture filename');
    const absolute = resolve(directory, filename);
    if (!absolute.startsWith(resolve(directory) + '/')) throw new Error('Fixture path escapes its directory');
    const fixture = objectRecord(JSON.parse(readFileSync(absolute, 'utf8')) as unknown);
    if (
      fixture.operationName !== entry.operationName ||
      fixture.documentHash !== entry.documentHash ||
      fixture.variablesHash !== entry.variablesHash ||
      fixture.status !== 200
    )
      throw new Error('Fixture manifest identity differs from payload');
    const response = objectRecord(fixture.response);
    if ('errors' in response) throw new Error('Profiling fixture response contains errors');
    const responseData = objectRecord(response.data);
    if (entry.operationName === 'PrivacyChanged') {
      if (
        responseData.privacyChanged !== true ||
        typeof fixture.query !== 'string' ||
        !/^\s*subscription\s+PrivacyChanged\b/.test(fixture.query)
      )
        throw new Error('PrivacyChanged must contain the production initial true subscription snapshot');
      privacy += 1;
    } else {
      const result = objectRecord(responseData.syncDeletions);
      const cursor = objectRecord(result.cursor);
      if (
        !Array.isArray(result.deletions) ||
        typeof result.hasMore !== 'boolean' ||
        typeof cursor.updatedAt !== 'string' ||
        typeof cursor.syncSeq !== 'string'
      )
        throw new Error('Invalid SyncDeletions response contract');
      deletions += 1;
    }
  }
  if (privacy === 0 || deletions === 0)
    throw new Error('Explicit PrivacyChanged initial signal and SyncDeletions fixtures are required');
  return sha256(bytes);
}

export function injectProfileTemplates(checkout: string): void {
  const mobile = join(checkout, 'packages/mobile');
  for (const nativeDirectory of ['ios', 'android'])
    if (existsSync(join(mobile, nativeDirectory)))
      throw new Error('Use a fresh profiling checkout without generated native projects');
  const originalConfig = join(mobile, 'app.config.ts');
  if (
    existsSync(join(mobile, 'app.config.profile-original.ts')) ||
    existsSync(join(mobile, 'modules/mobile-cpu-profile'))
  )
    throw new Error('Profiling templates are already injected');
  cpSync(join(PROFILE_TEMPLATES, 'native'), join(mobile, 'modules/mobile-cpu-profile'), { recursive: true });
  renameSync(
    join(mobile, 'modules/mobile-cpu-profile/src/index.ts.template'),
    join(mobile, 'modules/mobile-cpu-profile/src/index.ts'),
  );
  const bridge = join(mobile, 'src/lib/profiling/mobile-cpu-profile.ts');
  mkdirSync(dirname(bridge), { recursive: true });
  cpSync(join(PROFILE_TEMPLATES, 'mobile-cpu-profile.ts.template'), bridge);
  cpSync(join(PROFILE_TEMPLATES, 'with-mobile-profile.cjs'), join(mobile, 'plugins/with-mobile-profile.cjs'));
  renameSync(originalConfig, join(mobile, 'app.config.profile-original.ts'));
  const originalSource = readFileSync(join(mobile, 'app.config.profile-original.ts'), 'utf8');
  const compiledOriginal = sourceTransformer.transformSync(originalSource, {
    loader: 'ts',
    format: 'cjs',
    sourcefile: 'app.config.profile-original.ts',
  }).code;
  writeFileSync(join(mobile, 'app.config.profile-original.cjs'), compiledOriginal);
  cpSync(join(PROFILE_TEMPLATES, 'app.config.ts.template'), originalConfig);
  const rootLayout = join(mobile, 'app/_layout.tsx');
  const rootSource = readFileSync(rootLayout, 'utf8');
  if (!rootSource.includes("import { ObserveRoot } from 'expo-observe';"))
    throw new Error('Profiling ObserveRoot import contract changed; review the new source before injection');
  cpSync(join(PROFILE_TEMPLATES, 'observe-root.tsx.template'), join(mobile, 'src/lib/profiling/observe-root.tsx'));
  cpSync(join(PROFILE_TEMPLATES, 'observe-bootstrap.ts.template'), join(mobile, 'src/lib/observe-bootstrap.ts'));
  writeFileSync(
    rootLayout,
    `import '../src/lib/profiling/mobile-cpu-profile';\n${rootSource.replace(
      "import { ObserveRoot } from 'expo-observe';",
      "import { ObserveRoot } from '../src/lib/profiling/observe-root';",
    )}`,
  );
  const packagePath = join(mobile, 'package.json');
  const packageConfiguration = objectRecord(JSON.parse(readFileSync(packagePath, 'utf8')) as unknown);
  const expoConfiguration = packageConfiguration.expo ? objectRecord(packageConfiguration.expo) : {};
  const autolinking = expoConfiguration.autolinking ? objectRecord(expoConfiguration.autolinking) : {};
  const excludedTelemetry = ['expo-observe', 'expo-app-metrics'];
  const isolateOptions = (options: Record<string, unknown>): Record<string, unknown> => ({
    ...options,
    exclude: [...new Set([...(Array.isArray(options.exclude) ? options.exclude : []), ...excludedTelemetry])],
    ...(Array.isArray(options.buildFromSource)
      ? {
          buildFromSource: options.buildFromSource.filter((name) => !excludedTelemetry.includes(String(name))),
        }
      : {}),
  });
  const isolatedAutolinking = isolateOptions(autolinking);
  for (const platform of ['ios', 'apple', 'android'])
    if (autolinking[platform]) isolatedAutolinking[platform] = isolateOptions(objectRecord(autolinking[platform]));
  packageConfiguration.expo = { ...expoConfiguration, autolinking: isolatedAutolinking };
  writeFileSync(packagePath, JSON.stringify(packageConfiguration, null, 2) + '\n');
  for (const filename of ['SharedConstants.swift', 'SharedKeychain.swift']) {
    const path = join(mobile, 'modules/live-activity/ios', filename);
    if (existsSync(path))
      writeFileSync(
        path,
        readFileSync(path, 'utf8').replace(/com\.boardsesh\.app(?!\.perf)/g, 'com.boardsesh.app.perf'),
      );
  }
  const targets = join(mobile, 'targets');
  const namespaceTargets = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) namespaceTargets(path);
      else if (/\.(swift|js|plist|entitlements)$/.test(entry.name))
        writeFileSync(
          path,
          readFileSync(path, 'utf8').replace(/com\.boardsesh\.app(?!\.perf)/g, 'com.boardsesh.app.perf'),
        );
    }
  };
  if (existsSync(targets)) namespaceTargets(targets);
}

export async function prepareProfile(options: ProfileOptions, root: string): Promise<PreparedProfile> {
  if (existsSync(join(options.runDir, 'prepare.json')))
    throw new Error('Run directory already contains a prepared profile');
  await validateLocalEndpoint(options.backendUrl, 'http:');
  await validateLocalEndpoint(options.controlUrl, 'ws:');
  const fixtureManifestSha256 = validateProfileFixtures(options.fixtures);
  const fixtureManifest = objectRecord(
    JSON.parse(readFileSync(join(options.fixtures, 'manifest.json'), 'utf8')) as unknown,
  );
  const fixtureCapture = fixtureManifest.capture ? objectRecord(fixtureManifest.capture) : null;
  const accountEmail = requiredString(fixtureManifest.accountEmail, 'fixture account email');
  const frozenNow = requiredString(fixtureManifest.frozenNow, 'fixture frozen clock');
  if (!Number.isFinite(Date.parse(frozenNow)) || !accountEmail.includes('@'))
    throw new Error('Fixture replay account/frozen clock metadata invalid');
  const git = (args: string[], cwd = root) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: args[0] === 'worktree' && args[1] === 'add' ? 600_000 : 30_000,
    }).trim();
  const sourceCommit = git(['rev-parse', `${options.sourceRef}^{commit}`]);
  const checkout = options.checkout ?? join(options.runDir, 'source');
  mkdirSync(options.runDir, { recursive: true });
  if (!options.checkout) git(['worktree', 'add', '--detach', checkout, sourceCommit]);
  const actualCheckout = realpathSync(checkout);
  const primaryWorktree = git(['worktree', 'list', '--porcelain'])
    .split('\n')
    .find((line) => line.startsWith('worktree '))
    ?.slice(9);
  const gitDirectory = git(['rev-parse', '--absolute-git-dir'], checkout);
  const commonDirectory = resolve(checkout, git(['rev-parse', '--git-common-dir'], checkout));
  const rootCommonDirectory = resolve(root, git(['rev-parse', '--git-common-dir']));
  if (
    actualCheckout === realpathSync(root) ||
    (primaryWorktree && actualCheckout === realpathSync(primaryWorktree)) ||
    realpathSync(gitDirectory) === realpathSync(commonDirectory) ||
    realpathSync(commonDirectory) !== realpathSync(rootCommonDirectory) ||
    git(['rev-parse', '--abbrev-ref', 'HEAD'], checkout) !== 'HEAD' ||
    !actualCheckout.startsWith(realpathSync(options.runDir) + '/')
  )
    throw new Error('Refusing instrumentation in the execution/primary checkout; use a dedicated linked worktree');
  if (git(['rev-parse', 'HEAD'], checkout) !== sourceCommit || git(['status', '--porcelain'], checkout))
    throw new Error('Dedicated checkout must be clean and match the requested source ref');
  const sourcePatchSha256 = sha256(git(['diff', '--binary', 'HEAD'], checkout));
  const instrumentationSha256 = templateHash();
  const buildId = sha256(
    JSON.stringify({
      sourceCommit,
      sourcePatchSha256,
      instrumentationSha256,
      fixtureManifestSha256,
      platform: options.platform,
      backend: options.backendUrl,
      control: options.controlUrl,
    }),
  );
  injectProfileTemplates(checkout);
  const prepared: PreparedProfile = {
    schemaVersion: 1,
    suite: 'hig-cpu',
    platform: options.platform,
    device: options.device,
    sourceRef: options.sourceRef,
    sourceCommit,
    sourcePatchSha256,
    instrumentationSha256,
    fixtureManifestSha256,
    fixtureDirectory: options.fixtures,
    buildId,
    checkout,
    configuration: 'Release',
    appId: PROFILE_APP_ID,
    scheme: PROFILE_SCHEME,
    backendUrl: options.backendUrl,
    controlUrl: options.controlUrl,
    createdAt: new Date().toISOString(),
  };
  const env = {
    BOARDSESH_PROFILE_BUILD: '1',
    BOARDSESH_PROFILE_SOURCE_DIR: checkout,
    EXPO_PUBLIC_PROFILE_STARTUP: '1',
    EXPO_PUBLIC_MOBILE_PROFILE_BUILD: '1',
    EXPO_PUBLIC_MOBILE_PROFILE_CONTROL_URL: options.controlUrl,
    EXPO_PUBLIC_MOBILE_PROFILE_TOKEN: randomUUID(),
    EXPO_PUBLIC_MOBILE_PROFILE_BUILD_ID: buildId,
    EXPO_PUBLIC_MOBILE_PROFILE_SOURCE_COMMIT: sourceCommit,
    EXPO_PUBLIC_MOBILE_PROFILE_INSTRUMENTATION_SHA256: instrumentationSha256,
    EXPO_PUBLIC_MOBILE_PROFILE_FIXTURE_SHA256: fixtureManifestSha256,
    EXPO_PUBLIC_BACKEND_URL: options.backendUrl,
    EXPO_PUBLIC_WS_URL: `${options.backendUrl.replace(/^http:/, 'ws:').replace(/\/$/, '')}/graphql`,
    EXPO_PUBLIC_SCREENSHOT_MODE: '1',
    EXPO_PUBLIC_SCREENSHOT_THEME: 'dark',
    EXPO_PUBLIC_SCREENSHOT_LOCALE: 'en-US',
    SENTRY_DISABLE_AUTO_UPLOAD: 'true',
    EXPO_NO_DOTENV: '1',
    EXPO_PUBLIC_SENTRY_DSN: '',
    EXPO_PUBLIC_POSTHOG_KEY: '',
    EXPO_PUBLIC_POSTHOG_HOST: '',
    EXPO_UPDATES_URL: '',
    SENTRY_AUTH_TOKEN: '',
    // Expo disables requested Metro --reset-cache in CI mode; public-env transforms can then reuse another build's identity.
    CI: '0',
    EXTRA_PACKAGER_ARGS: '--reset-cache',
  };
  const fixtureEnv: Record<string, string> = {
    EXPO_PUBLIC_SCREENSHOT_USER_EMAIL: accountEmail,
    EXPO_PUBLIC_SCREENSHOT_USER_PASSWORD: 'local-replay-only',
    EXPO_PUBLIC_SCREENSHOT_NOW: frozenNow,
  };
  if (Array.isArray(fixtureCapture?.boards) && fixtureCapture.boards.every((board) => typeof board === 'string'))
    fixtureEnv.EXPO_PUBLIC_SCREENSHOT_BOARDS = fixtureCapture.boards.join('|');
  writeFileSync(join(options.runDir, 'prepare.json'), JSON.stringify(prepared, null, 2) + '\n');
  writeFileSync(join(options.runDir, 'build-env.json'), JSON.stringify({ ...env, ...fixtureEnv }, null, 2) + '\n', {
    mode: 0o600,
  });
  writeFileSync(join(options.runDir, 'instrumentation.patch'), git(['diff', '--binary', 'HEAD'], checkout) + '\n');
  writeFileSync(
    join(options.runDir, 'build-handoff.json'),
    JSON.stringify(
      {
        checkout,
        platform: options.platform,
        configuration: 'Release',
        appId: PROFILE_APP_ID,
        scheme: PROFILE_SCHEME,
        nativeProjectGenerated: false,
        sharedBuildLockRequired: true,
        next: 'Load build-env.json, install dependencies with vp install, prebuild and sign this isolated source using the owned native build wrapper. Do not reuse the Debug/dev-client installer or clear app data.',
        localNativeIdentitySubstitutions: [
          'live-activity/ios/SharedConstants.swift app group and Darwin notification namespace',
          'live-activity/ios/SharedKeychain.swift keychain suffix',
          'targets widget namespace',
          'Expo autolinking excludes expo-observe and expo-app-metrics on both platforms',
          'Observe bootstrap is unregistered and ObserveRoot hostless wrapper preserves default host geometry',
        ],
      },
      null,
      2,
    ) + '\n',
  );
  return prepared;
}
