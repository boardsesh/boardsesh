import { describe, expect, it, vi } from 'vitest';

// The mobile vitest project only collects `src/**` and `app/**` (see
// packages/mobile/vite.config.ts `include`), so `modules/*/src/__tests__/` would
// never run. The suite therefore lives here and reaches into the module, the
// same way src/lib/__tests__/install-referrer.test.ts covers the install-referrer
// module's JS side.

type NativeStorefront = { getCountryCode: () => Promise<string | null> };

// Stands in for whatever the running binary linked: null on Android, in Expo Go,
// and in every build made before the module existed.
const linkedNativeModule = vi.hoisted(() => ({ current: null as NativeStorefront | null }));

// expo-modules-core's real requireOptionalNativeModule reaches for a native
// binding that doesn't exist under vitest's node env, so the package is mocked
// outright rather than stubbed per test.
vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: () => linkedNativeModule.current,
}));

// storefrontNative is resolved once at module scope, so each case needs a fresh
// module registry to pick up a different linked module.
async function importStorefront(native: NativeStorefront | null) {
  linkedNativeModule.current = native;
  vi.resetModules();
  return import('../../../modules/storefront/src/index');
}

describe('getStorefrontCountryCode', () => {
  it('resolves null when the native module is absent, without throwing', async () => {
    const { getStorefrontCountryCode, storefrontNative } = await importStorefront(null);

    expect(storefrontNative).toBeNull();
    await expect(getStorefrontCountryCode()).resolves.toBeNull();
  });

  it('returns the alpha-3 country the native module reports', async () => {
    const { getStorefrontCountryCode } = await importStorefront({ getCountryCode: async () => 'USA' });

    await expect(getStorefrontCountryCode()).resolves.toBe('USA');
  });

  it('resolves null when the module is linked but StoreKit has no storefront', async () => {
    // No signed-in Apple Account, or a simulator with no StoreKit configuration.
    // Indistinguishable from "absent" to callers on purpose: both mean unknown.
    const { getStorefrontCountryCode } = await importStorefront({ getCountryCode: async () => null });

    await expect(getStorefrontCountryCode()).resolves.toBeNull();
  });
});
