import { describe, expect, it } from 'vitest';
import { validateFingerprintSources, type FingerprintSource } from './mobile-fingerprint-inputs-check';

function completeSources(platform: 'ios' | 'android'): FingerprintSource[] {
  const platformLabel = platform === 'ios' ? 'Ios' : 'Android';
  return [
    {
      type: 'contents',
      id: `expoAutolinkingConfig:${platform}`,
      hash: 'expo-config-hash',
      reasons: [`expoAutolinking${platformLabel}`],
    },
    {
      type: 'contents',
      id: `rncoreAutolinkingConfig:${platform}`,
      hash: 'rn-config-hash',
      reasons: [`rncoreAutolinking${platformLabel}`],
    },
    {
      type: 'dir',
      filePath: `node_modules/native/${platform}`,
      hash: 'native-hash',
      reasons: [`expoAutolinking${platformLabel}`],
    },
    {
      type: 'file',
      filePath: 'fingerprint.config.js',
      overrideHashKey: 'boardseshFingerprintConfig',
      hash: 'config-hash',
    },
    {
      type: 'dir',
      filePath: '../../patches',
      overrideHashKey: 'bunPatchedDependencies',
      hash: 'patch-hash',
    },
  ];
}

describe('validateFingerprintSources', () => {
  it.each(['ios', 'android'] as const)('accepts complete %s inputs', (platform) => {
    expect(validateFingerprintSources(platform, completeSources(platform))).toEqual([]);
  });

  it('reports null native directories and missing config/patch sources', () => {
    const sources = completeSources('ios').filter(
      (source) => !['boardseshFingerprintConfig', 'bunPatchedDependencies'].includes(String(source.overrideHashKey)),
    );
    const nativeDirectory = sources.find((source) => source.type === 'dir');
    if (nativeDirectory) nativeDirectory.hash = null;

    expect(validateFingerprintSources('ios', sources)).toEqual([
      expect.stringContaining('1/1 autolinked native directories have null hashes'),
      'ios: expected exactly one boardseshFingerprintConfig source, found 0',
      'ios: expected exactly one bunPatchedDependencies source, found 0',
    ]);
  });

  it('requires exactly the platform-specific pair of config content sources', () => {
    const sources = completeSources('android').filter((source) => source.id !== 'rncoreAutolinkingConfig:android');
    sources.push({ type: 'contents', id: 'expoAutolinkingConfig:android', hash: 'duplicate' });

    expect(validateFingerprintSources('android', sources)).toEqual([
      'android: expected exactly one expoAutolinkingConfig:android contents source, found 2',
      'android: expected exactly one rncoreAutolinkingConfig:android contents source, found 0',
    ]);
  });
});
