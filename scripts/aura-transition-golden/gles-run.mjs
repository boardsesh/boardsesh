import { writeFileSync, existsSync, readdirSync, statSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  ownedProcessState,
  argumentsMap,
  requiredPath,
  load,
  save,
  fileSha256,
  run,
  requireCondition as check,
} from './lib.mjs';
import { verifyPrepared, saveAnalysis } from './analyse.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const options = argumentsMap(process.argv.slice(2));
const work = requiredPath(options, '--work');
check(
  [...options.keys()].every((key) => ['--work', '--adb', '--serial', '--model', '--execute'].includes(key)),
  'Unknown argument',
);
check(!options.has('--execute') || options.get('--execute') === 'yes', 'Use --execute yes explicitly');
const path = join(work, 'gles-run-registration.json');
const build = load(join(work, 'gles-build.json'));
verifyPrepared(work);
check(build.status === 'AARCH64_EGL_GLES_RUNNER_BUILT_NOT_EXECUTED', 'Invalid GLES build');
let registration;
if (!existsSync(path)) {
  const adb = requiredPath(options, '--adb'),
    serial = options.get('--serial'),
    model = options.get('--model');
  check(
    typeof serial === 'string' &&
      /^[A-Za-z0-9._:-]{4,128}$/.test(serial) &&
      typeof model === 'string' &&
      model.length > 0 &&
      model.length <= 128,
    'Exact USB serial/model required',
  );
  const expectedInputs = new Set(
    [...Object.keys(load(join(work, 'prepared.json')).files), ...Object.keys(build.files)]
      .filter((name) => name.startsWith('inputs/'))
      .map((name) => name.slice(7)),
  );
  check(
    JSON.stringify(readdirSync(join(work, 'inputs')).sort((first, second) => first.localeCompare(second))) ===
      JSON.stringify([...expectedInputs].sort((first, second) => first.localeCompare(second))),
    'Unexpected transport input files',
  );
  const transport = Object.fromEntries(
    [
      'gles-golden',
      ...[...expectedInputs].sort((first, second) => first.localeCompare(second)).map((name) => `inputs/${name}`),
    ].map((name) => {
      check(lstatSync(join(work, name)).isFile(), 'Only ordinary owned files may be transferred');
      return [name, { bytes: statSync(join(work, name)).size, sha256: fileSha256(join(work, name)) }];
    }),
  );
  check(
    Object.values(transport).reduce((sum, record) => sum + record.bytes, 0) <= 128 * 1024 * 1024,
    'Input transfer exceeds bound',
  );
  registration = {
    status: 'PROPOSED_NOT_GRANTED',
    rootPhaseGrant: false,
    adb,
    adbSha256: fileSha256(adb),
    deviceSerial: serial,
    deviceModel: model,
    remoteRoot: `/data/local/tmp/boardsesh-aura-lazy-golden-${randomBytes(6).toString('hex')}`,
    preparedSha256: fileSha256(join(work, 'prepared.json')),
    buildReceiptSha256: fileSha256(join(work, 'gles-build.json')),
    transport,
    helpers: Object.fromEntries(
      ['gles-run.mjs', 'analyse.mjs', 'lib.mjs', 'gles-golden.cpp'].map((name) => [name, fileSha256(join(here, name))]),
    ),
    limits: {
      maxTemperatureC: 35,
      thermalStatus: 0,
      childAlarmSeconds: 150,
      hostTimeoutSeconds: 180,
      maximumOutputBytes: 640 * 1024 * 1024,
      samples: 42,
      commands: 84,
      maxChannelError: 1,
      pixelsOverOne: 0,
    },
    qualification:
      'Physical offscreen EGL/GLES helper only; not a primary app/performance artifact, live-view/lifecycle proof, scanout or cadence measurement. All existing app data/settings and old evidence remain untouched; owned diagnostic files are retained.',
  };
  save(path, registration);
} else registration = load(path);
console.log(
  JSON.stringify({
    status: registration.status,
    registrationSha256: fileSha256(path),
    qualification: 'No phone action occurs without --execute yes and a reviewed frozen grant.',
  }),
);
if (options.get('--execute') !== 'yes') process.exit(0);
check(
  registration.status === 'APPROVED_FROZEN' && registration.rootPhaseGrant === true,
  'Phone execution has not been granted',
);
check(
  !existsSync(join(work, 'gles-invalid.json')) &&
    !existsSync(join(work, 'gles-started.json')) &&
    !existsSync(join(work, 'gles-renders')),
  'Preserve previous run; no automatic retry/resume',
);
const registrationSha256 = fileSha256(path);
function admit() {
  check(
    fileSha256(path) === registrationSha256 && fileSha256(registration.adb) === registration.adbSha256,
    'Registration/ADB changed',
  );
  check(
    fileSha256(join(work, 'prepared.json')) === registration.preparedSha256 &&
      fileSha256(join(work, 'gles-build.json')) === registration.buildReceiptSha256,
    'Prepared/build receipt changed',
  );
  verifyPrepared(work);
  for (const [name, hash] of Object.entries(build.files))
    check(fileSha256(join(work, name)) === hash, 'Compiled GLES input changed');
  for (const [name, hash] of Object.entries(registration.helpers))
    check(fileSha256(join(here, name)) === hash, 'Host helper changed');
  for (const [name, record] of Object.entries(registration.transport))
    check(
      statSync(join(work, name)).size === record.bytes && fileSha256(join(work, name)) === record.sha256,
      'Transfer input changed',
    );
}
const adb = (args, timeout = 30_000) => run(registration.adb, ['-s', registration.deviceSerial, ...args], { timeout });
const shell = (...args) =>
  adb(['shell', ...args])
    .stdout.toString('utf8')
    .trim();
function conditions() {
  check(adb(['get-state']).stdout.toString('utf8').trim() === 'device', 'USB device unavailable');
  const model = shell('getprop', 'ro.product.model'),
    emulator = shell('getprop', 'ro.kernel.qemu'),
    fingerprint = shell('getprop', 'ro.build.fingerprint');
  check(
    model === registration.deviceModel && emulator !== '1' && fingerprint.length > 0,
    'Physical device identity mismatch',
  );
  const battery = shell('dumpsys', 'battery'),
    thermal = shell('dumpsys', 'thermalservice');
  const temperature = Number(battery.match(/^\s*temperature:\s*(\d+)/m)?.[1]) / 10;
  const thermalStatus = Number(thermal.match(/Thermal Status:\s*(\d+)/)?.[1]);
  check(
    temperature > 0 && temperature <= registration.limits.maxTemperatureC && thermalStatus === 0,
    'Thermal/temperature qualification failed',
  );
  return { model, fingerprint, temperatureC: temperature, thermalStatus };
}
function remoteHashes() {
  const names = Object.keys(registration.transport);
  const lines = shell('sha256sum', ...names.map((name) => `${registration.remoteRoot}/${name}`)).split('\n');
  check(lines.length === names.length, 'Remote hash count changed');
  const seen = new Set();
  for (const line of lines) {
    const match = line.match(/^([a-f0-9]{64})\s+(\S+)$/);
    check(match, 'Invalid remote hash response');
    const name = match[2].slice(registration.remoteRoot.length + 1);
    check(
      match[2] === `${registration.remoteRoot}/${name}` &&
        !seen.has(name) &&
        registration.transport[name]?.sha256 === match[1],
      'Remote hash mismatch',
    );
    seen.add(name);
  }
}
function reapOwnedChild(stdout) {
  const first = stdout?.toString('utf8').split('\n')[0];
  let start;
  try {
    start = JSON.parse(first);
  } catch {
    return { qualified: false, reason: 'No owned native PID acknowledgement' };
  }
  if (start.phase !== 'starting' || !Number.isSafeInteger(start.processId) || start.processId <= 1)
    return { qualified: false, reason: 'Invalid PID acknowledgement' };
  const pid = String(start.processId),
    expected = `${registration.remoteRoot}/gles-golden\0${registration.remoteRoot}\0`;
  const deadline = Date.now() + 15_000;
  const readState = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return 'unknown';
    const result = spawnSync(
      registration.adb,
      ['-s', registration.deviceSerial, 'exec-out', 'cat', `/proc/${pid}/cmdline`],
      { timeout: Math.min(1500, remaining), maxBuffer: 8192 },
    );
    return ownedProcessState(result, pid, expected);
  };
  const exited = (state) => state === 'gone' || state === 'different';
  let state = readState();
  if (exited(state)) return { qualified: true, pid, state: 'Owned process already exited' };
  if (state !== 'same') return { qualified: false, pid, reason: 'Cannot prove owned process state' };
  adb(['shell', 'kill', '-TERM', pid], 1500);
  for (let attempt = 0; attempt < 3; attempt++) {
    state = readState();
    if (exited(state)) return { qualified: true, pid, state: 'Exited after TERM' };
    if (state !== 'same') return { qualified: false, pid, reason: 'Cannot prove state after TERM' };
  }
  if (readState() !== 'same') return { qualified: false, pid, reason: 'Lost owned PID proof before KILL' };
  adb(['shell', 'kill', '-KILL', pid], 1500);
  for (let attempt = 0; attempt < 3; attempt++) {
    state = readState();
    if (exited(state)) return { qualified: true, pid, state: 'Exited after KILL' };
    if (state !== 'same') break;
  }
  return { qualified: false, pid, reason: 'Owned process could not be confirmed exited; stop later phone work' };
}
let childStdout;
let childAttempted = false;
try {
  admit();
  const before = conditions();
  save(join(work, 'gles-before-device.json'), before);
  shell('test', '!', '-e', registration.remoteRoot); // Fails closed; never deletes prior output.
  shell('mkdir', registration.remoteRoot);
  adb(['push', join(work, 'inputs'), registration.remoteRoot], 120_000);
  adb(['push', join(work, 'gles-golden'), `${registration.remoteRoot}/gles-golden`], 30_000);
  shell('chmod', '700', `${registration.remoteRoot}/gles-golden`);
  remoteHashes();
  admit();
  save(join(work, 'gles-started.json'), { registrationSha256, before });
  childAttempted = true;
  const result = adb(['shell', `${registration.remoteRoot}/gles-golden`, registration.remoteRoot], 180_000);
  childStdout = result.stdout;
  writeFileSync(join(work, 'gles-run.stdout'), result.stdout);
  writeFileSync(join(work, 'gles-run.stderr'), result.stderr);
  const start = JSON.parse(result.stdout.toString('utf8').split('\n')[0]);
  check(
    start.phase === 'starting' && Number.isSafeInteger(start.processId) && start.processId > 1,
    'Missing native PID acknowledgement',
  );
  const outputListing = shell('ls', '-1', `${registration.remoteRoot}/renders`)
    .split('\n')
    .sort((first, second) => first.localeCompare(second));
  const samples = load(join(work, 'inputs/inputs.json')).samples;
  check(
    JSON.stringify(outputListing) ===
      JSON.stringify(
        ['result.json', ...samples.flatMap((sample) => [`${sample.name}-old.rgba`, `${sample.name}-new.rgba`])].sort(
          (first, second) => first.localeCompare(second),
        ),
      ),
    'Remote output files differ',
  );
  const usage = shell('du', '-sb', `${registration.remoteRoot}/renders`);
  check(Number(usage.split(/\s+/)[0]) <= registration.limits.maximumOutputBytes, 'Remote output bound exceeded');
  adb(['pull', `${registration.remoteRoot}/renders`, join(work, 'gles-renders')], 180_000);
  const native = load(join(work, 'gles-renders/result.json'));
  check(
    native.processId === start.processId &&
      typeof native.renderer === 'string' &&
      native.renderer.length > 0 &&
      !/swiftshader|llvmpipe|software/i.test(native.renderer),
    'Native renderer/PID qualification failed',
  );
  remoteHashes();
  const after = conditions();
  check(after.model === before.model && after.fingerprint === before.fingerprint, 'Device identity changed');
  save(join(work, 'gles-after-device.json'), after);
  admit();
  const analysis = saveAnalysis(work, join(work, 'gles-renders'), 'GLES', join(work, 'gles-completed.json'));
  save(join(work, 'gles-device-qualified.json'), {
    registrationSha256,
    nativeProcessId: start.processId,
    renderer: native.renderer,
    vendor: native.vendor,
    version: native.version,
    before,
    after,
    completionSha256: fileSha256(join(work, 'gles-completed.json')),
    qualification: registration.qualification,
  });
  console.log(
    JSON.stringify({
      status: analysis.status,
      maximumChannelError: analysis.maximumChannelError,
      rustStillComparisons: analysis.rustStillComparisons,
    }),
  );
} catch (error) {
  const stdout = error.stdout ?? childStdout;
  if (stdout) writeFileSync(join(work, 'gles-run.stdout'), stdout);
  if (error.stderr) writeFileSync(join(work, 'gles-run.stderr'), error.stderr);
  let cleanup = { qualified: true, reason: 'No diagnostic process was started' };
  if (childAttempted) {
    try {
      cleanup = reapOwnedChild(stdout);
    } catch (cleanupError) {
      cleanup = { qualified: false, reason: cleanupError.message };
    }
  }
  save(join(work, 'gles-invalid.json'), {
    registrationSha256,
    error: error.message,
    cleanup,
    qualification: 'No partial comparison accepted. Existing outputs/app data/settings retained.',
  });
  throw error;
}
