import { describe, expect, it } from 'vitest';

import { letterboxFitFor, parseModelManifest, selectInt8File } from '../manifest';
import { DEFAULT_MODEL_VERSION, MEDIA_BASE_URL, ensureModel } from '../model-store';
import type { ModelStoreIo } from '../model-store';
import mediumManifest from './fixtures/manifest-2026-09-15-medium.json';
import nanoManifest from './fixtures/manifest-2026-09-15.json';

/**
 * The loader against the manifests that are actually in the bucket.
 *
 * Every other test in this directory feeds `parseModelManifest` a body this repo
 * wrote, which only ever proves the validator agrees with itself. These two
 * fixtures were downloaded verbatim from
 * `https://media.boardsesh.com/models/hold-detector/<version>/manifest.json`
 * (SW-01, `ml/holds/publish_model.py`), so a field the publisher spells
 * differently, a `sweep` longer than expected, or a future schema edit that
 * drops something the app reads fails HERE rather than on a tester's phone as a
 * silent "No model".
 *
 * Committed rather than fetched at test time: a unit suite that reaches the
 * network is a unit suite that fails when the wifi does. Re-download both files
 * when a new version is published.
 */
describe('the published hold-detector manifests', () => {
  it.each([
    ['nano-untiled-1024', nanoManifest, '2026-09-15', 768, 31_327_953],
    ['medium-untiled-1280', mediumManifest, '2026-09-15-medium', 576, 32_846_565],
  ])('accepts %s and reads what the app needs', (config, body, version, inputSize, bytes) => {
    const manifest = parseModelManifest(body);

    expect(manifest).not.toBeNull();
    expect({
      version: manifest?.version,
      config: manifest?.config,
      family: manifest?.family,
      inputSize: manifest?.input.width,
      fit: manifest ? letterboxFitFor(manifest.input) : null,
      threshold: manifest?.thresholds.default,
      licence: manifest?.licence,
    }).toEqual({
      version,
      config,
      family: 'rfdetr',
      inputSize,
      fit: 'stretch',
      threshold: 0.6,
      licence: 'Apache-2.0',
    });
    expect(selectInt8File(manifest!)).toMatchObject({ path: 'model-int8.onnx', bytes, dtype: 'int8' });
  });

  it('publishes normalisation the benchmark passes straight through', () => {
    // Not "is it ImageNet" — that the values are READ, so a future export with
    // different statistics reaches `runDetection` instead of being defaulted.
    const manifest = parseModelManifest(nanoManifest);

    expect(manifest?.input.normalization).toEqual({ mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] });
  });

  it('leaves the output tensor names null, so they must be matched by shape', () => {
    const manifest = parseModelManifest(nanoManifest);

    expect({ boxes: manifest?.outputs.boxes.name, logits: manifest?.outputs.logits.name }).toEqual({
      boxes: null,
      logits: null,
    });
    expect(manifest?.outputs.logits.classes).toBe(1);
  });

  it("is the version DEFAULT_MODEL_VERSION points at, so a tester's first tap finds a model", () => {
    expect(nanoManifest.version).toBe(DEFAULT_MODEL_VERSION);
  });

  it('loads end to end through ensureModel, hitting the real bucket URLs', async () => {
    const int8 = nanoManifest.files.find((file) => file.dtype === 'int8')!;
    const fetched: string[] = [];
    const downloaded: string[] = [];
    const io: ModelStoreIo = {
      async fetchJson(url) {
        fetched.push(url);
        return nanoManifest;
      },
      async download(url, cachedVersion, fileName) {
        downloaded.push(url);
        return `file:///cache/hold-detector/${cachedVersion}/${fileName}`;
      },
      find: () => null,
      async hashFile() {
        return int8.sha256;
      },
      listVersions: () => [DEFAULT_MODEL_VERSION],
      removeVersion: () => {},
    };

    const handle = await ensureModel(DEFAULT_MODEL_VERSION, { io });

    expect(handle).toMatchObject({
      version: '2026-09-15',
      trainedInputSize: 768,
      defaultThreshold: 0.6,
      bytes: 31_327_953,
      uri: 'file:///cache/hold-detector/2026-09-15/model-int8.onnx',
    });
    // The exact keys SW-01 published under. A prefix typo here is the difference
    // between a working model and a 404 nobody can explain.
    expect(fetched).toEqual([`${MEDIA_BASE_URL}/models/hold-detector/2026-09-15/manifest.json`]);
    expect(downloaded).toEqual([`${MEDIA_BASE_URL}/models/hold-detector/2026-09-15/model-int8.onnx`]);
  });
});
