import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('service-only spray recognition native contract', () => {
  it('removes local inference without losing camera access', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8'));
    const config = readFileSync(new URL('../../../../app.config.ts', import.meta.url), 'utf8');
    expect(manifest.dependencies).not.toHaveProperty('onnxruntime-react-native');
    expect(config).not.toContain('com.apple.developer.kernel.increased-memory-limit');
    expect(config).toContain('cameraPermission:');
    expect(config).toContain("'CAMERA'");
    expect(existsSync(new URL('../../hold-detection/onnx-runtime.ts', import.meta.url))).toBe(false);
    expect(existsSync(new URL('../../hold-detection/model-store.ts', import.meta.url))).toBe(false);
    expect(existsSync(new URL('../../../../react-native.config.js', import.meta.url))).toBe(false);
  });
});
