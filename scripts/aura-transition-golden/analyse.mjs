import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { load, fileSha256, sha256, imageDifference, requireCondition as check, save } from './lib.mjs';
export function verifyPrepared(work) {
  const prepared = load(join(work, 'prepared.json'));
  check(prepared.status === 'PREPARED_ONE_RICH_30_NOT_EXECUTED', 'Invalid preparation');
  for (const [path, expected] of Object.entries(prepared.files))
    check(fileSha256(join(work, path)) === expected, `Prepared file changed: ${path}`);
  return prepared;
}
export function analyse(work, renders, backend) {
  verifyPrepared(work);
  const metadata = load(join(work, 'inputs/inputs.json'));
  const native = load(join(renders, 'result.json'));
  check(native.status === `PASS_ACTUAL_${backend}_RICH_30`, 'Native comparison did not pass');
  check(
    native.width === 1080 && native.height === 1504 && native.commandsCompleted === 60,
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
  }
  verifyPrepared(work);
  return {
    status: `PASS_INDEPENDENT_${backend}_RICH_30`,
    backend,
    nativeResultSha256: fileSha256(join(renders, 'result.json')),
    preparedSha256: fileSha256(join(work, 'prepared.json')),
    fixtureSha256: fileSha256(join(work, 'config.json')),
    samples: 30,
    commands: 60,
    rustStillComparisons: rows.filter((row) => row.rustOracle).length,
    maximumChannelError: Math.max(...rows.map((row) => row.maxChannelError)),
    pixelsOverOne: rows.reduce((sum, row) => sum + row.pixelsOverOne, 0),
    rows,
    qualification:
      'One offscreen fixture. Old/new weighted union comparison; independent production Rust still/pulse endpoints only. Host Metal, physical iPhone Metal and Pixel GLES are separately identified. No Rust weighted-union, gesture-cadence, scanout, full-UI frame-time or population claim.',
  };
}
export function saveAnalysis(work, renders, backend, path) {
  const result = analyse(work, renders, backend);
  save(path, result);
  return result;
}
