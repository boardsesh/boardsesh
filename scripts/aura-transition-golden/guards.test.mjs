import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { load, validateControls, imageDifference, fileSha256, sha256 } from './lib.mjs';
import { swapClassChecks } from './analyse.mjs';
import { buildCatalogueGpuConfig } from '../gpu-atlas-census.ts';
import { listCatalogueEntries } from '../../packages/shared/board-render/src/render-version-projection.ts';
const here = dirname(fileURLToPath(import.meta.url));
const controls = () => structuredClone(load(join(here, 'controls.json')));

await test('one real catalogue fixture retains its native dimensions, aliases and rich union', () => {
  const fixture = load(join(here, 'fixture.json'));
  const entry = listCatalogueEntries().find(
    (candidate) => candidate.boardName === 'kilter' && candidate.layoutId === 8 && candidate.sizeId === 25,
  );
  const config = buildCatalogueGpuConfig(entry);
  assert.deepEqual(
    [config.board_width, config.board_height, config.output_width, config.holds.length],
    [1080, 1504, 1080, 499],
  );
  const parse = (frames) => [...frames.matchAll(/p(\d+)r(\d+)/g)].map((token) => [Number(token[1]), Number(token[2])]);
  const current = parse(fixture.current),
    next = parse(fixture.next);
  assert.deepEqual([current.length, parse(fixture.previous).length, next.length], [6, 7, 7]);
  const currentIds = new Set(current.map(([id]) => id)),
    nextIds = new Set(next.map(([id]) => id));
  assert.equal([...currentIds].filter((id) => !nextIds.has(id)).length, 2);
  assert.equal([...nextIds].filter((id) => !currentIds.has(id)).length, 3);
  for (const [id, state] of [...current, ...next]) {
    assert.ok(config.holds.some((hold) => hold.id === id));
    assert.ok(config.hold_state_map[state]);
  }
  assert.deepEqual(config.hold_state_map[42], config.hold_state_map[12]);
  assert.deepEqual(config.hold_state_map[43], config.hold_state_map[13]);
  assert.deepEqual(config.hold_state_map[44], config.hold_state_map[14]);
});
await test('forty-two controls include forward and reverse sequences, both source pairs, truthful editor pulses and the wall swap', () => {
  assert.equal(validateControls(controls()).samples.length, 42);
  assert.equal(controls().samples.filter((sample) => sample.editorAllChanged).length, 6);
  const swaps = controls().samples.filter((sample) => sample.swap);
  assert.equal(swaps.length, 12);
  assert.ok(swaps.every((sample) => sample.progress === 0 && sample.pulse === 1));
  assert.deepEqual(
    swaps.map((sample) => sample.swap),
    [
      [1, 0],
      [0.4, 0],
      [0.25, 0.3],
      [0, 0.6],
      [0, 1],
      [0.25, 0.3],
      [0.2, 0.4],
      [0, 0.6],
      [0.4, 0, 0.4],
      [0.25, 0.3, 0.4],
      [0, 0.6, 0.6],
      [1, 0, 0],
    ],
  );
});
for (const [name, mutate] of [
  ['missing sample', (record) => record.samples.pop()],
  [
    'duplicate name',
    (record) => {
      record.samples[1].name = record.samples[0].name;
    },
  ],
  [
    'unsafe name',
    (record) => {
      record.samples[0].name = '../pixels';
    },
  ],
  ['wrong order', (record) => record.samples.reverse()],
  [
    'unregistered progress',
    (record) => {
      record.samples[1].progress = 0.1;
    },
  ],
  [
    'missing previous selector',
    (record) => {
      record.samples[29].lower = 0;
    },
  ],
  [
    'editor interior',
    (record) => {
      record.samples[21].progress = 0.5;
    },
  ],
  [
    'nonfinite pulse',
    (record) => {
      record.samples[21].pulse = NaN;
    },
  ],
  [
    'wrong editor mask',
    (record) => {
      record.samples[21].editorAllChanged = false;
    },
  ],
  [
    'unknown field',
    (record) => {
      record.samples[0].unused = 0;
    },
  ],
  [
    'swap weight out of range',
    (record) => {
      record.samples[31].swap = [1.5, 0];
    },
  ],
  [
    'swap with wipe progress',
    (record) => {
      record.samples[31].progress = 0.5;
    },
  ],
  [
    'swap weights on a wipe control',
    (record) => {
      record.samples[1].swap = [0.4, 0];
    },
  ],
  [
    'changed swap sequence',
    (record) => {
      record.samples[32].swap = [0.3, 0.3];
    },
  ],
  [
    'missing swap weights',
    (record) => {
      delete record.samples[33].swap;
    },
  ],
  [
    'shared weight out of range',
    (record) => {
      record.samples[38].swap = [0.4, 0, 1.2];
    },
  ],
  [
    'four swap weights',
    (record) => {
      record.samples[38].swap = [0.4, 0, 0.4, 0.4];
    },
  ],
  [
    'changed shared weight',
    (record) => {
      record.samples[39].swap = [0.25, 0.3];
    },
  ],
])
  await test('rejects ' + String(name) + ' before execution', () => {
    const record = controls();
    mutate(record);
    assert.throws(() => validateControls(record));
  });
await test('byte comparison retains errors over one and never changes the threshold', () => {
  const reference = Buffer.from([1, 2, 3, 4, 10, 20, 30, 40]);
  const actual = Buffer.from([2, 2, 3, 4, 10, 22, 30, 40]);
  const result = imageDifference(reference, actual);
  assert.equal(result.maxChannelError, 2);
  assert.equal(result.pixelsOverOne, 1);
  assert.equal(result.changedPixels, 2);
  assert.throws(() => imageDifference(reference, actual.subarray(4)));
});
await test('frozen full-scan shader fixtures match their source/runtime provenance', () => {
  const provenance = load(join(here, 'reference/provenance.json'));
  assert.equal(fileSha256(join(here, 'reference/metal.swift')), provenance.metalSourceSha256);
  assert.equal(fileSha256(join(here, 'reference/gles.vert')), provenance.glesVertexRuntimeSha256);
  assert.equal(fileSha256(join(here, 'reference/gles.frag')), provenance.glesFragmentRuntimeSha256);
  assert.match(readFileSync(join(here, 'reference/metal.swift'), 'utf8'), /enum ClimbOverlayShader/);
});

await test('deleting the marked amendments, newest first, restores each pre-amendment shader', () => {
  const provenance = load(join(here, 'reference/provenance.json'));
  /** Each amendment's block markers, in the order the amendments were made. */
  const markers = {
    'wall-swap': ['Wall-swap amendment', 'End wall-swap amendment.'],
    'shared-dip': ['Shared-dip amendment', 'End shared-dip amendment.'],
  };
  assert.deepEqual(
    provenance.amendments.map((amendment) => amendment.change),
    Object.keys(markers),
  );
  const strip = (text, [start, end]) =>
    text.replace(new RegExp(`[ \\t]*// ${start}[^\\n]*\\n(?:.*\\n)*?[ \\t]*// ${end.replace('.', '\\.')}\\n`, 'g'), '');
  for (const [name, field] of [
    ['reference/metal.swift', 'preAmendmentMetalSourceSha256'],
    ['reference/gles.frag', 'preAmendmentGlesFragmentRuntimeSha256'],
  ]) {
    let text = readFileSync(join(here, name), 'utf8');
    for (const amendment of [...provenance.amendments].reverse()) {
      const marker = markers[amendment.change];
      assert.equal(text.split(`// ${marker[0]}`).length, 2, `${name} has one ${amendment.change} block`);
      text = strip(text, marker);
      assert.equal(
        sha256(Buffer.from(text)),
        amendment[field],
        `${name} differs outside its ${amendment.change} block`,
      );
    }
  }
});

await test('swap class checks fail a shader that swaps the lower and upper weights', () => {
  // A one-row board: A lights pixels 0-999, both share 2000-2999, B lights
  // 3000-3999; everything else is background 10.
  const width = 4000;
  const strip = (lit) => {
    const bytes = Buffer.alloc(width * 4, 10);
    for (const [from, to, value] of lit) bytes.fill(value, from * 4, to * 4);
    return bytes;
  };
  const stills = {
    A: strip([
      [0, 1000, 210],
      [2000, 3000, 160],
    ]),
    B: strip([
      [2000, 3000, 160],
      [3000, 4000, 110],
    ]),
  };
  const classes = {
    width,
    height: 1,
    currentOnly: [1],
    nextOnly: [3],
    shared: [2],
    changed: [],
    holds: {
      1: { bounds: [0, 0, 1000, 1], reach: 0 },
      2: { bounds: [2000, 0, 3000, 1], reach: 0 },
      3: { bounds: [3002, 0, 4000, 1], reach: 0 },
    },
  };
  // A compositor that scales each side's own pixels by its weight.
  const frame = (currentWeight, nextWeight) =>
    strip([
      [0, 1000, Math.round(10 + 200 * currentWeight)],
      [2000, 3000, 160],
      [3000, 4000, Math.round(10 + 100 * nextWeight)],
    ]);
  const sample = { name: 'swap-1-m0', lower: 0, upper: 2, swap: [0.4, 0] };
  const result = swapClassChecks(classes, stills, frame(0.4, 0), sample);
  assert.ok(result.classes.every((row) => Math.abs(row.measured - row.weight) < 0.01));
  // The lower and upper weights swapped: A-only holds dark, B-only holds lit.
  assert.throws(() => swapClassChecks(classes, stills, frame(0, 0.4), sample), /A-only holds at 0\.000/);
  assert.throws(() => swapClassChecks(classes, stills, frame(0.4, 0.4), sample), /B-only holds are lit/);
});

await test('swap class checks measure dimmed shared holds from the veil and fail a shader that ignores them', () => {
  // The same one-row board, with the bare veil at 10 and shared holds lit at 160.
  const width = 4000;
  const strip = (lit) => {
    const bytes = Buffer.alloc(width * 4, 10);
    for (const [from, to, value] of lit) bytes.fill(value, from * 4, to * 4);
    return bytes;
  };
  const stills = {
    A: strip([
      [0, 1000, 210],
      [2000, 3000, 160],
    ]),
    B: strip([
      [2000, 3000, 160],
      [3000, 4000, 110],
    ]),
  };
  const classes = {
    width,
    height: 1,
    veil: [10, 10, 10, 10],
    currentOnly: [1],
    nextOnly: [3],
    shared: [2],
    changed: [],
    holds: {
      1: { bounds: [0, 0, 1000, 1], reach: 0 },
      2: { bounds: [2000, 0, 3000, 1], reach: 0 },
      3: { bounds: [3002, 0, 4000, 1], reach: 0 },
    },
  };
  // A compositor that scales each class's own pixels by its weight.
  const frame = (currentWeight, nextWeight, sharedWeight) =>
    strip([
      [0, 1000, Math.round(10 + 200 * currentWeight)],
      [2000, 3000, Math.round(10 + 150 * sharedWeight)],
      [3000, 4000, Math.round(10 + 100 * nextWeight)],
    ]);
  const sample = { name: 'swap-shared-1-m0', lower: 0, upper: 2, swap: [0.25, 0.3, 0.4] };
  const result = swapClassChecks(classes, stills, frame(0.25, 0.3, 0.4), sample);
  assert.ok(Math.abs(result.sharedMeasured - 0.4) < 0.01);
  // Shared holds left whole (native API 6), or given the lower-only weight: both fail.
  assert.throws(() => swapClassChecks(classes, stills, frame(0.25, 0.3, 1), sample), /shared holds at 1\.000/);
  assert.throws(() => swapClassChecks(classes, stills, frame(0.25, 0.3, 0.25), sample), /shared holds at 0\.25/);
  // Weight 0 must leave exactly the veil.
  const dark = { name: 'swap-shared-3-m0', lower: 0, upper: 2, swap: [1, 0, 0] };
  assert.equal(swapClassChecks(classes, stills, frame(1, 0, 0), dark).sharedWorstAgainstVeil, 0);
  assert.throws(() => swapClassChecks(classes, stills, frame(1, 0, 0.1), dark), /shared holds are lit at weight 0/);
});

await test('cleanup never mistakes an offline device or denied proc read for an exited process', async () => {
  const { ownedProcessState } = await import('./lib.mjs');
  const command = '/data/local/tmp/owned-helper\0owned-root\0';
  assert.equal(ownedProcessState({ status: 0, stdout: Buffer.from(command) }, '123', command), 'same');
  assert.equal(ownedProcessState({ status: 0, stdout: Buffer.from('another-process\0') }, '123', command), 'different');
  assert.equal(
    ownedProcessState(
      { status: 1, stderr: Buffer.from('cat: /proc/123/cmdline: No such file or directory') },
      '123',
      command,
    ),
    'gone',
  );
  assert.equal(ownedProcessState({ status: 1, stderr: Buffer.from('device offline') }, '123', command), 'unknown');
  assert.equal(
    ownedProcessState({ status: 1, stderr: Buffer.from('cat: /proc/123/cmdline: Permission denied') }, '123', command),
    'unknown',
  );
  assert.equal(
    ownedProcessState({ status: null, error: new Error('timeout'), stderr: Buffer.alloc(0) }, '123', command),
    'unknown',
  );
});
