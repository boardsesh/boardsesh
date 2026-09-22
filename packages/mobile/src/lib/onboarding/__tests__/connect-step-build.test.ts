import { describe, expect, it, vi } from 'vitest';

// The native reads are not what this file pins; the rule below is.
vi.mock('expo-application', () => ({ nativeApplicationVersion: '2.7.0' }));
vi.mock('expo-updates', () => ({ channel: 'production', manifest: null }));

const { isConnectStepProductionBuild } = await import('../connect-step-build');

// A store or TestFlight binary on the production branch.
const STORE_BUILD = { devBuild: false, previewBuild: false, appEnvironment: 'production', otaBranch: null };

describe('isConnectStepProductionBuild', () => {
  it('counts a store or TestFlight binary on production JS', () => {
    expect(isConnectStepProductionBuild(STORE_BUILD)).toBe(true);
  });

  it.each([
    ['a dev build', { devBuild: true }],
    ['an EAS preview binary', { previewBuild: true }],
    ['a pr-* OTA bundle, by its environment', { appEnvironment: 'preview' }],
    ['a pr-* OTA branch, by the running branch', { otaBranch: 'pr-5678' }],
  ] as const)('leaves out %s', (_label, overrides) => {
    expect(isConnectStepProductionBuild({ ...STORE_BUILD, ...overrides })).toBe(false);
  });

  it('keeps a production branch that is not a PR preview', () => {
    expect(isConnectStepProductionBuild({ ...STORE_BUILD, otaBranch: 'production' })).toBe(true);
  });
});
