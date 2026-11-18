// Board motion lab previews, Android half: draws prepared frames with the Android
// shader and the Kotlin swap look on an emulator's GLES 3.1, then compares each
// frame with the Metal shader and the Swift look on this Mac. A frame with look
// words draws with the look program, any other with the base program, as the
// renderer does. With --golden, also checks that the base program and the look
// program with no look are byte-identical to the shader at --baseline on the Aura
// transition golden's 42 samples. See README.md.
//
// Every Android input comes from the real Kotlin objects: a temporary unit test
// (outside the repository, added through a Gradle init script) writes
// OverlayShader's strings, the baseline ref's OverlayShader, and each frame's
// words from OverlaySwapLook.Frame.encode.
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
// The swap's two ends on GLES alone: no Metal, see writeEndpointFrames.
const endpoints = process.argv.includes('--endpoints');
if (endpoints && wordsOnly) throw new Error('--endpoints draws on the emulator; it cannot be --words-only');
// Host evidence only: an emulator is this Mac's GPU stack (ANGLE on SwiftShader).
// A phone goes through the golden's reviewed device registration instead.
if (!/^emulator-\d+$/.test(serial)) throw new Error('--serial must name an emulator (emulator-NNNN)');
if (existsSync(out)) throw new Error(`Output exists, pick a fresh directory: ${out}`);
const build = join(out, 'build');
const exported = join(out, 'export');
const device = join(out, 'device');
mkdirSync(build, { recursive: true });

/**
 * Rust's uniforms for a pair and swap, as PreviewRender.swift's `LoadedPacket.uniforms`
 * patches them: the pair's base sample with the shared-weight word (15), stamp layers
 * (17), side weights (22, 23) and progress (24) written in. `transitioning` keeps the
 * progress strictly inside 0..1, as Rust does while shared holds dip, so a pair at
 * W = (1, 0) or (0, 1) still takes the shader's swap path.
 */
function patchedUniforms(description, lower, upper, swap, transitioning) {
  const same = lower === upper;
  const base = same ? `still-${lower}` : lower === 0 ? 'base-0-2' : 'base-1-0';
  const bytes = Buffer.from(readFileSync(join(work, description.dir, `uniforms-${base}.bin`)));
  const float = Math.fround;
  const [weightLower, weightUpper, shared] = swap.map(float);
  const lowerCount = description.scenes[lower].count;
  const upperCount = description.scenes[upper].count;
  const ulp = 2 ** -23;
  let progress;
  if (same) progress = 0;
  else if (lowerCount > 0 && upperCount === 0) progress = float(1 - weightLower);
  else if (lowerCount === 0 && upperCount > 0) progress = weightUpper;
  else {
    progress = float(float(float(1 - weightLower) + weightUpper) * 0.5);
    if (shared < 1 || transitioning) progress = Math.min(Math.max(progress, ulp), float(1 - ulp));
  }
  const layers = description.scenes.map((scene) => scene.stampLayers);
  const inside = progress > 0 && progress < 1;
  bytes.writeFloatLE(inside ? shared : 0, 15 * 4);
  bytes.writeUInt32LE(
    (progress <= 0 ? layers[lower] : progress >= 1 ? layers[upper] : layers[lower] | layers[upper]) >>> 0,
    17 * 4,
  );
  bytes.writeFloatLE(weightLower, 22 * 4);
  bytes.writeFloatLE(weightUpper, 23 * 4);
  bytes.writeFloatLE(progress, 24 * 4);
  return bytes;
}

/**
 * The GLES twin of PreviewRender.swift's `endpoints`: every pair I's sheets draw, as a
 * look frame at W = (1, 0) and (0, 1) (the look program) and as the still frame of the
 * climb at rest (the base program). Writes the frames the Kotlin export and the device
 * read, and returns the pairs to compare.
 */
function writeEndpointFrames() {
  const plan = JSON.parse(readFileSync(join(work, 'plan.json'), 'utf8'));
  mkdirSync(join(exported, 'frames'), { recursive: true });
  const rows = [];
  const packets = {};
  const checks = [];
  const seen = new Set();
  let table = '';
  const add = (name, packetKey, lower, upper, swap, codes, look, transitioning) => {
    const description = plan.packets[packetKey];
    const directory = `packets/${packetKey.replaceAll('/', '-')}`;
    writeFileSync(
      join(exported, 'frames', `${name}.uniforms`),
      patchedUniforms(description, lower, upper, swap, transitioning),
    );
    const { width, height } = plan.boards[description.board];
    const lowerScene = description.scenes[lower];
    const upperScene = description.scenes[upper];
    table += `${name} ${directory} ${width} ${height} ${lowerScene.offset} ${lowerScene.bytes} ${upperScene.offset} ${upperScene.bytes}\n`;
    rows.push({
      name,
      packet: packetKey,
      directory,
      lower,
      upper,
      swap,
      sharedFloor: 1,
      codes,
      ...(look ? { look } : {}),
    });
  };
  for (const sheet of plan.sheets.filter((candidate) => candidate.id.startsWith('I-'))) {
    for (const frame of sheet.frames) {
      if (frame.lower === frame.upper) continue;
      if (!frame.look) throw new Error(`${sheet.id} has no look`);
      const key = `${frame.look.join(',')}|${frame.packet}|${frame.lower}|${frame.upper}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const description = plan.packets[frame.packet];
      const { width, height } = plan.boards[description.board];
      packets[frame.packet] = {
        source: join(work, description.dir),
        width,
        height,
        scenes: description.scenes.map(({ offset, bytes, count }) => ({ offset, bytes, count })),
      };
      const pair = `endpoint-${seen.size - 1}`;
      // The whole climb is the one being left (the first drag frame); the dark one arrives
      // from its slot's edge. A hold at W = 1 or 0 draws the same either way round.
      for (const [end, whole, swap, codes] of [
        ['start', frame.lower, [1, 0, 1], [0, 1]],
        ['end', frame.upper, [0, 1, 1], [2, 0]],
      ]) {
        add(`${pair}-${end}-look`, frame.packet, frame.lower, frame.upper, swap, codes, frame.look, true);
        add(`${pair}-${end}-still`, frame.packet, whole, whole, [1, 0, 1], [0, 0], null, false);
        checks.push({
          name: `${pair}-${end}`,
          sheet: sheet.id,
          packet: frame.packet,
          lower: frame.lower,
          upper: frame.upper,
          end,
        });
      }
    }
  }
  if (checks.length === 0) throw new Error("No pairs on I's sheets");
  writeFileSync(join(exported, 'frames.tsv'), table);
  writeFileSync(join(exported, 'frames.json'), JSON.stringify({ packets, frames: rows }, null, 2));
  console.log(JSON.stringify({ status: 'ENDPOINT_FRAMES', checks: checks.length, frames: rows.length }));
  return checks;
}

// 1. The Metal side: the frames' uniforms and Swift look words, from the preview renderer.
// With --endpoints there is no Metal side: the frames come from the plan directly.
const preview = join(build, 'board-motion-preview');
const endpointChecks = endpoints ? writeEndpointFrames() : [];
if (!endpoints) {
  for (const name of ['BaselineShader', 'BeforeFixShader']) {
    const source = run('git', ['-C', repository, 'show', `${baselineRef}:${METAL_SHADER}`]);
    writeFileSync(join(build, `${name}.swift`), source.replace('enum ClimbOverlayShader {', `enum ${name} {`));
  }
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
}

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
        File(shaders, "after.frag").writeText(OverlayShader.lookFragment)
        File(shaders, "base.vert").writeText(OverlayShader.vertex)
        File(shaders, "base.frag").writeText(OverlayShader.fragment)
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
        val out = OverlaySwapLook.Frame()
        for (index in 0 until frames.length()) {
            val frame = frames.getJSONObject(index)
            val values = frame.optJSONArray("look")?.let { array -> (0 until array.length()).map { array.getDouble(it) } }
            val swap = frame.getJSONArray("swap")
            val codes = frame.getJSONArray("codes")
            val lower = frame.getInt("lower")
            val upper = frame.getInt("upper")
            val look = values?.let { OverlaySwapLook.Look.parse(it) ?: error("Bad look") }
            val packet = scenes.getValue(frame.getString("packet"))
            // No words: the renderer draws the base program; the device reads a zero header as that.
            val count = if (look == null || lower == upper || !packet.decoded) 0 else
                out.encode(packet.scene(lower, false), packet.scene(upper, true),
                    swap.getDouble(0).toFloat(), codes.getInt(0), swap.getDouble(1).toFloat(), codes.getInt(1),
                    frame.getDouble("sharedFloor").toFloat(), look, false, true)
            val bytes = if (count == 0) ByteBuffer.wrap(ByteArray(8)) else OverlaySwapLook.bytes(out.words, count, target)
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
for (const file of ['after.vert', 'after.frag', 'base.vert', 'base.frag', 'baseline.vert', 'baseline.frag'])
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

// 6. Metal (Swift words) against GLES (Kotlin words), frame by frame; or, with
// --endpoints, each look frame at a swap's end against the still frame, pixel for pixel.
if (endpoints) {
  const results = endpointChecks.map((check) => {
    const look = readFileSync(join(raw, `${check.name}-look.rgba`));
    const still = readFileSync(join(raw, `${check.name}-still.rgba`));
    if (look.length !== still.length) throw new Error(`${check.name}: frame sizes differ`);
    let changedPixels = 0;
    let maxChannelDifference = 0;
    for (let pixel = 0; pixel < look.length; pixel += 4) {
      let largest = 0;
      for (let channel = 0; channel < 4; channel++)
        largest = Math.max(largest, Math.abs(look[pixel + channel] - still[pixel + channel]));
      if (largest > 0) changedPixels++;
      maxChannelDifference = Math.max(maxChannelDifference, largest);
    }
    return { ...check, changedPixels, maxChannelDifference };
  });
  const differing = results.filter((result) => result.changedPixels > 0).length;
  const status = differing === 0 ? 'PASS_ENDPOINTS_MATCH_STILL' : 'FAIL_ENDPOINTS_DIFFER';
  writeFileSync(
    join(out, 'endpoints.json'),
    JSON.stringify({ status, checks: results.length, differing, rows: results }, null, 2),
  );
  console.log(JSON.stringify({ status, checks: results.length, differing }));
  if (!keepRaw) for (const file of readdirSync(raw).filter((name) => name.endsWith('.rgba'))) rmSync(join(raw, file));
  if (differing > 0) process.exit(4);
  process.exit(0);
}
const compared = run(preview, ['compare', work, exported, raw, join(out, 'compare')], { timeout: 3_600_000 }).trim();
console.log(compared);
if (!keepRaw) for (const file of readdirSync(raw).filter((name) => name.endsWith('.rgba'))) rmSync(join(raw, file));
