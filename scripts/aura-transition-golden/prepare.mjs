import { readFileSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCatalogueGpuConfig } from '../gpu-atlas-census.ts';
import { listCatalogueEntries } from '../../packages/shared/board-render/src/render-version-projection.ts';
import {
  argumentsMap,
  requiredPath,
  load,
  save,
  newDirectory,
  run,
  fileSha256,
  requireCondition as check,
} from './lib.mjs';
import { referencePacket } from './reference.mjs';
import { validateControls } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, '../..');
const moduleRoot = join(repository, 'packages/mobile/modules/climb-overlay-gpu');
const options = argumentsMap(process.argv.slice(2));
const output = requiredPath(options, '--out');
const packetCli = requiredPath(options, '--packet-cli');
const atlasCli = requiredPath(options, '--atlas-cli');
const renderCli = requiredPath(options, '--render-cli');
check(
  [...options.keys()].every((key) => ['--out', '--packet-cli', '--atlas-cli', '--render-cli'].includes(key)),
  'Unknown argument',
);
const fixture = load(join(here, 'fixture.json'));
const controls = validateControls(load(join(here, 'controls.json')));
check(
  fixture.version === 1 &&
    fixture.catalogue.boardName === 'kilter' &&
    fixture.catalogue.layoutId === 8 &&
    fixture.catalogue.sizeId === 25 &&
    JSON.stringify(fixture.catalogue.setIds) === '[26,27,28,29]',
  'Only the frozen rich fixture is supported',
);
check(
  fixture.previous === fixture.next && JSON.stringify(fixture.sourceCounts) === '[6,7,7]',
  'Previous/current source-selection fixture changed',
);
const entry = listCatalogueEntries().find(
  (candidate) =>
    candidate.boardName === fixture.catalogue.boardName &&
    candidate.layoutId === fixture.catalogue.layoutId &&
    candidate.sizeId === fixture.catalogue.sizeId &&
    JSON.stringify(candidate.setIds) === JSON.stringify(fixture.catalogue.setIds),
);
check(entry, 'Catalogue no longer contains the exact fixture');
const config = { ...buildCatalogueGpuConfig(entry), frames: '', mirrored: false, glyphs: fixture.glyphs };
check(
  config.output_width === fixture.dimensions[0] &&
    config.board_width === fixture.dimensions[0] &&
    config.board_height === fixture.dimensions[1],
  'Native resolution changed',
);
const source = {
  current: fixture.current,
  previous: fixture.previous,
  next: fixture.next,
  edit_baseline: fixture.editBaseline,
  strict: true,
};
const provenance = load(join(here, 'reference/provenance.json'));
for (const [name, expected] of [
  ['metal.swift', provenance.metalSourceSha256],
  ['gles.vert', provenance.glesVertexRuntimeSha256],
  ['gles.frag', provenance.glesFragmentRuntimeSha256],
])
  check(fileSha256(join(here, 'reference', name)) === expected, 'Frozen reference shader changed');
newDirectory(output);
const inputs = join(output, 'inputs');
newDirectory(inputs);
save(join(output, 'config.json'), config);
save(join(output, 'source-request.json'), source);
copyFileSync(join(here, 'controls.json'), join(output, 'controls.json'));
const commands = [];
const command = (executable, args) => {
  const result = run(executable, args, { timeout: 60_000 });
  const name = `command-${commands.length}`;
  writeFileSync(join(output, `${name}.stdout`), result.stdout);
  writeFileSync(join(output, `${name}.stderr`), result.stderr);
  commands.push({
    executableSha256: fileSha256(executable),
    arguments: args.map((argument) => (argument.startsWith(output) ? argument.slice(output.length) : argument)),
    stdoutSha256: fileSha256(join(output, `${name}.stdout`)),
    stderrSha256: fileSha256(join(output, `${name}.stderr`)),
  });
};
try {
  command(atlasCli, [join(output, 'config.json'), join(output, 'full-atlas.bin')]);
  const full = readFileSync(join(output, 'full-atlas.bin'));
  const headerBytes = full.readUInt32LE(0);
  check(
    headerBytes > 0 && headerBytes <= 4 * 1024 * 1024 && headerBytes + 4 < full.length,
    'Full reference manifest bounds',
  );
  const manifest = JSON.parse(full.subarray(4, headerBytes + 4).toString('utf8'));
  check(
    manifest.width === fixture.dimensions[0] && manifest.height === fixture.dimensions[1] && manifest.covers === null,
    'Rich reference dimensions/covers changed',
  );
  const oldPixels = full.subarray(headerBytes + 4);
  writeFileSync(join(inputs, 'old-pixels.bin'), oldPixels);
  save(join(output, 'full-manifest.json'), manifest);
  command(packetCli, [
    join(output, 'config.json'),
    join(output, 'source-request.json'),
    join(output, 'packet'),
    join(output, 'controls.json'),
  ]);
  const packet = load(join(output, 'packet/packet.json'));
  const editor = load(join(output, 'packet/packet-editor.json'));
  check(
    packet.changed_count === 1 &&
      editor.changed_count === 6 &&
      packet.descriptorBytes === 224 &&
      packet.uniformBytes === 144,
    'Changed-mask or ABI changed',
  );
  check(JSON.stringify(packet.scenes) === JSON.stringify(editor.scenes), 'Editor variant changed scene layout');
  const newPixels = readFileSync(join(output, 'packet/pixels.bin'));
  const resources = readFileSync(join(output, 'packet/resources.bin'));
  check(
    oldPixels.length <= fixture.limits.maxOwnedGpuBytes &&
      newPixels.length <= fixture.limits.maxOwnedGpuBytes &&
      resources.length <= 8 * 1024 * 1024,
    'Payload bounds exceeded',
  );
  const reference = referencePacket(
    manifest,
    source,
    packet,
    load(join(output, 'packet/chunks.json')),
    oldPixels,
    newPixels,
    resources,
  );
  const paths = {};
  for (const variant of ['transition', 'editor']) {
    const actual = readFileSync(
      join(output, variant === 'editor' ? 'packet/descriptors-editor.bin' : 'packet/descriptors.bin'),
    );
    check(
      actual.equals(reference.expectedNewDescriptors[variant]),
      `Independent ${variant} descriptor encoding differs`,
    );
    writeFileSync(join(inputs, `old-descriptors-${variant}.bin`), reference.oldDescriptors[variant]);
    writeFileSync(join(inputs, `new-descriptors-${variant}.bin`), actual);
    paths[variant] = { old: `old-descriptors-${variant}.bin`, new: `new-descriptors-${variant}.bin` };
  }
  writeFileSync(join(inputs, 'old-resources.bin'), reference.lut);
  writeFileSync(join(inputs, 'new-resources.bin'), resources);
  writeFileSync(join(inputs, 'new-pixels.bin'), newPixels);
  const sampleRows = [];
  const oracleFiles = new Map();
  for (const sample of controls.samples) {
    const actualUniform = readFileSync(join(output, `packet/uniforms-${sample.name}.bin`));
    check(
      actualUniform.equals(reference.uniforms(sample, true)),
      `Independent144-byte control differs: ${sample.name}`,
    );
    writeFileSync(join(inputs, `new-uniforms-${sample.name}.bin`), actualUniform);
    writeFileSync(join(inputs, `old-uniforms-${sample.name}.bin`), reference.uniforms(sample, false));
    let oracle = null;
    // A still endpoint: a wipe at 0 or 1, or a swap with one side whole, the
    // other dark and shared holds whole.
    const [lowerWeight, upperWeight, sharedWeight = 1] = sample.swap ?? [];
    const stillSlot = sample.swap
      ? sharedWeight === 1 && lowerWeight === 1 && upperWeight === 0
        ? sample.lower
        : sharedWeight === 1 && lowerWeight === 0 && upperWeight === 1
          ? sample.upper
          : null
      : sample.progress === 0
        ? sample.lower
        : sample.progress === 1
          ? sample.upper
          : null;
    if (sample.editorAllChanged || stillSlot !== null) {
      const slot = sample.editorAllChanged ? sample.lower : stillSlot;
      const frame = [source.current, source.previous, source.next][slot];
      const pulse = sample.editorAllChanged ? sample.pulse : 1;
      const key = `${frame}/${pulse}`;
      if (!oracleFiles.has(key)) {
        const name = `oracle-${oracleFiles.size}`;
        const oracleConfig = {
          ...config,
          frames: frame,
          glow: {
            ...config.glow,
            reach_scale: Math.fround(Math.fround(config.glow.reach_scale ?? 1) * Math.fround(pulse)),
          },
        };
        save(join(output, `${name}.json`), oracleConfig);
        command(renderCli, [join(output, `${name}.json`), join(output, `${name}.png`), join(output, `${name}.rgba`)]);
        check(
          statSync(join(output, `${name}.rgba`)).size === manifest.width * manifest.height * 4,
          'Rust oracle dimensions changed',
        );
        oracleFiles.set(key, {
          name: `${name}.rgba`,
          sha256: fileSha256(join(output, `${name}.rgba`)),
          pulse,
          frames: frame,
        });
      }
      oracle = oracleFiles.get(key);
    }
    sampleRows.push({ ...sample, editorAllChanged: sample.editorAllChanged ?? false, oracle });
  }
  copyFileSync(join(here, 'reference/metal.swift'), join(output, 'ReferenceShader.original.swift'));
  const originalMetal = readFileSync(join(here, 'reference/metal.swift'), 'utf8');
  check(originalMetal.split('enum ClimbOverlayShader {').length === 2, 'Reference Swift envelope changed');
  writeFileSync(
    join(output, 'ReferenceShader.swift'),
    originalMetal.replace('enum ClimbOverlayShader {', 'enum ReferenceShader {'),
  );
  for (const name of ['ClimbOverlayShader.swift', 'ClimbOverlayPacketLayout.swift'])
    copyFileSync(join(moduleRoot, 'ios', name), join(output, name));
  for (const name of ['vert', 'frag']) copyFileSync(join(here, `reference/gles.${name}`), join(inputs, `old.${name}`));
  const metadata = {
    version: 1,
    width: manifest.width,
    height: manifest.height,
    contractSha256: packet.contractSha256,
    scenes: packet.scenes,
    samples: sampleRows,
    descriptorFiles: paths,
    proof: reference.proof,
    swapClasses: reference.swapClasses,
    pixelFiles: { old: 'old-pixels.bin', new: 'new-pixels.bin' },
    resourceFiles: { old: 'old-resources.bin', new: 'new-resources.bin' },
    limits: fixture.limits,
    shaderSources: {
      beforeMetalSha256: provenance.metalSourceSha256,
      afterMetalSha256: fileSha256(join(output, 'ClimbOverlayShader.swift')),
      afterMetalLayoutSha256: fileSha256(join(output, 'ClimbOverlayPacketLayout.swift')),
      beforeGlesVertexSha256: provenance.glesVertexRuntimeSha256,
      beforeGlesFragmentSha256: provenance.glesFragmentRuntimeSha256,
    },
    qualifications: [
      'Display mirror affects reveal direction; physical mirror placement is separate unit coverage.',
      'Editor still variant marks all current holds changed; this makes the production Rust global reach oracle valid.',
      'Interior frames compare the old full union to the new compositor; Rust does not render weighted animation unions.',
      'Wall-swap samples weight hold classes with uniform viewport.zw/motion.z and shared holds with tuning2.w; their still endpoints use the Rust oracle.',
    ],
  };
  save(join(inputs, 'inputs.json'), metadata);
  const files = new Map();
  for (const name of [
    'config.json',
    'source-request.json',
    'controls.json',
    'full-manifest.json',
    'ReferenceShader.swift',
    'ClimbOverlayShader.swift',
    'ClimbOverlayPacketLayout.swift',
    ...[...oracleFiles.values()].map((oracle) => oracle.name),
  ])
    files.set(name, fileSha256(join(output, name)));
  for (const name of [
    'inputs.json',
    'old-pixels.bin',
    'new-pixels.bin',
    'old-resources.bin',
    'new-resources.bin',
    'old.vert',
    'old.frag',
    ...Object.values(paths).flatMap((variant) => Object.values(variant)),
    ...sampleRows.flatMap((sample) => [`old-uniforms-${sample.name}.bin`, `new-uniforms-${sample.name}.bin`]),
  ])
    files.set(`inputs/${name}`, fileSha256(join(inputs, name)));
  save(join(output, 'prepared.json'), {
    status: 'PREPARED_ONE_RICH_42_NOT_EXECUTED',
    fixtureSha256: fileSha256(join(here, 'fixture.json')),
    controlsSha256: fileSha256(join(here, 'controls.json')),
    hostHelpers: Object.fromEntries(
      ['prepare.mjs', 'reference.mjs', 'lib.mjs', 'fixture.json', 'controls.json', 'reference/provenance.json'].map(
        (name) => [name, fileSha256(join(here, name))],
      ),
    ),
    sourceCli: { packet: fileSha256(packetCli), fullAtlas: fileSha256(atlasCli), render: fileSha256(renderCli) },
    proof: reference.proof,
    oracleCount: oracleFiles.size,
    files: Object.fromEntries(files),
    commands,
    qualification:
      'Generated input/reference artifacts only. Actual host/phone results require separate identity-bound runs. No generated binaries belong in the repository.',
  });
  console.log(
    JSON.stringify({
      status: 'PREPARED_ONE_RICH_42_NOT_EXECUTED',
      output,
      proof: reference.proof,
      oracleCount: oracleFiles.size,
      preparedSha256: fileSha256(join(output, 'prepared.json')),
    }),
  );
} catch (error) {
  if (error.stdout) writeFileSync(join(output, 'failed-command.stdout'), error.stdout);
  if (error.stderr) writeFileSync(join(output, 'failed-command.stderr'), error.stderr);
  save(join(output, 'invalid.json'), {
    message: error.message,
    qualification: 'Preparation failed; no GPU result accepted.',
  });
  throw error;
}
