import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { load, fileSha256, sha256, imageDifference, requireCondition as check, save } from './lib.mjs';
export function verifyPrepared(work) {
  const prepared = load(join(work, 'prepared.json'));
  check(prepared.status === 'PREPARED_ONE_RICH_42_NOT_EXECUTED', 'Invalid preparation');
  for (const [path, expected] of Object.entries(prepared.files))
    check(fileSha256(join(work, path)) === expected, `Prepared file changed: ${path}`);
  return prepared;
}
/** How far an intermediate class's measured weight may sit from its uniform weight. */
export const SWAP_WEIGHT_TOLERANCE = 0.08;

/**
 * Pixel expectations for the swap that owe nothing to either shader: hold
 * classes from the fixture, and the production Rust stills of the current (A)
 * and next (B) climbs. Inside the bounds of holds only one side lights, away
 * from every other hold's reach, a side at weight 0 must match the other
 * side's still within one byte, and any other weight w must move the pixels
 * from the other still toward its own by w (within the tolerance). Shared
 * holds, where the two stills agree exactly, must match within one byte when
 * whole (the third swap weight absent or 1). At a shared weight w below 1 they
 * are measured the same way inside their own bounds, away from other holds'
 * reach: from the bare veil, which is all a hold at weight 0 leaves, toward the
 * stills by w; at 0 they must match the veil within one byte.
 */
export function swapClassChecks(classes, stills, image, sample) {
  const { width, height } = classes;
  /** Marks (1) or clears (0) a hold's bounds grown by `pad` pixels. */
  const paint = (mask, id, pad, value) => {
    const { bounds } = classes.holds[id];
    const left = Math.max(0, Math.floor(bounds[0] - pad)),
      top = Math.max(0, Math.floor(bounds[1] - pad));
    const right = Math.min(width, Math.ceil(bounds[2] + pad)),
      bottom = Math.min(height, Math.ceil(bounds[3] + pad));
    for (let y = top; y < bottom; y++) mask.fill(value, y * width + left, y * width + right);
  };
  /** The bounds of `ids`, less everything within glow reach of any other lit hold. */
  const region = (ids) => {
    const mask = new Uint8Array(width * height);
    for (const id of ids) paint(mask, id, 0, 1);
    for (const id of Object.keys(classes.holds).map(Number))
      if (!ids.includes(id)) paint(mask, id, classes.holds[id].reach + 2, 0);
    return mask;
  };
  const distance = (first, second, pixel) => {
    let sum = 0;
    for (let channel = 0; channel < 4; channel++)
      sum += Math.abs(first[pixel * 4 + channel] - second[pixel * 4 + channel]);
    return sum;
  };
  const largest = (first, second, pixel) => {
    let maximum = 0;
    for (let channel = 0; channel < 4; channel++)
      maximum = Math.max(maximum, Math.abs(first[pixel * 4 + channel] - second[pixel * 4 + channel]));
    return maximum;
  };
  // Slot 0 is the current climb (A); slots 1 and 2 hold B in this fixture.
  const climbOf = (slot) => (slot === 0 ? 'A' : 'B');
  const lower = climbOf(sample.lower),
    upper = climbOf(sample.upper);
  check(lower !== upper, 'Swap class checks need a pair of different climbs');
  const only = { A: region(classes.currentOnly), B: region(classes.nextOnly) };
  const rows = [];
  for (const [climb, weight] of [
    [lower, sample.swap[0]],
    [upper, sample.swap[1]],
  ]) {
    const own = stills[climb],
      other = stills[climb === 'A' ? 'B' : 'A'],
      mask = only[climb];
    let pixels = 0,
      worst = 0,
      moved = 0,
      span = 0;
    for (let pixel = 0; pixel < mask.length; pixel++) {
      if (!mask[pixel]) continue;
      pixels++;
      worst = Math.max(worst, largest(image, other, pixel));
      moved += distance(image, other, pixel);
      span += distance(own, other, pixel);
    }
    check(pixels >= 500 && span > 0, `Too few ${climb}-only pixels to judge the swap`);
    const measured = moved / span;
    if (weight === 0) check(worst <= 1, `${sample.name}: ${climb}-only holds are lit at weight 0`);
    else
      check(
        Math.abs(measured - weight) <= SWAP_WEIGHT_TOLERANCE,
        `${sample.name}: ${climb}-only holds at ${measured.toFixed(3)}, not ${weight}`,
      );
    rows.push({ climb, weight, measured, pixels, worstAgainstOtherStill: worst });
  }
  const sharedWeight = sample.swap[2] ?? 1;
  if (sharedWeight === 1) {
    const shared = new Uint8Array(width * height);
    for (const id of classes.shared) paint(shared, id, 0, 1);
    let sharedPixels = 0,
      sharedWorst = 0;
    for (let pixel = 0; pixel < shared.length; pixel++) {
      if (!shared[pixel] || largest(stills.A, stills.B, pixel) !== 0) continue;
      sharedPixels++;
      sharedWorst = Math.max(sharedWorst, largest(image, stills.A, pixel));
    }
    check(sharedPixels >= 1000, 'Too few shared-hold pixels to judge the swap');
    check(sharedWorst <= 1, `${sample.name}: shared holds differ from both stills`);
    return { classes: rows, sharedWeight, sharedPixels, sharedWorst };
  }
  /** Summed and largest channel distance of one pixel from the bare veil. */
  const fromVeil = (source, pixel) => {
    let sum = 0,
      maximum = 0;
    for (let channel = 0; channel < 4; channel++) {
      const error = Math.abs(source[pixel * 4 + channel] - classes.veil[channel]);
      sum += error;
      maximum = Math.max(maximum, error);
    }
    return [sum, maximum];
  };
  const mask = region(classes.shared);
  let sharedPixels = 0,
    sharedWorst = 0,
    moved = 0,
    span = 0;
  for (let pixel = 0; pixel < mask.length; pixel++) {
    if (!mask[pixel] || largest(stills.A, stills.B, pixel) !== 0) continue;
    const [imageSum, imageWorst] = fromVeil(image, pixel);
    sharedPixels++;
    sharedWorst = Math.max(sharedWorst, imageWorst);
    moved += imageSum;
    span += fromVeil(stills.A, pixel)[0];
  }
  check(sharedPixels >= 500 && span > 0, 'Too few shared-hold pixels to judge the shared weight');
  const sharedMeasured = moved / span;
  if (sharedWeight === 0) check(sharedWorst <= 1, `${sample.name}: shared holds are lit at weight 0`);
  else
    check(
      Math.abs(sharedMeasured - sharedWeight) <= SWAP_WEIGHT_TOLERANCE,
      `${sample.name}: shared holds at ${sharedMeasured.toFixed(3)}, not ${sharedWeight}`,
    );
  return { classes: rows, sharedWeight, sharedPixels, sharedWorstAgainstVeil: sharedWorst, sharedMeasured };
}

export function analyse(work, renders, backend) {
  verifyPrepared(work);
  const metadata = load(join(work, 'inputs/inputs.json'));
  const native = load(join(renders, 'result.json'));
  check(native.status === `PASS_ACTUAL_${backend}_RICH_42`, 'Native comparison did not pass');
  check(
    native.width === 1080 && native.height === 1504 && native.commandsCompleted === 84,
    'Native dimensions/counts changed',
  );
  check(native.compiledContractSha256 === metadata.contractSha256, 'Native compiled contract changed');
  check(native.trackedOwnedAllocationBytes <= 134217728, 'Owned allocation budget exceeded');
  const expectedFiles = [
    'result.json',
    ...metadata.samples.flatMap((sample) => [`${sample.name}-old.rgba`, `${sample.name}-new.rgba`]),
  ].sort((first, second) => first.localeCompare(second));
  check(
    JSON.stringify(readdirSync(renders).sort((first, second) => first.localeCompare(second))) ===
      JSON.stringify(expectedFiles),
    'Missing/unexpected output files',
  );
  check(
    JSON.stringify(native.samples.map((sample) => sample.name)) ===
      JSON.stringify(metadata.samples.map((sample) => sample.name)),
    'Native sample order changed',
  );
  const rows = [],
    hashes = new Map();
  const raw = (name) => {
    const path = join(renders, name);
    check(statSync(path).size === 1080 * 1504 * 4, 'Raw image length changed');
    return readFileSync(path);
  };
  for (const [index, sample] of metadata.samples.entries()) {
    const old = raw(`${sample.name}-old.rgba`),
      actual = raw(`${sample.name}-new.rgba`);
    const difference = imageDifference(old, actual);
    const nativeRow = native.samples[index];
    check(
      difference.maxChannelError === nativeRow.maxChannelError &&
        difference.pixelsOverOne === nativeRow.pixelsOverOne &&
        difference.changedPixels === nativeRow.changedPixels,
      'Native/host diff accounting mismatch',
    );
    check(
      difference.maxChannelError <= 1 && difference.pixelsOverOne === 0,
      `Old/new shader pixels differ: ${sample.name}`,
    );
    const oldSha256 = sha256(old),
      newSha256 = sha256(actual);
    if (nativeRow.oldRgbaSha256)
      check(
        nativeRow.oldRgbaSha256 === oldSha256 && nativeRow.newRgbaSha256 === newSha256,
        'Native output hash mismatch',
      );
    hashes.set(`${sample.name}-old`, oldSha256);
    hashes.set(`${sample.name}-new`, newSha256);
    let oracle = null;
    if (sample.oracle) {
      check(fileSha256(join(work, sample.oracle.name)) === sample.oracle.sha256, 'Rust oracle file changed');
      const reference = readFileSync(join(work, sample.oracle.name));
      const before = imageDifference(reference, old),
        after = imageDifference(reference, actual);
      check(
        before.maxChannelError <= 1 &&
          before.pixelsOverOne === 0 &&
          after.maxChannelError <= 1 &&
          after.pixelsOverOne === 0,
        `Independent production Rust still oracle differs: ${sample.name}`,
      );
      oracle = { sha256: sample.oracle.sha256, pulse: sample.oracle.pulse, old: before, new: after };
    }
    rows.push({
      name: sample.name,
      ...difference,
      oldRgbaSha256: oldSha256,
      newRgbaSha256: newSha256,
      rustOracle: oracle,
    });
  }
  for (const mode of ['old', 'new']) {
    check(hashes.get(`forward-0-m0-${mode}`) !== hashes.get(`forward-4-m0-${mode}`), 'Progress is vacuous');
    check(
      hashes.get(`editor-0-m0-${mode}`) !== hashes.get(`editor-1-m0-${mode}`) &&
        hashes.get(`editor-1-m0-${mode}`) !== hashes.get(`editor-2-m0-${mode}`),
      'Pulse is vacuous',
    );
    check(hashes.get(`forward-2-m0-${mode}`) !== hashes.get(`forward-2-m1-${mode}`), 'Display mirror is vacuous');
    check(hashes.get(`previous-0-m0-${mode}`) !== hashes.get(`forward-1-m0-${mode}`), 'Previous selector is vacuous');
    for (const mirror of [0, 1])
      for (let index = 0; index < 5; index++)
        check(
          hashes.get(`forward-${index}-m${mirror}-${mode}`) === hashes.get(`reverse-${4 - index}-m${mirror}-${mode}`),
          'Reverse control replay differs',
        );
    // The swap settles on the same stills as the wipe, ignores the display
    // mirror (position plays no part), and each weight change shows.
    check(hashes.get(`swap-0-m0-${mode}`) === hashes.get(`forward-0-m0-${mode}`), 'Swap rest differs from still');
    check(hashes.get(`swap-4-m0-${mode}`) === hashes.get(`forward-4-m0-${mode}`), 'Swap end differs from still');
    check(hashes.get(`swap-2-m0-${mode}`) === hashes.get(`swap-2-m1-${mode}`), 'Swap depends on display mirror');
    for (const [first, second] of [
      ['swap-0-m0', 'swap-1-m0'],
      ['swap-1-m0', 'swap-2-m0'],
      ['swap-2-m0', 'swap-3-m0'],
      ['swap-3-m0', 'swap-4-m0'],
      ['swap-previous-0-m0', 'swap-previous-1-m0'],
      // The shared weight shows, and dark shared holds keep a settled pair off the still.
      ['swap-shared-1-m0', 'swap-2-m0'],
      ['swap-shared-0-m0', 'swap-1-m0'],
      ['swap-shared-3-m0', 'swap-0-m0'],
    ])
      check(hashes.get(`${first}-${mode}`) !== hashes.get(`${second}-${mode}`), 'Swap weights are vacuous');
  }
  // The swap's arithmetic against the Rust stills, independently of both shaders.
  const stillFor = (name) => {
    const oracle = metadata.samples.find((sample) => sample.name === name)?.oracle;
    check(oracle && fileSha256(join(work, oracle.name)) === oracle.sha256, 'Swap still oracle missing or changed');
    return readFileSync(join(work, oracle.name));
  };
  const stills = { A: stillFor('swap-0-m0'), B: stillFor('swap-4-m0') };
  const swapClasses = {};
  for (const sample of metadata.samples.filter((candidate) => candidate.swap && !candidate.oracle))
    for (const mode of ['old', 'new'])
      swapClasses[`${sample.name}-${mode}`] = swapClassChecks(
        metadata.swapClasses,
        stills,
        raw(`${sample.name}-${mode}.rgba`),
        sample,
      );
  verifyPrepared(work);
  return {
    status: `PASS_INDEPENDENT_${backend}_RICH_42`,
    backend,
    nativeResultSha256: fileSha256(join(renders, 'result.json')),
    preparedSha256: fileSha256(join(work, 'prepared.json')),
    fixtureSha256: fileSha256(join(work, 'config.json')),
    samples: 42,
    commands: 84,
    rustStillComparisons: rows.filter((row) => row.rustOracle).length,
    maximumChannelError: Math.max(...rows.map((row) => row.maxChannelError)),
    pixelsOverOne: rows.reduce((sum, row) => sum + row.pixelsOverOne, 0),
    rows,
    swapClasses,
    qualification:
      'One offscreen fixture. Old/new weighted union comparison; independent production Rust still/pulse endpoints; swap hold classes measured against the two Rust stills (zero weights within one byte, other weights within the tolerance, whole shared holds within one byte of the stills, dimmed shared holds measured from the bare veil toward the stills). Host Metal, physical iPhone Metal and Pixel GLES are separately identified. No Rust weighted-union, gesture-cadence, scanout, full-UI frame-time or population claim.',
  };
}
export function saveAnalysis(work, renders, backend, path) {
  const result = analyse(work, renders, backend);
  save(path, result);
  return result;
}
