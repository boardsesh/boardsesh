import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const binary = vi.hoisted(() => ({ applicationId: 'com.boardsesh.app', platform: 'ios' }));
vi.mock('expo-application', () => ({
  get applicationId() {
    return binary.applicationId;
  },
}));
vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return binary.platform;
    },
  },
}));

describe('installed native app identity', () => {
  beforeEach(() => vi.resetModules());
  it.each([
    ['ios', 'com.boardsesh.app.dev', 'dev', 'com.boardsesh.app.dev'],
    ['ios', 'com.boardsesh.app', 'production', 'com.boardsesh.app'],
    ['android', 'com.boardsesh.app.dev', 'production', 'com.boardsesh.app'],
  ])('uses %s binary %s', async (platform, applicationId, expectedVariant, expectedScheme) => {
    binary.platform = platform;
    binary.applicationId = applicationId;
    const { nativeAppVariant, nativeIdentity } = await import('../native-app-identity');
    expect(nativeAppVariant).toBe(expectedVariant);
    expect(nativeIdentity.scheme).toBe(expectedScheme);
  });
});
