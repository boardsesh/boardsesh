import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export const requireCondition = (condition, message) => {
  if (!condition) throw new Error(message);
};
export const load = (path) => JSON.parse(readFileSync(path, 'utf8'));
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const fileSha256 = (path) => sha256(readFileSync(path));
export const save = (path, record) => {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(temporary, path);
};
export const newDirectory = (path) => {
  requireCondition(!existsSync(path), `Preserve existing output: ${path}`);
  mkdirSync(path, { recursive: true });
};
export const run = (executable, args, options = {}) => {
  const result = spawnSync(executable, args, { timeout: 180_000, maxBuffer: 1024 * 1024, ...options });
  if (result.error || result.status !== 0) {
    const error = new Error(`${executable} failed: ${result.error?.message ?? result.status}`);
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
  }
  return result;
};
export function argumentsMap(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    requireCondition(
      argv[index]?.startsWith('--') && argv[index + 1] && !argv[index + 1].startsWith('--'),
      'Expected --name value',
    );
    requireCondition(!options.has(argv[index]), `Duplicate argument: ${argv[index]}`);
    options.set(argv[index], argv[index + 1]);
  }
  return options;
}
export const requiredPath = (options, name) => {
  requireCondition(options.has(name), `Missing ${name}`);
  return resolve(options.get(name));
};
export function ownedProcessState(result, pid, expectedCommand) {
  if (!result.error && result.status === 0)
    return result.stdout.toString('utf8') === expectedCommand ? 'same' : 'different';
  const error = result.stderr?.toString('utf8') ?? '';
  if (!result.error && result.status === 1 && error.includes(`/proc/${pid}/cmdline`) && /No such file/.test(error))
    return 'gone';
  return 'unknown';
}
/**
 * Wall-swap controls after the thirty wipe/editor controls: name, slots, weights,
 * mirror. Weights are lower-only, upper-only and, when given, shared same-role
 * holds (default 1, fully lit, as native API 6 drew them).
 */
export const SWAP_CONTROLS = [
  ['swap-0-m0', 0, 2, [1, 0], false],
  ['swap-1-m0', 0, 2, [0.4, 0], false],
  ['swap-2-m0', 0, 2, [0.25, 0.3], false],
  ['swap-3-m0', 0, 2, [0, 0.6], false],
  ['swap-4-m0', 0, 2, [0, 1], false],
  ['swap-2-m1', 0, 2, [0.25, 0.3], true],
  ['swap-previous-0-m0', 1, 0, [0.2, 0.4], false],
  ['swap-previous-1-m0', 1, 0, [0, 0.6], false],
  // Shared holds dipping with the rest (native API 7): at the drag's commit
  // point, mid-swap below the floor, and back with the incoming holds. The last
  // is no state the app produces: shared holds dark at an otherwise settled pair,
  // which must still take the weighted compositor.
  ['swap-shared-0-m0', 0, 2, [0.4, 0, 0.4], false],
  ['swap-shared-1-m0', 0, 2, [0.25, 0.3, 0.4], false],
  ['swap-shared-2-m0', 0, 2, [0, 0.6, 0.6], false],
  ['swap-shared-3-m0', 0, 2, [1, 0, 0], false],
];
export const CONTROL_COUNT = 30 + SWAP_CONTROLS.length;
export function validateControls(controls) {
  requireCondition(
    controls?.version === 1 && Array.isArray(controls.samples) && controls.samples.length === CONTROL_COUNT,
    'Exactly forty-two controls required',
  );
  requireCondition(
    Object.keys(controls).every((key) => ['version', 'samples'].includes(key)),
    'Unknown control-list field',
  );
  const names = new Set();
  for (const sample of controls.samples) {
    requireCondition(
      sample &&
        typeof sample === 'object' &&
        Object.keys(sample).every((key) =>
          ['name', 'lower', 'upper', 'progress', 'pulse', 'mirrored', 'editorAllChanged', 'swap'].includes(key),
        ),
      'Unknown control field',
    );
    requireCondition(
      typeof sample.name === 'string' && /^[a-z0-9-]{1,64}$/.test(sample.name) && !names.has(sample.name),
      'Unique safe sample names required',
    );
    names.add(sample.name);
    requireCondition(
      [sample.lower, sample.upper].every((slot) => Number.isSafeInteger(slot) && slot >= 0 && slot < 3),
      'Invalid source slot',
    );
    requireCondition(
      Number.isFinite(sample.progress) && sample.progress >= 0 && sample.progress <= 1,
      'Invalid progress',
    );
    requireCondition(
      Number.isFinite(sample.pulse) &&
        sample.pulse >= 1 &&
        sample.pulse <= 1.35 &&
        typeof sample.mirrored === 'boolean',
      'Invalid pulse/mirror',
    );
    requireCondition(
      sample.editorAllChanged === undefined || typeof sample.editorAllChanged === 'boolean',
      'Invalid editor variant',
    );
    requireCondition(
      !sample.editorAllChanged || (sample.lower === 0 && sample.upper === 0 && sample.progress === 0),
      'Editor oracle requires current still',
    );
    requireCondition(
      sample.swap === undefined ||
        (Array.isArray(sample.swap) &&
          (sample.swap.length === 2 || sample.swap.length === 3) &&
          sample.swap.every((weight) => Number.isFinite(weight) && weight >= 0 && weight <= 1) &&
          sample.progress === 0 &&
          !sample.editorAllChanged),
      'Invalid swap weights',
    );
  }
  const expectedNames = [];
  for (const mirror of [0, 1])
    for (const direction of ['forward', 'reverse'])
      for (let index = 0; index < 5; index++) expectedNames.push(`${direction}-${index}-m${mirror}`);
  for (const mirror of [0, 1]) for (let index = 0; index < 3; index++) expectedNames.push(`editor-${index}-m${mirror}`);
  for (const mirror of [0, 1])
    for (let index = 0; index < 2; index++) expectedNames.push(`previous-${index}-m${mirror}`);
  for (const [name] of SWAP_CONTROLS) expectedNames.push(name);
  requireCondition(
    JSON.stringify(controls.samples.map((sample) => sample.name)) === JSON.stringify(expectedNames),
    'Fixed sample ordering changed',
  );
  for (const [name, lower, upper, weights, mirrored] of SWAP_CONTROLS) {
    const sample = controls.samples.find((candidate) => candidate.name === name);
    requireCondition(
      sample.lower === lower &&
        sample.upper === upper &&
        sample.mirrored === mirrored &&
        sample.pulse === 1 &&
        JSON.stringify(sample.swap) === JSON.stringify(weights),
      'Wall-swap sequence changed',
    );
  }
  requireCondition(
    controls.samples.filter((sample) => sample.swap !== undefined).length === SWAP_CONTROLS.length,
    'Only the registered swap controls carry weights',
  );
  const group = (prefix) => controls.samples.filter((sample) => sample.name.startsWith(prefix));
  requireCondition(
    group('forward-').length === 10 &&
      group('reverse-').length === 10 &&
      group('editor-').length === 6 &&
      group('previous-').length === 4,
    'Fixed thirty-control groups changed',
  );
  for (const mirrored of [false, true]) {
    for (const [prefix, progresses] of [
      ['forward-', [0, 0.25, 0.5, 0.75, 1]],
      ['reverse-', [1, 0.75, 0.5, 0.25, 0]],
    ]) {
      const samples = group(prefix).filter((sample) => sample.mirrored === mirrored);
      requireCondition(
        JSON.stringify(samples.map((sample) => sample.progress)) === JSON.stringify(progresses) &&
          samples.every(
            (sample) => sample.lower === 0 && sample.upper === 2 && sample.pulse === 1 && !sample.editorAllChanged,
          ),
        'Forward/reverse sequence changed',
      );
    }
    const editor = group('editor-').filter((sample) => sample.mirrored === mirrored);
    requireCondition(
      JSON.stringify(editor.map((sample) => sample.pulse)) === '[1,1.175,1.35]' &&
        editor.every((sample) => sample.editorAllChanged),
      'Editor pulse sequence changed',
    );
    const previous = group('previous-').filter((sample) => sample.mirrored === mirrored);
    requireCondition(
      JSON.stringify(previous.map((sample) => sample.progress)) === '[0.25,0.75]' &&
        previous.every(
          (sample) => sample.lower === 1 && sample.upper === 0 && sample.pulse === 1 && !sample.editorAllChanged,
        ),
      'Previous/current sequence changed',
    );
  }
  return controls;
}
export function imageDifference(reference, actual) {
  requireCondition(
    reference.length === actual.length && reference.length > 0 && reference.length % 4 === 0,
    'RGBA dimensions differ',
  );
  let maxChannelError = 0;
  let pixelsOverOne = 0;
  let changedPixels = 0;
  let squaredError = 0;
  for (let pixel = 0; pixel < reference.length; pixel += 4) {
    let maximum = 0;
    for (let channel = 0; channel < 4; channel++) {
      const error = Math.abs(reference[pixel + channel] - actual[pixel + channel]);
      maximum = Math.max(maximum, error);
      squaredError += error * error;
    }
    maxChannelError = Math.max(maxChannelError, maximum);
    if (maximum > 1) pixelsOverOne++;
    if (maximum > 0) changedPixels++;
  }
  return { maxChannelError, pixelsOverOne, changedPixels, rmse: Math.sqrt(squaredError / reference.length) };
}
