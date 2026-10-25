import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { enforceReactNativeSourceBuilds } =
  require('../../packages/mobile/plugins/with-react-native-source-builds.js') as {
    enforceReactNativeSourceBuilds: (contents: string) => string;
  };

const podfile = `ENV['RCT_USE_RN_DEP'] ||= podfile_properties['ios.buildReactNativeFromSource'] == 'true' ? '0' : '1'
ENV['RCT_USE_PREBUILT_RNCORE'] ||= podfile_properties['ios.buildReactNativeFromSource'] == 'true' ? '0' : '1'
`;

describe('React Native source-build Podfile', () => {
  it('forces source compilation even when a caller exports prebuilt values', () => {
    expect(enforceReactNativeSourceBuilds(podfile)).toBe(
      "ENV['RCT_USE_RN_DEP'] = '0'\nENV['RCT_USE_PREBUILT_RNCORE'] = '0'\n",
    );
  });

  it('is stable across repeated prebuilds', () => {
    const configured = enforceReactNativeSourceBuilds(podfile);
    expect(enforceReactNativeSourceBuilds(configured)).toBe(configured);
  });

  it('fails closed when Expo changes the source-build switches', () => {
    expect(() => enforceReactNativeSourceBuilds("ENV['RCT_USE_PREBUILT_RNCORE'] = '0'\n")).toThrow('RCT_USE_RN_DEP');
  });
});
