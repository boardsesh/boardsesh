/// <reference types="node" />

import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const sourceBuildPlugin = require('../../packages/mobile/plugins/with-react-native-source-builds.js') as {
  (config: { name: string; slug: string }): {
    mods: {
      ios: {
        podfileProperties: (config: unknown) => Promise<{ modResults: Record<string, string> }>;
      };
    };
  };
  enforceReactNativeSourceBuilds: (contents: string) => string;
};
const { enforceReactNativeSourceBuilds } = sourceBuildPlugin;

const podfile = `ENV['RCT_USE_RN_DEP'] ||= podfile_properties['ios.buildReactNativeFromSource'] == 'true' ? '0' : '1'
ENV['RCT_USE_PREBUILT_RNCORE'] ||= podfile_properties['ios.buildReactNativeFromSource'] == 'true' ? '0' : '1'
`;

describe('React Native source-build Podfile', () => {
  it('sets source compilation through the real Podfile properties mod', async () => {
    const config = sourceBuildPlugin({ name: 'Boardsesh', slug: 'boardsesh' });
    const result = await config.mods.ios.podfileProperties({
      ...config,
      modResults: { 'ios.buildReactNativeFromSource': 'false', 'expo.jsEngine': 'hermes' },
      modRequest: { projectRoot: '/tmp', platform: 'ios', modName: 'podfileProperties', introspect: true },
    });
    expect(result.modResults).toEqual({
      'ios.buildReactNativeFromSource': 'true',
      'expo.jsEngine': 'hermes',
    });
  });

  it('forces source compilation even when a caller exports prebuilt values', () => {
    expect(enforceReactNativeSourceBuilds(podfile)).toBe(
      "ENV['RCT_USE_RN_DEP'] = '0'\nENV['RCT_USE_PREBUILT_RNCORE'] = '0'\n",
    );
  });

  it('is stable across repeated prebuilds', () => {
    const configured = enforceReactNativeSourceBuilds(podfile);
    expect(enforceReactNativeSourceBuilds(configured)).toBe(configured);
  });

  it('enforces every assignment, including later indented overrides', () => {
    const configured = enforceReactNativeSourceBuilds(
      `${podfile}  ENV['RCT_USE_RN_DEP'] = '1'\n\tENV['RCT_USE_PREBUILT_RNCORE'] ||= '1'\n`,
    );
    expect(configured).toBe(
      "ENV['RCT_USE_RN_DEP'] = '0'\nENV['RCT_USE_PREBUILT_RNCORE'] = '0'\n  ENV['RCT_USE_RN_DEP'] = '0'\n\tENV['RCT_USE_PREBUILT_RNCORE'] = '0'\n",
    );
  });

  it('fails closed when Expo changes the source-build switches', () => {
    expect(() => enforceReactNativeSourceBuilds("ENV['RCT_USE_PREBUILT_RNCORE'] = '0'\n")).toThrow('RCT_USE_RN_DEP');
  });
});
