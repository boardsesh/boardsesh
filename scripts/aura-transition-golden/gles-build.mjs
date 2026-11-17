import { copyFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  argumentsMap,
  requiredPath,
  load,
  save,
  fileSha256,
  run,
  newDirectory,
  requireCondition as check,
} from './lib.mjs';
import { verifyPrepared } from './analyse.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const repository = join(here, '../..');
const options = argumentsMap(process.argv.slice(2));
const work = requiredPath(options, '--work');
const ndk = requiredPath(options, '--ndk');
const contractCli = requiredPath(options, '--contract-cli');
check(
  [...options.keys()].every((key) =>
    ['--work', '--ndk', '--contract-cli', '--runtime-shaders', '--android-project'].includes(key),
  ),
  'Unknown argument',
);
check(
  options.has('--runtime-shaders') !== options.has('--android-project'),
  'Provide one actual Kotlin runtime export or Android project',
);
verifyPrepared(work);
check(!existsSync(join(work, 'gles-build.json')), 'Preserve existing GLES build');
const metadata = load(join(work, 'inputs/inputs.json'));
let runtime = options.has('--runtime-shaders')
  ? requiredPath(options, '--runtime-shaders')
  : join(work, 'kotlin-runtime');
const kotlin = join(
  repository,
  'packages/mobile/modules/climb-overlay-gpu/android/src/main/java/com/boardsesh/climboverlaygpu',
);
let runtimeReceipt;
if (options.has('--android-project')) {
  const android = requiredPath(options, '--android-project');
  newDirectory(runtime);
  newDirectory(join(work, 'kotlin-export-source'));
  writeFileSync(
    join(work, 'kotlin-export-source/AuraGoldenRuntimeExportTest.kt'),
    `package com.boardsesh.climboverlaygpu\nimport java.io.File\nimport org.junit.Test\nclass AuraGoldenRuntimeExportTest { @Test fun exportActualShader() { val root=File(System.getProperty("auraGoldenOutput")); File(root,"after.vert").writeText(OverlayShader.vertex); File(root,"after.frag").writeText(OverlayShader.fragment) } }\n`,
  );
  writeFileSync(
    join(work, 'kotlin-export.init.gradle'),
    `allprojects { project -> afterEvaluate { if (project.name == 'boardsesh-climb-overlay-gpu-module') { android.sourceSets.getByName('test').java.srcDir(System.getProperty('auraGoldenTestSources')); tasks.withType(Test).configureEach { systemProperty 'auraGoldenOutput', System.getProperty('auraGoldenOutput') } } } }\n`,
  );
  const result = run(
    join(android, 'gradlew'),
    [
      '--no-daemon',
      '--max-workers=2',
      '-I',
      join(work, 'kotlin-export.init.gradle'),
      `-DauraGoldenTestSources=${join(work, 'kotlin-export-source')}`,
      `-DauraGoldenOutput=${runtime}`,
      ':boardsesh-climb-overlay-gpu-module:testDebugUnitTest',
      '--tests',
      'com.boardsesh.climboverlaygpu.AuraGoldenRuntimeExportTest',
    ],
    { cwd: android, timeout: 300_000 },
  );
  writeFileSync(join(work, 'kotlin-export.stdout'), result.stdout);
  writeFileSync(join(work, 'kotlin-export.stderr'), result.stderr);
  runtimeReceipt = {
    method:
      'Actual production Kotlin object evaluated by the existing module test compilation; test-only source/init files outside repository.',
    files: Object.fromEntries(
      [
        join(kotlin, 'OverlayShader.kt'),
        join(kotlin, 'OverlayPacketLayout.kt'),
        join(runtime, 'after.vert'),
        join(runtime, 'after.frag'),
      ].map((path) => [path, { sha256: fileSha256(path) }]),
    ),
  };
  save(join(runtime, 'receipt.json'), runtimeReceipt);
} else runtimeReceipt = load(join(runtime, 'receipt.json'));
for (const path of [
  join(kotlin, 'OverlayShader.kt'),
  join(kotlin, 'OverlayPacketLayout.kt'),
  join(runtime, 'after.vert'),
  join(runtime, 'after.frag'),
])
  check(runtimeReceipt.files[path]?.sha256 === fileSha256(path), `Runtime/source binding failed: ${path}`);
for (const extension of ['vert', 'frag'])
  copyFileSync(join(runtime, `after.${extension}`), join(work, `inputs/new.${extension}`));
const generated = join(work, 'gles-contract');
newDirectory(generated);
run(contractCli, [generated]);
const header = join(generated, 'aura_gpu_packet_layout.h');
check(load(join(generated, 'aura-gpu-packet-v1.json')).descriptorBytes === 224, 'Generated ABI mismatch');
const headerText = (await import('node:fs')).readFileSync(header, 'utf8');
check(
  headerText.includes(`#define AURA_GPU_CONTRACT_SHA256 "${metadata.contractSha256}"`),
  'Generated C/shader contract mismatch',
);
const samples =
  metadata.samples
    .map((sample) => `${sample.name}\t${sample.lower}\t${sample.upper}\t${Number(sample.editorAllChanged)}`)
    .join('\n') + '\n';
writeFileSync(join(work, 'inputs/samples.tsv'), samples);
copyFileSync(join(here, 'gles-golden.cpp'), join(work, 'gles-golden.cpp'));
const host = process.platform === 'darwin' ? 'darwin-x86_64' : 'linux-x86_64';
const compiler = join(ndk, 'toolchains/llvm/prebuilt', host, 'bin/aarch64-linux-android26-clang++');
const result = run(compiler, [
  '-std=c++17',
  '-O2',
  '-Wall',
  '-Wextra',
  '-Werror',
  '-static-libstdc++',
  '-I',
  generated,
  join(work, 'gles-golden.cpp'),
  '-lEGL',
  '-lGLESv3',
  '-o',
  join(work, 'gles-golden'),
]);
writeFileSync(join(work, 'gles-build.stdout'), result.stdout);
writeFileSync(join(work, 'gles-build.stderr'), result.stderr);
const files = Object.fromEntries(
  [
    'gles-golden.cpp',
    'gles-golden',
    'gles-contract/aura_gpu_packet_layout.h',
    'inputs/new.vert',
    'inputs/new.frag',
    'inputs/samples.tsv',
  ].map((name) => [name, fileSha256(join(work, name))]),
);
save(join(work, 'gles-build.json'), {
  status: 'AARCH64_EGL_GLES_RUNNER_BUILT_NOT_EXECUTED',
  preparedSha256: fileSha256(join(work, 'prepared.json')),
  compiledContractSha256: metadata.contractSha256,
  runtimeReceiptSha256: fileSha256(join(runtime, 'receipt.json')),
  compilerSha256: fileSha256(compiler),
  contractCliSha256: fileSha256(contractCli),
  sourceKotlinSha256: fileSha256(join(kotlin, 'OverlayShader.kt')),
  sourceKotlinLayoutSha256: fileSha256(join(kotlin, 'OverlayPacketLayout.kt')),
  files,
  helperSha256: fileSha256(join(here, 'gles-build.mjs')),
  qualification:
    'Standalone offscreen diagnostic helper, not a primary/native app artifact. Physical run requires an independently reviewed device registration and explicit execution.',
});
console.log(
  JSON.stringify({
    status: 'AARCH64_EGL_GLES_RUNNER_BUILT_NOT_EXECUTED',
    receiptSha256: fileSha256(join(work, 'gles-build.json')),
  }),
);
