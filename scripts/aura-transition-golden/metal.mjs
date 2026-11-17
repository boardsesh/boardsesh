import { copyFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argumentsMap, requiredPath, load, save, fileSha256, run, requireCondition as check } from './lib.mjs';
import { verifyPrepared, saveAnalysis } from './analyse.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const options = argumentsMap(process.argv.slice(2));
const work = requiredPath(options, '--work');
check(
  [...options.keys()].every((key) => ['--work', '--execute'].includes(key)),
  'Unknown argument',
);
const executable = join(work, 'metal-golden');
const sourceNames = ['MetalGolden.swift', 'MetalMain.swift'];
check(!options.has('--execute') || options.get('--execute') === 'yes', 'Use --execute yes explicitly');
verifyPrepared(work);
let registration;
if (existsSync(join(work, 'metal-registration.json'))) {
  check(options.get('--execute') === 'yes', 'Preserve existing registration; use --execute yes after review');
  registration = load(join(work, 'metal-registration.json'));
  check(
    registration.status === 'COMPILED_NOT_EXECUTED' && registration.backend === 'HOST_METAL',
    'Unexpected registration',
  );
  check(
    registration.preparedSha256 === fileSha256(join(work, 'prepared.json')) &&
      registration.controlsSha256 === fileSha256(join(work, 'controls.json')),
    'Prepared source changed',
  );
  for (const [name, hash] of Object.entries(registration.files))
    check(fileSha256(join(work, name)) === hash, 'Compiled harness file changed');
  for (const name of sourceNames)
    check(fileSha256(join(here, name)) === registration.files[name], 'Current Swift harness changed');
  for (const [name, hash] of Object.entries(registration.hostHelpers))
    check(fileSha256(join(here, name)) === hash, 'Host helper changed');
} else {
  for (const name of sourceNames) copyFileSync(join(here, name), join(work, name));
  const compiler = run('xcrun', [
    'swiftc',
    '-O',
    '-module-cache-path',
    join(work, 'metal-module-cache'),
    ...sourceNames.map((name) => join(work, name)),
    join(work, 'ReferenceShader.swift'),
    join(work, 'ClimbOverlayShader.swift'),
    join(work, 'ClimbOverlayPacketLayout.swift'),
    '-o',
    executable,
  ]);
  writeFileSync(join(work, 'metal-build.stdout'), compiler.stdout);
  writeFileSync(join(work, 'metal-build.stderr'), compiler.stderr);
  const files = Object.fromEntries(
    [
      ...sourceNames,
      'ReferenceShader.swift',
      'ClimbOverlayShader.swift',
      'ClimbOverlayPacketLayout.swift',
      'metal-golden',
    ].map((name) => [name, fileSha256(join(work, name))]),
  );
  registration = {
    status: 'COMPILED_NOT_EXECUTED',
    backend: 'HOST_METAL',
    preparedSha256: fileSha256(join(work, 'prepared.json')),
    controlsSha256: fileSha256(join(work, 'controls.json')),
    files,
    contractSha256: load(join(work, 'inputs/inputs.json')).contractSha256,
    hostHelpers: Object.fromEntries(
      ['metal.mjs', 'analyse.mjs', 'lib.mjs'].map((name) => [name, fileSha256(join(here, name))]),
    ),
    limits: { samples: 42, commands: 84, maxChannelError: 1, pixelsOverOne: 0, timeoutSeconds: 180 },
    qualification: 'Compile-only by default. --execute yes is explicit local host GPU execution; never phone proof.',
  };
  save(join(work, 'metal-registration.json'), registration);
}
const files = registration.files;
console.log(
  JSON.stringify({
    status: registration.status,
    registrationSha256: fileSha256(join(work, 'metal-registration.json')),
  }),
);
if (options.get('--execute') !== 'yes') process.exit(0);
const registrationSha256 = fileSha256(join(work, 'metal-registration.json'));
try {
  check(!existsSync(join(work, 'metal-renders')), 'Preserve existing render outputs');
  const result = run(executable, [join(work, 'inputs/inputs.json'), join(work, 'metal-renders')], { timeout: 180_000 });
  writeFileSync(join(work, 'metal-run.stdout'), result.stdout);
  writeFileSync(join(work, 'metal-run.stderr'), result.stderr);
  for (const [name, hash] of Object.entries(files))
    check(fileSha256(join(work, name)) === hash, 'Harness/native input changed');
  for (const [name, hash] of Object.entries(registration.hostHelpers))
    check(fileSha256(join(here, name)) === hash, 'Host acceptance helper changed');
  check(fileSha256(join(work, 'metal-registration.json')) === registrationSha256, 'Registration changed');
  const native = load(join(work, 'metal-renders/result.json'));
  check(
    native.processId === result.pid && native.executableSha256 === fileSha256(executable),
    'Native PID/executable mismatch',
  );
  const analysis = saveAnalysis(work, join(work, 'metal-renders'), 'METAL', join(work, 'metal-completed.json'));
  console.log(
    JSON.stringify({
      status: analysis.status,
      maximumChannelError: analysis.maximumChannelError,
      rustStillComparisons: analysis.rustStillComparisons,
    }),
  );
} catch (error) {
  if (error.stdout) writeFileSync(join(work, 'metal-run.stdout'), error.stdout);
  if (error.stderr) writeFileSync(join(work, 'metal-run.stderr'), error.stderr);
  save(join(work, 'metal-invalid.json'), { registrationSha256, error: error.message });
  throw error;
}
