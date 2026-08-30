import { describe, expect, it } from 'vitest';
import {
  parseResolverOutput,
  validateFingerprintSources,
  type FingerprintSource,
} from './mobile-fingerprint-inputs-check';

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
      filePath: 'locales',
      overrideHashKey: 'iosInfoPlistLocales',
      hash: 'locales-hash',
    },
    {
      type: 'dir',
      filePath: '../../patches',
      overrideHashKey: 'rootPatchedDependencies',
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
      (source) =>
        !['boardseshFingerprintConfig', 'iosInfoPlistLocales', 'rootPatchedDependencies'].includes(
          String(source.overrideHashKey),
        ),
    );
    const nativeDirectory = sources.find((source) => source.type === 'dir');
    if (nativeDirectory) nativeDirectory.hash = null;

    expect(validateFingerprintSources('ios', sources)).toEqual([
      expect.stringContaining('1/1 autolinked native directories have null hashes'),
      'ios: expected exactly one boardseshFingerprintConfig source, found 0',
      'ios: expected exactly one iosInfoPlistLocales source, found 0',
      'ios: expected exactly one rootPatchedDependencies source, found 0',
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

describe('parseResolverOutput', () => {
  const resolverResult = {
    runtimeVersion: 'fingerprint:abc123',
    fingerprintSources: [{ type: 'contents', id: 'source-with-} brace' }],
  };

  it('parses clean resolver JSON', () => {
    expect(parseResolverOutput(JSON.stringify(resolverResult))).toEqual(resolverResult);
  });

  it('extracts the balanced resolver object from noisy output with unrelated braces', () => {
    const stdout = [
      'warning: diagnostic {not valid JSON}',
      JSON.stringify(resolverResult),
      'debug: finished {after payload}',
    ].join('\n');

    expect(parseResolverOutput(stdout)).toEqual(resolverResult);
  });

  it('skips a valid partial diagnostic object before the complete resolver payload', () => {
    const stdout = [JSON.stringify({ runtimeVersion: 'diagnostic-only' }), JSON.stringify(resolverResult)].join('\n');

    expect(parseResolverOutput(stdout)).toEqual(resolverResult);
  });

  it('rejects ambiguous output with two complete resolver-shaped objects', () => {
    const diagnostic = { runtimeVersion: 'diagnostic', fingerprintSources: [] };
    const stdout = [JSON.stringify(diagnostic), JSON.stringify(resolverResult)].join('\n');

    expect(() => parseResolverOutput(stdout)).toThrow('Multiple runtimeVersion resolver JSON objects');
  });

  it('recovers from unmatched diagnostic quotes and braces before the payload', () => {
    const stdout = ['warning unmatched " quote', '{unmatched diagnostic', JSON.stringify(resolverResult)].join('\n');

    expect(parseResolverOutput(stdout)).toEqual(resolverResult);
  });

  it('recovers when unmatched diagnostic braces directly contain the payload', () => {
    expect(parseResolverOutput(`{unmatched diagnostic ${JSON.stringify(resolverResult)}`)).toEqual(resolverResult);
    expect(parseResolverOutput(`{unmatched diagnostic\n  ${JSON.stringify(resolverResult)}`)).toEqual(resolverResult);
  });

  it('accepts either resolver property order and still detects ambiguity', () => {
    const reversedResult = {
      fingerprintSources: resolverResult.fingerprintSources,
      runtimeVersion: resolverResult.runtimeVersion,
    };

    expect(parseResolverOutput(`notice ${JSON.stringify(reversedResult)}`)).toEqual(reversedResult);
    expect(() =>
      parseResolverOutput(`${JSON.stringify(resolverResult)} notice ${JSON.stringify(reversedResult)}`),
    ).toThrow('Multiple runtimeVersion resolver JSON objects');
  });

  it('ignores escaped quotes and nested braces inside resolver strings', () => {
    const nestedResult = {
      runtimeVersion: 'fingerprint:{abc123}',
      fingerprintSources: [
        {
          type: 'contents',
          metadata: { message: 'escaped quote: " and slash: \\ and braces: {still-a-string}' },
        },
      ],
    };

    expect(parseResolverOutput(`diagnostic {before}\n${JSON.stringify(nestedResult)}\n{after}`)).toEqual(nestedResult);
  });

  it('rejects output without a resolver result object', () => {
    expect(() => parseResolverOutput('warning {"message":"not the payload"} done')).toThrow(
      'Could not find a runtimeVersion resolver JSON object',
    );
  });
});
