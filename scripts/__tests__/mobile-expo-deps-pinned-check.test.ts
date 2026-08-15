import { describe, it, expect } from 'vitest';
import { findUnpinnedExpoDeps, isExpoPackage } from '../mobile-expo-deps-pinned-check';

describe('isExpoPackage', () => {
  it('matches the whole @expo/ scope (native and pure-JS), bare expo, and expo-* names', () => {
    expect(isExpoPackage('@expo/ui')).toBe(true);
    expect(isExpoPackage('@expo/vector-icons')).toBe(true);
    expect(isExpoPackage('@expo/config-plugins')).toBe(true); // pure-JS tooling still in scope
    expect(isExpoPackage('expo')).toBe(true);
    expect(isExpoPackage('expo-image')).toBe(true);
  });

  it('does not match non-Expo packages (including expo-lookalikes)', () => {
    expect(isExpoPackage('react-native-gesture-handler')).toBe(false);
    expect(isExpoPackage('react')).toBe(false);
    expect(isExpoPackage('exposition')).toBe(false); // not `expo` and not `expo-`
    expect(isExpoPackage('@expora/thing')).toBe(false);
  });
});

describe('findUnpinnedExpoDeps', () => {
  it('flags a tilde-ranged Expo dep (the @expo/ui drift that caused the crash)', () => {
    expect(findUnpinnedExpoDeps({ '@expo/ui': '~56.0.18' })).toEqual(['@expo/ui@~56.0.18']);
  });

  it('passes an all-exact Expo set', () => {
    expect(
      findUnpinnedExpoDeps({
        '@expo/ui': '56.0.18',
        '@expo/vector-icons': '15.1.1',
        expo: '56.0.12',
        'expo-image': '56.0.11',
        'expo-router': '56.2.11',
        'expo-share-intent': '8.0.1',
      }),
    ).toEqual([]);
  });

  it('accepts an exact prerelease version', () => {
    expect(findUnpinnedExpoDeps({ 'expo-modules-core': '56.0.17-rc.1' })).toEqual([]);
  });

  it('flags every range operator form', () => {
    expect(
      findUnpinnedExpoDeps({
        'expo-a': '^56.0.0',
        'expo-b': '~56.0.0',
        'expo-c': '*',
        'expo-d': '56.x',
        'expo-e': '>=56.0.0 <57.0.0',
        'expo-f': '56 || 57',
      }),
    ).toEqual([
      'expo-a@^56.0.0',
      'expo-b@~56.0.0',
      'expo-c@*',
      'expo-d@56.x',
      'expo-e@>=56.0.0 <57.0.0',
      'expo-f@56 || 57',
    ]);
  });

  it('ignores unpinned NON-Expo deps (some RN deps use ~ on purpose)', () => {
    expect(
      findUnpinnedExpoDeps({
        'react-native-gesture-handler': '~2.31.1',
        'react-native-safe-area-context': '~5.7.0',
        'react-native-paper': '^5.15.3',
      }),
    ).toEqual([]);
  });
});
