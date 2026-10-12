/// <reference types="node" />
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  AppleDevBuildClient,
  IOS_DEV_BUNDLE_ID,
  IOS_DEV_RELEASE_PREFIX,
  isReadyDevBuild,
  isReusableDevBuild,
  parseDevBaseline,
  type IosDevBaseline,
} from './lib/ios-dev-testflight';
import { runCapture } from './lib/exec';
import { parseResolverOutput } from './lib/mobile-runtime-version';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function githubOutput(name: string, contents: string): void {
  if (contents.includes('\n') || contents.includes('\r')) throw new Error(`Invalid output ${name}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${contents}\n`);
}

function command(commandName: string, args: string[], cwd = ROOT): string {
  const result = runCapture(commandName, args, { cwd, env: process.env });
  if (result.status !== 0) throw new Error(`${commandName} ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

async function gate(): Promise<void> {
  const fingerprint = parseResolverOutput(
    command(
      'vp',
      ['exec', 'expo-updates', 'runtimeversion:resolve', '--platform', 'ios'],
      join(ROOT, 'packages/mobile'),
    ),
  ).runtimeVersion;
  if (typeof fingerprint !== 'string' || !/^[0-9a-f]{40}$/i.test(fingerprint))
    throw new Error('Invalid iOS Dev fingerprint');
  githubOutput('fingerprint', fingerprint);
  const apple = new AppleDevBuildClient(process.env);
  const appId = await apple.appId();
  githubOutput('app_id', appId);

  const force = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && process.env.FORCE_NATIVE !== 'false';
  const releases = JSON.parse(
    command('gh', [
      'api',
      'repos/{owner}/{repo}/releases?per_page=100',
      '--paginate',
      '--slurp',
      '--jq',
      '[.[][] | select(.draft == false) | {tag_name, published_at}] | sort_by(.published_at) | reverse',
    ]),
  ) as Array<{ tag_name: string }>;
  const release = releases.find(({ tag_name }) => tag_name.startsWith(IOS_DEV_RELEASE_PREFIX));
  let shouldBuild = true;
  if (!force && release) {
    const downloadDirectory = mkdtempSync(join(tmpdir(), 'boardsesh-ios-dev-'));
    try {
      command('gh', [
        'release',
        'download',
        release.tag_name,
        '--pattern',
        'ios-dev-build.json',
        '--dir',
        downloadDirectory,
      ]);
      const baseline = parseDevBaseline(readFileSync(join(downloadDirectory, 'ios-dev-build.json'), 'utf8'));
      if (baseline.appId !== appId) throw new Error('iOS Dev baseline names a different App Store Connect app');
      const build = await apple.build(appId, baseline.buildNumber, baseline.version);
      shouldBuild = !build || !isReusableDevBuild(baseline, fingerprint, build);
    } finally {
      rmSync(downloadDirectory, { recursive: true, force: true });
    }
  }
  githubOutput('should_build', String(shouldBuild));
  console.log(
    shouldBuild
      ? 'Build iOS Dev: native change, renewal, first build, or manual request.'
      : 'Reuse iOS Dev; load current JavaScript from Metro.',
  );
}

async function waitForProcessing(): Promise<void> {
  const buildNumber = process.env.IOS_DEV_BUILD_NUMBER;
  const version = process.env.BOARDSESH_MOBILE_VERSION;
  const fingerprint = process.env.IOS_DEV_FINGERPRINT;
  const metadataPath = process.env.IOS_DEV_METADATA_PATH;
  if (!buildNumber || !version || !fingerprint || !metadataPath || !/^[0-9a-f]{40}$/i.test(fingerprint)) {
    throw new Error('Missing build identity, fingerprint, or metadata output path');
  }
  const apple = new AppleDevBuildClient(process.env);
  const appId = await apple.appId();
  const deadline = Date.now() + 45 * 60 * 1000;
  while (Date.now() < deadline) {
    const build = await apple.build(appId, buildNumber, version);
    if (build && ['FAILED', 'INVALID'].includes(build.processingState)) {
      throw new Error(`Apple rejected iOS Dev build ${version} (${buildNumber}): ${build.processingState}`);
    }
    if (build?.processingState === 'VALID' && build.buildAudienceType !== 'INTERNAL_ONLY') {
      throw new Error('Refusing to publish baseline: build is not TestFlight Internal Only');
    }
    if (build && isReadyDevBuild(build)) {
      const baseline: IosDevBaseline = {
        bundleId: IOS_DEV_BUNDLE_ID,
        fingerprint,
        commit: command('git', ['rev-parse', 'HEAD']),
        appId,
        buildId: build.id,
        buildNumber,
        version,
      };
      writeFileSync(metadataPath, `${JSON.stringify(baseline, null, 2)}\n`);
      console.log(`iOS Dev ${version} (${buildNumber}) is ready for internal TestFlight testing.`);
      return;
    }
    console.log(`Waiting for Apple: ${build?.internalBuildState || build?.processingState || 'build not visible yet'}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 30_000));
  }
  throw new Error('Apple processing did not finish within 45 minutes; no reusable baseline was published');
}

function writeBuildEnvironment(): void {
  const mobileEnvironment = join(ROOT, 'packages/mobile/.env');
  if (existsSync(mobileEnvironment) && process.env.CI !== 'true') {
    throw new Error('Refusing to overwrite a local mobile .env; this command is for disposable CI checkouts');
  }
  const names = [
    'EXPO_PUBLIC_BACKEND_URL',
    'EXPO_PUBLIC_WS_URL',
    'EXPO_PUBLIC_WEB_URL',
    'EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID',
    'EXPO_PUBLIC_GOOGLE_IOS_DEV_CLIENT_ID',
    'EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID',
    'EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID',
    'EXPO_PUBLIC_SENTRY_DSN',
    'EXPO_PUBLIC_POSTHOG_KEY',
    'EXPO_PUBLIC_USE_RN_FETCH',
  ];
  writeFileSync(mobileEnvironment, names.map((name) => `${name}=${process.env[name] ?? ''}\n`).join(''));
}

export async function main(): Promise<void> {
  switch (process.argv[2]) {
    case 'env':
      writeBuildEnvironment();
      break;
    case 'gate':
      await gate();
      break;
    case 'wait':
      await waitForProcessing();
      break;
    default:
      throw new Error('Usage: mobile-ios-dev-testflight.ts env|gate|wait');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
