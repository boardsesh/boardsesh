/// <reference types="node" />

/**
 * Run the Android login-freeze probe on real devices via AWS Device Farm.
 *
 * Why this exists: the Android-16 cold-start touch-freeze (Pixel 9/10, Galaxy
 * S24/S25) can't be reproduced on any in-house device, so fixes used to need slow
 * external-contributor round-trips. This uploads the DIAGNOSTIC APK
 * (com.boardsesh.app.dev, EXPO_PUBLIC_FREEZE_DEBUG=1 — the real login screen, not
 * the auto-sign-in screenshot build) to Device Farm and runs a Maestro
 * touch-liveness flow on the affected hardware. A frozen hit-region fails the
 * probe (an injected tap goes through the same Android input path as a human tap),
 * so the run result is the verdict: FAILED = freeze reproduced, PASSED = touch
 * alive / fix verified.
 *
 * Usage:
 *   vp run mobile:device-farm -- --app-path <path/to/app.apk> [--name <run name>]
 *                                [--flow <path/to/flow.yaml>] [--recreate-pool] [--keep]
 *
 * Credentials: read from ~/.config/boardsesh/aws-device-farm.env (AWS_ACCESS_KEY_ID
 * / AWS_SECRET_ACCESS_KEY), else from the ambient AWS_* env. Device Farm's API is
 * us-west-2 only. Project + device pool are resolved by name (created if missing)
 * from packages/mobile/device-farm/config.json.
 *
 * Exit code: 0 = run PASSED (touch alive), 2 = run FAILED (frozen / assertion
 * failed), 1 = infra/setup error.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CreateDevicePoolCommand,
  CreateProjectCommand,
  CreateUploadCommand,
  DeviceFarmClient,
  GetRunCommand,
  GetUploadCommand,
  ListArtifactsCommand,
  ListDevicePoolsCommand,
  ListJobsCommand,
  ListProjectsCommand,
  ScheduleRunCommand,
  type ArtifactCategory,
  type UploadType,
} from '@aws-sdk/client-device-farm';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MOBILE_DIR = resolve(ROOT_DIR, 'packages', 'mobile');
const DF_DIR = resolve(MOBILE_DIR, 'device-farm');
const CONFIG_PATH = resolve(DF_DIR, 'config.json');
const TESTSPEC_PATH = resolve(DF_DIR, 'testspec.yml');
const DEFAULT_FLOW_PATH = resolve(MOBILE_DIR, '.maestro', 'login-freeze-android.yaml');
const CREDS_ENV_PATH = resolve(homedir(), '.config', 'boardsesh', 'aws-device-farm.env');
const RUNS_DIR = resolve(DF_DIR, 'runs');
const LOG = '[mobile:device-farm]';

interface DeviceFarmConfig {
  region: string;
  projectName: string;
  devicePoolName: string;
  appPackageId: string;
  devices: { name: string; os: string; arn: string }[];
}

interface CliArgs {
  appPath?: string;
  flowPath: string;
  runName?: string;
  recreatePool: boolean;
  keep: boolean;
}

function fail(message: string): never {
  console.error(`${LOG} ERROR: ${message}`);
  process.exit(1);
}

function log(message: string): void {
  console.log(`${LOG} ${message}`);
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

// Load AWS creds from the stashed env file into process.env (without clobbering
// an explicitly-set ambient value), so the SDK's default provider chain finds
// them. The file is the one written from 1Password by the operator.
function loadCredentials(): void {
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    log('using ambient AWS_* credentials');
    return;
  }
  if (!existsSync(CREDS_ENV_PATH)) {
    fail(
      `no AWS credentials: set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, or create ${CREDS_ENV_PATH} ` +
        `(AWS_ACCESS_KEY_ID=…\\nAWS_SECRET_ACCESS_KEY=…).`,
    );
  }
  for (const rawLine of readFileSync(CREDS_ENV_PATH, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
  log(`loaded credentials from ${CREDS_ENV_PATH}`);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { flowPath: DEFAULT_FLOW_PATH, recreatePool: false, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      // vp forwards a literal `--` into argv; skip it rather than treat it as a flag.
      case '--':
        break;
      case '--app-path':
        args.appPath = argv[(index += 1)];
        break;
      case '--flow':
        args.flowPath = resolve(argv[(index += 1)]);
        break;
      case '--name':
        args.runName = argv[(index += 1)];
        break;
      case '--recreate-pool':
        args.recreatePool = true;
        break;
      case '--keep':
        args.keep = true;
        break;
      default:
        if (token.startsWith('--')) fail(`unknown flag: ${token}`);
    }
  }
  return args;
}

function loadConfig(): DeviceFarmConfig {
  if (!existsSync(CONFIG_PATH)) fail(`missing config: ${CONFIG_PATH}`);
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as DeviceFarmConfig;
}

async function ensureProject(client: DeviceFarmClient, name: string): Promise<string> {
  const { projects } = await client.send(new ListProjectsCommand({}));
  const existing = projects?.find((project) => project.name === name);
  if (existing?.arn) {
    log(`project "${name}" → ${existing.arn}`);
    return existing.arn;
  }
  const { project } = await client.send(new CreateProjectCommand({ name }));
  if (!project?.arn) fail('create-project returned no ARN');
  log(`created project "${name}" → ${project.arn}`);
  return project.arn;
}

async function ensureDevicePool(
  client: DeviceFarmClient,
  projectArn: string,
  config: DeviceFarmConfig,
  recreate: boolean,
): Promise<string> {
  const { devicePools } = await client.send(new ListDevicePoolsCommand({ arn: projectArn }));
  const existing = devicePools?.find((pool) => pool.name === config.devicePoolName);
  if (existing?.arn && !recreate) {
    log(`device pool "${config.devicePoolName}" → ${existing.arn}`);
    return existing.arn;
  }
  // ARN-IN rule pins the exact affected devices; value is a JSON-encoded ARN list.
  const rules = [
    {
      attribute: 'ARN' as const,
      operator: 'IN' as const,
      value: JSON.stringify(config.devices.map((device) => device.arn)),
    },
  ];
  const { devicePool } = await client.send(
    new CreateDevicePoolCommand({
      projectArn,
      name: recreate ? `${config.devicePoolName}-${Date.now()}` : config.devicePoolName,
      rules,
    }),
  );
  if (!devicePool?.arn) fail('create-device-pool returned no ARN');
  log(`created device pool → ${devicePool.arn} (${config.devices.map((device) => device.name).join(', ')})`);
  return devicePool.arn;
}

// Device Farm needs a "test package" upload even for a custom test spec. We run
// Maestro (not Appium) in the spec, but the package must validate as an
// Appium-Node zip: a package.json + a node_modules dir at the root. We add the
// Maestro flow alongside; the spec runs it from $DEVICEFARM_TEST_PACKAGE_PATH.
function buildTestPackageZip(flowPath: string, keep: boolean): string {
  if (!existsSync(flowPath)) fail(`flow not found: ${flowPath}`);
  const stageDir = mkdtempSync(join(tmpdir(), 'bs-df-pkg-'));
  writeFileSync(
    join(stageDir, 'package.json'),
    `${JSON.stringify({ name: 'boardsesh-maestro', version: '1.0.0', private: true, dependencies: {} }, null, 2)}\n`,
  );
  // Minimal node_modules so the APPIUM_NODE upload validates.
  mkdirSync(join(stageDir, 'node_modules'), { recursive: true });
  writeFileSync(join(stageDir, 'node_modules', '.package-lock.json'), '{"lockfileVersion":3,"requires":true}\n');
  // The flow at the package root → $DEVICEFARM_TEST_PACKAGE_PATH/<flow basename>.
  writeFileSync(join(stageDir, basename(flowPath)), readFileSync(flowPath, 'utf8'));

  const zipPath = join(stageDir, '..', `bs-df-testpkg-${basename(stageDir)}.zip`);
  const zip = spawnSync('zip', ['-r', '-q', zipPath, '.'], { cwd: stageDir });
  if (zip.status !== 0) fail(`zip failed: ${zip.stderr?.toString() ?? 'unknown error'}`);
  if (!keep) process.on('exit', () => rmSync(stageDir, { recursive: true, force: true }));
  log(`built test package: ${zipPath}`);
  return zipPath;
}

async function uploadFile(
  client: DeviceFarmClient,
  projectArn: string,
  type: UploadType,
  filePath: string,
  name: string,
): Promise<string> {
  if (!existsSync(filePath)) fail(`upload source missing: ${filePath}`);
  const { upload } = await client.send(
    new CreateUploadCommand({ projectArn, name, type, contentType: 'application/octet-stream' }),
  );
  if (!upload?.arn || !upload.url) fail(`create-upload (${type}) returned no ARN/url`);

  const body = readFileSync(filePath);
  const put = await fetch(upload.url, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body,
  });
  if (!put.ok) fail(`S3 PUT for ${name} failed: ${put.status} ${put.statusText}`);

  // Device Farm processes the upload (validates structure). Poll until terminal.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const { upload: state } = await client.send(new GetUploadCommand({ arn: upload.arn }));
    if (state?.status === 'SUCCEEDED') {
      log(`uploaded ${type}: ${name}`);
      return upload.arn;
    }
    if (state?.status === 'FAILED') {
      fail(`upload ${name} (${type}) FAILED: ${state.metadata ?? 'no detail'}`);
    }
    await sleep(2000);
  }
  fail(`upload ${name} (${type}) did not finish processing in time`);
}

async function scheduleAndAwaitRun(
  client: DeviceFarmClient,
  options: {
    projectArn: string;
    appArn: string;
    devicePoolArn: string;
    testPackageArn: string;
    testSpecArn: string;
    runName: string;
  },
): Promise<{ runArn: string; result: string; status: string }> {
  const { run } = await client.send(
    new ScheduleRunCommand({
      projectArn: options.projectArn,
      appArn: options.appArn,
      devicePoolArn: options.devicePoolArn,
      name: options.runName,
      test: {
        type: 'APPIUM_NODE',
        testPackageArn: options.testPackageArn,
        testSpecArn: options.testSpecArn,
      },
      executionConfiguration: { jobTimeoutMinutes: 20, videoCapture: true },
    }),
  );
  if (!run?.arn) fail('schedule-run returned no ARN');
  const runArn = run.arn;
  const consoleUrl = `https://us-west-2.console.aws.amazon.com/devicefarm/home#/mobile/projects/${encodeURIComponent(
    options.projectArn.split(':project:')[1] ?? '',
  )}/runs`;
  log(`scheduled run "${options.runName}"`);
  log(`console: ${consoleUrl}`);

  // Runs take several minutes (provision → install → test). Poll every 20s.
  let lastStatus = '';
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const { run: state } = await client.send(new GetRunCommand({ arn: runArn }));
    const status = state?.status ?? 'UNKNOWN';
    if (status !== lastStatus) {
      log(`run status: ${status}${state?.result ? ` (${state.result})` : ''}`);
      lastStatus = status;
    }
    if (status === 'COMPLETED') {
      return { runArn, result: state?.result ?? 'UNKNOWN', status };
    }
    await sleep(20000);
  }
  fail('run did not complete in time (60 min)');
}

async function reportJobs(client: DeviceFarmClient, runArn: string): Promise<void> {
  const { jobs } = await client.send(new ListJobsCommand({ arn: runArn }));
  log('per-device results:');
  for (const job of jobs ?? []) {
    const device = job.device?.name ?? 'unknown device';
    const os = job.device?.os ?? '?';
    console.log(
      `    ${job.result === 'PASSED' ? 'PASS' : job.result === 'FAILED' ? 'FAIL' : job.result}  ${device} (Android ${os})`,
    );
  }
}

async function downloadArtifacts(client: DeviceFarmClient, runArn: string, outDir: string): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  const types: ArtifactCategory[] = ['SCREENSHOT', 'FILE', 'LOG'];
  let count = 0;
  for (const type of types) {
    const { artifacts } = await client.send(new ListArtifactsCommand({ arn: runArn, type }));
    for (const [index, artifact] of (artifacts ?? []).entries()) {
      if (!artifact.url) continue;
      const ext = artifact.extension ? `.${artifact.extension.replace(/^\./, '')}` : '';
      const safeName = `${type.toLowerCase()}-${index}-${(artifact.name ?? 'artifact').replace(/[^\w.-]+/g, '_')}${ext}`;
      const response = await fetch(artifact.url);
      if (!response.ok) continue;
      writeFileSync(join(outDir, safeName), Buffer.from(await response.arrayBuffer()));
      count += 1;
    }
  }
  log(`downloaded ${count} artifact(s) → ${outDir}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.appPath) {
    fail('--app-path <app.apk> is required (the diagnostic APK: com.boardsesh.app.dev, FREEZE_DEBUG=1)');
  }
  const appPath = resolve(args.appPath);
  if (!existsSync(appPath)) fail(`APK not found: ${appPath}`);
  if (!existsSync(TESTSPEC_PATH)) fail(`missing testspec: ${TESTSPEC_PATH}`);

  loadCredentials();
  const config = loadConfig();
  const client = new DeviceFarmClient({ region: config.region });

  log(`app: ${appPath}`);
  const projectArn = await ensureProject(client, config.projectName);
  const devicePoolArn = await ensureDevicePool(client, projectArn, config, args.recreatePool);

  const testPackageZip = buildTestPackageZip(args.flowPath, args.keep);

  const appArn = await uploadFile(client, projectArn, 'ANDROID_APP', appPath, basename(appPath));
  const testPackageArn = await uploadFile(
    client,
    projectArn,
    'APPIUM_NODE_TEST_PACKAGE',
    testPackageZip,
    'maestro-testpkg.zip',
  );
  const testSpecArn = await uploadFile(client, projectArn, 'APPIUM_NODE_TEST_SPEC', TESTSPEC_PATH, 'testspec.yml');

  const runName = args.runName ?? `login-freeze ${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const { runArn, result } = await scheduleAndAwaitRun(client, {
    projectArn,
    appArn,
    devicePoolArn,
    testPackageArn,
    testSpecArn,
    runName,
  });

  await reportJobs(client, runArn);
  const outDir = join(RUNS_DIR, runName.replace(/[^\w.-]+/g, '_'));
  await downloadArtifacts(client, runArn, outDir);

  console.log('');
  if (result === 'PASSED') {
    log('RESULT: PASSED — touch is alive on the affected devices (freeze fixed / not present).');
    process.exit(0);
  }
  log(`RESULT: ${result} — the touch-liveness probe did not pass.`);
  log(
    'For the unfixed build this is EXPECTED (FAILED = freeze reproduced). Check the screenshots/video in the run dir.',
  );
  process.exit(2);
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? `${error.message}` : String(error));
});
