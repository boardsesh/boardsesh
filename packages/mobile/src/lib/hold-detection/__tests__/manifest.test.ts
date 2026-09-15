import { describe, expect, it } from 'vitest';

import { letterboxFitFor, parseModelManifest, selectInt8File } from '../manifest';

const VALID_INPUT = {
  width: 768,
  height: 768,
  layout: 'NCHW',
  dtype: 'float32',
  letterbox: 'stretch',
  normalization: { mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] },
};

const VALID_OUTPUTS = {
  boxes: { name: null, format: 'cxcywh-normalized' },
  logits: { name: null, activation: 'sigmoid', classes: 1 },
};

/** A body shaped exactly like what `ml/holds/publish_model.py` writes. */
function validManifest(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    version: '2026-09-15',
    family: 'rfdetr',
    config: 'nano-untiled-1024',
    input: { ...VALID_INPUT },
    outputs: { ...VALID_OUTPUTS },
    thresholds: { default: 0.6, sweep: [0.3, 0.5, 0.6, 0.7] },
    files: [
      { path: 'model-int8.onnx', bytes: 31_300_000, sha256: 'c'.repeat(64), dtype: 'int8' },
      { path: 'model.onnx', bytes: 107_000_000, sha256: 'd'.repeat(64), dtype: 'fp32' },
    ],
    training: { dataset: 'spray walls', licence: 'CC BY 4.0', epochs: 10, trainedOn: 'm5-max-mps', date: '2026-09-15' },
    eval: { sprayEvalF1: 0.659, weightedCorrectionsPerHold: 1.02, gestureSavings: 0.49 },
    licence: 'Apache-2.0',
  };
}

describe('parseModelManifest', () => {
  it('accepts a published manifest and keeps the fields the app reads', () => {
    const manifest = parseModelManifest(validManifest());

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      version: '2026-09-15',
      config: 'nano-untiled-1024',
      input: { width: 768, height: 768, letterbox: 'stretch' },
      outputs: { logits: { classes: 1 } },
      thresholds: { default: 0.6 },
      licence: 'Apache-2.0',
    });
    expect(manifest?.files).toHaveLength(2);
  });

  it('tolerates fields it does not know about', () => {
    // additionalProperties is true in the schema and `eval` is already optional,
    // so a new key must never turn into a rejected manifest.
    const manifest = parseModelManifest({ ...validManifest(), somethingAddedLater: { anything: true } });

    expect(manifest?.version).toBe('2026-09-15');
  });

  it.each([
    ['a schemaVersion the app has not been taught', { schemaVersion: 2 }],
    ['a missing version', { version: '' }],
    ['a non-NCHW input layout', { input: { ...VALID_INPUT, layout: 'NHWC' } }],
    // `none` is in the schema's enum but says "do not fit the frame at all",
    // which no path here can honour — every one resamples into a fixed square.
    // Guessing `stretch` would report numbers for preprocessing the publisher
    // did not ask for.
    ['a letterbox mode the shared package cannot honour', { input: { ...VALID_INPUT, letterbox: 'none' } }],
    ['an unknown letterbox mode', { input: { ...VALID_INPUT, letterbox: 'contain' } }],
    ['an int8 input tensor', { input: { ...VALID_INPUT, dtype: 'int8' } }],
    [
      'a softmax activation',
      { outputs: { ...VALID_OUTPUTS, logits: { name: null, activation: 'softmax', classes: 1 } } },
    ],
    ['a threshold outside 0..1', { thresholds: { default: 1.4, sweep: [] } }],
    ['no files at all', { files: [] }],
    ['a truncated sha256', { files: [{ path: 'model-int8.onnx', bytes: 1, sha256: 'abc', dtype: 'int8' }] }],
    ['a zero byte count', { files: [{ path: 'model-int8.onnx', bytes: 0, sha256: 'c'.repeat(64), dtype: 'int8' }] }],
    [
      'a path that escapes the version directory',
      { files: [{ path: '../../evil.onnx', bytes: 1, sha256: 'c'.repeat(64), dtype: 'int8' }] },
    ],
    ['an absolute path', { files: [{ path: '/etc/passwd', bytes: 1, sha256: 'c'.repeat(64), dtype: 'int8' }] }],
  ])('rejects %s', (_label, overrides) => {
    expect(parseModelManifest({ ...validManifest(), ...overrides })).toBeNull();
  });

  it.each([[null], [undefined], ['a string'], [42], [[]]])('rejects the non-object body %j', (body) => {
    expect(parseModelManifest(body)).toBeNull();
  });
});

describe('letterboxFitFor', () => {
  it.each([
    ['stretch', 'stretch'],
    ['pad', 'contain'],
  ])('maps the manifest %j to the shared package fit %j', (letterbox, expected) => {
    const manifest = parseModelManifest({ ...validManifest(), input: { ...VALID_INPUT, letterbox } });

    expect(letterboxFitFor(manifest!.input)).toBe(expected);
  });
});

describe('selectInt8File', () => {
  it('picks the int8 export, never the 107 MB fp32 one', () => {
    const manifest = parseModelManifest(validManifest());

    expect(selectInt8File(manifest!)?.path).toBe('model-int8.onnx');
  });

  it('returns null when only fp32 was published', () => {
    const manifest = parseModelManifest({
      ...validManifest(),
      files: [{ path: 'model.onnx', bytes: 107_000_000, sha256: 'd'.repeat(64), dtype: 'fp32' }],
    });

    expect(selectInt8File(manifest!)).toBeNull();
  });
});
