// Board motion lab previews, Android half: draws prepared frames with the Android
// shader and the Kotlin swap look on an emulator's GLES 3.1, then compares each
// frame with the Metal shader and the Swift look on this Mac. With --golden, also
// checks the Android shader with no look bound is byte-identical to the one at
// --baseline on the Aura transition golden's 42 samples. See README.md.
//
// Every Android input comes from the real Kotlin objects: a temporary unit test
// (outside the repository, added through a Gradle init script) writes
// OverlayShader's strings, the baseline ref's OverlayShader, and each frame's
// words from OverlaySwapLook.encode.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, '../..');
const ios = join(repository, 'packages/mobile/modules/climb-overlay-gpu/ios');
const kotlin = 'packages/mobile/modules/climb-overlay-gpu/android/src/main/java/com/boardsesh/climboverlaygpu';
const METAL_SHADER = 'packages/mobile/modules/climb-overlay-gpu/ios/ClimbOverlayShader.swift';
/** Variant I, the player's pick: its 1× motion track and its contact sheets. */
const DEFAULT_IDS = [
  'I-ghost-peek-standby-1x',
  'I-ghost-peek-standby',
  'I-ghost-peek-standby-bold',
  'I-mostly',
  'I-role-change',
  'I-moonboard',
];

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (value === undefined) throw new Error(`Missing ${name}`);
  return value;
}
const home = (path) => resolve(path.replace(/^~(?=\/)/, process.env.HOME ?? '~'));
function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
  if (result.status !== 0) {
    throw new Error(`${executable} ${args.slice(0, 3).join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

const work = home(option('--work'));
const out = home(option('--out'));
const androidProject = home(option('--android-project'));
// Only Swift's against Kotlin's look words: no emulator, any number of frames.
const wordsOnly = process.argv.includes('--words-only');
const ndk = wordsOnly ? '' : home(option('--ndk'));
const adb = wordsOnly ? '' : home(option('--adb'));
const serial = wordsOnly ? 'emulator-0' : option('--serial');
const golden = process.argv.includes('--golden') ? home(option('--golden')) : null;
const ids = option('--ids', DEFAULT_IDS.join(',')).split(',');
const baselineRef = option('--baseline', run('git', ['-C', repository, 'merge-base', 'HEAD', 'origin/main']).trim());
const keepRaw = process.argv.includes('--keep-raw');
// Host evidence only: an emulator is this Mac's GPU stack (ANGLE on SwiftShader).
// A phone goes through the golden's reviewed device registration instead.
if (!/^emulator-\d+$/.test(serial)) throw new Error('--serial must name an emulator (emulator-NNNN)');
if (existsSync(out)) throw new Error(`Output exists, pick a fresh directory: ${out}`);
const build = join(out, 'build');
const exported = join(out, 'export');
const device = join(out, 'device');
mkdirSync(build, { recursive: true });

// 1. The Metal side: the frames' uniforms and Swift look words, from the preview renderer.
for (const name of ['BaselineShader', 'BeforeFixShader']) {
  const source = run('git', ['-C', repository, 'show', `${baselineRef}:${METAL_SHADER}`]);
  writeFileSync(join(build, `${name}.swift`), source.replace('enum ClimbOverlayShader {', `enum ${name} {`));
}
const preview = join(build, 'board-motion-preview');
run('xcrun', [
  'swiftc',
  '-O',
  '-module-cache-path',
  join(build, 'module-cache'),
  join(here, 'PreviewRender.swift'),
  join(ios, 'ClimbOverlayShader.swift'),
  join(ios, 'ClimbOverlaySwapLook.swift'),
  join(ios, 'ClimbOverlayPacketLayout.swift'),
  join(build, 'BaselineShader.swift'),
  join(build, 'BeforeFixShader.swift'),
  '-o',
  preview,
]);
console.log(run(preview, ['export', work, exported, ...ids]).trim());

// 2. The Android side, from the real Kotlin objects: shaders and every frame's look words.
const testSources = join(build, 'kotlin-test');
mkdirSync(testSources);
const baselineKotlin = run('git', ['-C', repository, 'show', `${baselineRef}:${kotlin}/OverlayShader.kt`]);
if (baselineKotlin.split('internal object OverlayShader {').length !== 2)
  throw new Error('Baseline shader envelope changed');
writeFileSync(
  join(testSources, 'BaselineOverlayShader.kt'),
  baselineKotlin.replace('internal object OverlayShader {', 'internal object BaselineOverlayShader {'),
);
const layoutNow = readFileSync(join(repository, kotlin, 'OverlayPacketLayout.kt'), 'utf8');
if (run('git', ['-C', repository, 'show', `${baselineRef}:${kotlin}/OverlayPacketLayout.kt`]) !== layoutNow) {
  throw new Error('The generated layout changed since the baseline; its shader would interpolate today’s constants');
}
writeFileSync(
  join(testSources, 'BoardMotionGlesExportTest.kt'),
  `package com.boardsesh.climboverlaygpu
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.json.JSONObject
import org.junit.Test
class BoardMotionGlesExportTest {
    @Test
    fun export() {
        val root = File(System.getProperty("boardMotionExport"))
        val shaders = File(root, "shaders").apply { mkdirs() }
        File(shaders, "after.vert").writeText(OverlayShader.vertex)
        File(shaders, "after.frag").writeText(OverlayShader.fragment)
        File(shaders, "baseline.vert").writeText(BaselineOverlayShader.vertex)
        File(shaders, "baseline.frag").writeText(BaselineOverlayShader.fragment)
        val manifest = JSONObject(File(root, "frames.json").readText())
        val packets = manifest.getJSONObject("packets")
        val scenes = HashMap<String, OverlaySwapLook.PacketScenes>()
        for (key in packets.keys()) {
            val packet = packets.getJSONObject(key)
            val list = packet.getJSONArray("scenes")
            val header = PacketHeader(packet.getInt("width"), packet.getInt("height"),
                (0 until list.length()).map { val scene = list.getJSONObject(it)
                    PacketScene(scene.getInt("offset"), scene.getInt("bytes"), scene.getInt("count"), 0, 0) },
                listOf(true, true, true), emptyMap(), 0)
            val bytes = File(packet.getString("source"), "descriptors.bin").readBytes()
            scenes[key] = OverlaySwapLook.PacketScenes.decode(ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN), header)
        }
        val frames = manifest.getJSONArray("frames")
        val target = ByteBuffer.allocate(OverlaySwapLook.GLES_BYTES)
        for (index in 0 until frames.length()) {
            val frame = frames.getJSONObject(index)
            val values = frame.optJSONArray("look")?.let { array -> (0 until array.length()).map { array.getDouble(it) } }
            val swap = frame.getJSONArray("swap")
            val codes = frame.getJSONArray("codes")
            val lower = frame.getInt("lower")
            val upper = frame.getInt("upper")
            val look = values?.let { OverlaySwapLook.Look.parse(it) ?: error("Bad look") }
            val words = if (look == null || lower == upper) OverlaySwapLook.OFF else {
                val packet = scenes.getValue(frame.getString("packet"))
                OverlaySwapLook.encode(packet.scene(lower, false), packet.scene(upper, true),
                    OverlaySwapLook.Side.fromCode(swap.getDouble(0).toFloat(), codes.getInt(0)),
                    OverlaySwapLook.Side.fromCode(swap.getDouble(1).toFloat(), codes.getInt(1)),
                    frame.getDouble("sharedFloor").toFloat(), look, false, true)
            }
            val bytes = OverlaySwapLook.bytes(words, target)
            File(root, "frames/" + frame.getString("name") + ".kotlin-look").writeBytes(ByteArray(bytes.remaining()).also { bytes.get(it) })
        }
    }
}
`,
);
// The export compiles into its own build directory, so the module's own build never
// sees (and never keeps) the temporary test or the baseline shader.
writeFileSync(
  join(build, 'kotlin-export.init.gradle'),
  `allprojects { project -> if (project.name == 'boardsesh-climb-overlay-gpu-module') { project.layout.buildDirectory.set(new File(System.getProperty('boardMotionBuildDir'))); project.afterEvaluate { android.sourceSets.getByName('test').java.srcDir(System.getProperty('boardMotionTestSources')); tasks.withType(Test).configureEach { systemProperty 'boardMotionExport', System.getProperty('boardMotionExport') } } } }\n`,
);
const gradle = spawnSync(
  join(androidProject, 'gradlew'),
  [
    '--no-daemon',
    '--max-workers=4',
    '-I',
    join(build, 'kotlin-export.init.gradle'),
    `-DboardMotionTestSources=${testSources}`,
    `-DboardMotionExport=${exported}`,
    `-DboardMotionBuildDir=${join(build, 'gradle-module')}`,
    ':boardsesh-climb-overlay-gpu-module:testDebugUnitTest',
    '--tests',
    'com.boardsesh.climboverlaygpu.BoardMotionGlesExportTest',
  ],
  { cwd: androidProject, encoding: 'utf8', timeout: 900_000, maxBuffer: 64 * 1024 * 1024 },
);
writeFileSync(join(build, 'kotlin-export.log'), `${gradle.stdout}\n${gradle.stderr}`);
if (gradle.status !== 0) throw new Error(`Kotlin export failed; see ${join(build, 'kotlin-export.log')}`);

if (wordsOnly) {
  console.log(run(preview, ['compare', work, exported, '-', join(out, 'compare')], { timeout: 3_600_000 }).trim());
  process.exit(0);
}

// 3. What the device reads: shaders, packets, frames with the Kotlin words, the golden.
const manifest = JSON.parse(readFileSync(join(exported, 'frames.json'), 'utf8'));
mkdirSync(join(device, 'frames'), { recursive: true });
mkdirSync(join(device, 'shaders'));
for (const file of ['after.vert', 'after.frag', 'baseline.vert', 'baseline.frag'])
  copyFileSync(join(exported, 'shaders', file), join(device, 'shaders', file));
copyFileSync(join(exported, 'frames.tsv'), join(device, 'frames.tsv'));
const directories = new Map(manifest.frames.map((frame) => [frame.directory, manifest.packets[frame.packet].source]));
for (const [directory, source] of directories) {
  mkdirSync(join(device, directory), { recursive: true });
  for (const file of ['pixels.bin', 'descriptors.bin', 'resources.bin'])
    copyFileSync(join(source, file), join(device, directory, file));
}
for (const { name } of manifest.frames) {
  copyFileSync(join(exported, 'frames', `${name}.uniforms`), join(device, 'frames', `${name}.uniforms`));
  copyFileSync(join(exported, 'frames', `${name}.kotlin-look`), join(device, 'frames', `${name}.look`));
}
if (golden) {
  const inputs = JSON.parse(readFileSync(join(golden, 'inputs/inputs.json'), 'utf8'));
  const goldenDevice = join(device, 'golden');
  mkdirSync(goldenDevice);
  copyFileSync(join(golden, 'inputs', inputs.pixelFiles.new), join(goldenDevice, 'pixels.bin'));
  copyFileSync(join(golden, 'inputs', inputs.resourceFiles.new), join(goldenDevice, 'resources.bin'));
  for (const variant of ['transition', 'editor'])
    copyFileSync(
      join(golden, 'inputs', inputs.descriptorFiles[variant].new),
      join(goldenDevice, `descriptors-${variant}.bin`),
    );
  let samples = '';
  for (const sample of inputs.samples) {
    copyFileSync(
      join(golden, 'inputs', `new-uniforms-${sample.name}.bin`),
      join(goldenDevice, `uniforms-${sample.name}.bin`),
    );
    const lower = inputs.scenes[sample.lower];
    const upper = inputs.scenes[sample.upper];
    samples += `${sample.name} ${inputs.width} ${inputs.height} ${lower.offset} ${lower.bytes} ${upper.offset} ${upper.bytes} ${sample.editorAllChanged ? 'editor' : 'transition'}\n`;
  }
  writeFileSync(join(goldenDevice, 'samples.tsv'), samples);
}

// 4. The offscreen GLES helper, for the emulator's arm64 ABI.
const host = process.platform === 'darwin' ? 'darwin-x86_64' : 'linux-x86_64';
run(join(ndk, 'toolchains/llvm/prebuilt', host, 'bin/aarch64-linux-android26-clang++'), [
  '-std=c++17',
  '-O2',
  '-Wall',
  '-Wextra',
  '-Werror',
  '-static-libstdc++',
  join(here, 'gles-look.cpp'),
  '-lEGL',
  '-lGLESv3',
  '-o',
  join(device, 'gles-look'),
]);

// 5. Run on the emulator in a fresh owned directory, pull the renders, remove the directory.
const remote = `/data/local/tmp/board-motion-gles-${randomBytes(6).toString('hex')}`;
const shell = (command, options) => run(adb, ['-s', serial, 'shell', command], { timeout: 3_700_000, ...options });
run(adb, ['-s', serial, 'push', device, remote], { timeout: 600_000 });
const raw = join(out, 'gles');
try {
  shell(`chmod 700 ${remote}/gles-look`);
  const rendered = shell(`${remote}/gles-look frames ${remote}`).trim();
  console.log(rendered);
  writeFileSync(join(out, 'gles-frames.json'), rendered);
  if (golden) {
    const parity = spawnSync(adb, ['-s', serial, 'shell', `${remote}/gles-look parity ${remote}`], {
      encoding: 'utf8',
    });
    writeFileSync(join(out, 'gles-parity.json'), parity.stdout.trim());
    console.log(parity.stdout.trim().slice(0, 400));
    if (parity.status !== 0) console.error(`GLES look-off parity failed: ${parity.stderr}`);
  }
  run(adb, ['-s', serial, 'pull', `${remote}/out`, raw], { timeout: 1_200_000 });
} finally {
  spawnSync(adb, ['-s', serial, 'shell', `rm -rf ${remote}`]);
}

// 6. Metal (Swift words) against GLES (Kotlin words), frame by frame.
const compared = run(preview, ['compare', work, exported, raw, join(out, 'compare')], { timeout: 3_600_000 }).trim();
console.log(compared);
if (!keepRaw) for (const file of readdirSync(raw).filter((name) => name.endsWith('.rgba'))) rmSync(join(raw, file));
