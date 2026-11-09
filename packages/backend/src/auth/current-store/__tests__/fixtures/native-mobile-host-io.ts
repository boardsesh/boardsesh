import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { mock } from 'node:test';

/** Test-only native host bindings; app auth, storage policy and metadata stay real. */
export const mobileSourceRoot = new URL('../../../../../../mobile/', import.meta.url);
const mobileRequire = createRequire(new URL('package.json', mobileSourceRoot));

export function installNativeMobileHostBindings(platform: 'ios' | 'android' = 'ios') {
  type StoreOptions = { keychainService?: string };
  const secureValues = new Map<string, string>();
  const secureWrites: { key: string; namespace: string }[] = [];
  let unexpectedHostCalls = 0;
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const namespace = (options?: StoreOptions) => options?.keychainService ?? 'legacy';
  const secureKey = (key: string, options?: StoreOptions) => `${namespace(options)}\0${key}`;
  function unusedHost(): never {
    unexpectedHostCalls += 1;
    throw new Error('Unused native host boundary invoked');
  }
  function nativeModule(name: string, namedExports: Record<string, unknown>, defaultExport?: unknown) {
    // Resolve through the actual mobile package; no backend/root fallback.
    mock.module(mobileRequire.resolve(name), {
      cache: true,
      namedExports,
      ...(defaultExport === undefined ? {} : { defaultExport }),
    });
  }
  function installHostBindings() {
    nativeModule('react-native', {
      Platform: { OS: platform, select: (options: Record<string, unknown>) => options[platform] ?? options.default },
      AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
      Linking: {
        addEventListener: () => ({ remove() {} }),
        getInitialURL: async () => null,
        openURL: unusedHost,
        canOpenURL: async () => false,
      },
    });
    nativeModule('expo-secure-store', {
      AFTER_FIRST_UNLOCK: 0,
      getItemAsync: async (key: string, options?: StoreOptions) => secureValues.get(secureKey(key, options)) ?? null,
      setItemAsync: async (key: string, value: string, options?: StoreOptions) => {
        secureWrites.push({ key, namespace: namespace(options) });
        secureValues.set(secureKey(key, options), value);
      },
      deleteItemAsync: async (key: string, options?: StoreOptions) => {
        secureValues.delete(secureKey(key, options));
      },
    });
    nativeModule('expo-application', {
      nativeApplicationVersion: '0.0.0-proof',
      nativeBuildVersion: '1',
      getInstallationTimeAsync: async () => new Date('2026-01-01T00:00:00.000Z'),
    });
    nativeModule('expo-apple-authentication', {
      signInAsync: unusedHost,
      AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
    });
    nativeModule('expo-web-browser', {
      openBrowserAsync: unusedHost,
      openAuthSessionAsync: unusedHost,
      dismissBrowser: unusedHost,
      maybeCompleteAuthSession: unusedHost,
    });
    nativeModule('expo-crypto', {
      getRandomBytes: (length: number) => randomBytes(length),
      digestStringAsync: async (_algorithm: string, text: string) => hash(text),
      CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
      CryptoEncoding: { HEX: 'hex' },
    });
    nativeModule('@react-native-google-signin/google-signin', {
      GoogleSignin: { configure: unusedHost, signIn: unusedHost, hasPlayServices: unusedHost },
      statusCodes: { SIGN_IN_CANCELLED: 'SIGN_IN_CANCELLED' },
    });
    class DisabledNativePostHog {
      constructor() {
        unusedHost();
      }
    }
    nativeModule('posthog-react-native', { PostHog: DisabledNativePostHog, PostHogPersistedProperty: {} });
    nativeModule('posthog-react-native-session-replay', { setOptOut: unusedHost });
    class UnusedNativeFile {
      constructor() {
        unusedHost();
      }
    }
    nativeModule('expo-file-system', { File: UnusedNativeFile, Paths: { document: 'owned-native-proof' } });
    nativeModule(
      '@react-native-async-storage/async-storage',
      {},
      { getItem: unusedHost, setItem: unusedHost, removeItem: unusedHost },
    );
  }

  installHostBindings();
  return {
    secureValues,
    secureWrites,
    get unexpectedHostCalls() {
      return unexpectedHostCalls;
    },
  };
}
