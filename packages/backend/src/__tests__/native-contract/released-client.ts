import { createHash, randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import { createContext, SourceTextModule, SyntheticModule, type Module } from 'node:vm';
import { transformWithOxc } from 'vite-plus';
import { recordedSource, type ReleasedClient } from './recordings';

type Exports = Record<string, unknown>;
export interface ReleasedPlatformIo {
  fetch: typeof fetch;
  secureReadFailure?: (key: string) => boolean;
  providerToken?: (provider: 'google' | 'apple', nonceHash?: string) => Promise<string>;
  browserReturn?: (startUrl: string) => Promise<string>;
}

/** Exact recorded JS executes; only native/storage/network-state/telemetry I/O is adapted. */
export async function createReleasedClient(release: ReleasedClient, io: ReleasedPlatformIo) {
  const secureValues = new Map<string, string>();
  const asyncValues = new Map<string, string>();
  const nativeWrites: { key: string; operation: 'write' | 'delete' }[] = [];
  const linkedModules = new Map<string, Module>();
  const pendingModules = new Map<string, Promise<Module>>();
  const browserDismissals = new Set<() => void>();
  const urlListeners = new Set<(event: { url: string }) => void>();
  const effects = { reported: 0, credentialInvalidations: 0, backendOutcomes: 0, browserStarts: 0, telemetry: 0 };
  const context = createContext({
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    AbortController,
    AbortSignal,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    Date,
    setTimeout,
    clearTimeout,
    fetch: io.fetch,
    console: { warn() {}, info() {}, error() {}, log() {} },
    __DEV__: false,
    process: {
      env: {
        EXPO_OS: release.platform,
        EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: 'native-contract-google',
        EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: 'native-contract-google',
      },
    },
  });
  const secureKey = (key: unknown, options?: unknown) => {
    if (typeof key !== 'string') throw new Error('Invalid fixture storage key');
    const service =
      options && typeof options === 'object' && 'keychainService' in options ? options.keychainService : 'legacy';
    return `${String(service)}:${key}`;
  };
  const getSecure = (key: unknown, options?: unknown) => {
    const storageKey = secureKey(key, options);
    if (io.secureReadFailure?.(storageKey)) throw new Error('Synthetic keychain read unavailable');
    return secureValues.get(storageKey) ?? null;
  };
  const setSecure = (key: unknown, contents: unknown, options?: unknown) => {
    if (typeof contents !== 'string') throw new Error('SecureStore requires a string');
    const storageKey = secureKey(key, options);
    secureValues.set(storageKey, contents);
    nativeWrites.push({ key: storageKey, operation: 'write' });
  };
  const deleteSecure = (key: unknown, options?: unknown) => {
    const storageKey = secureKey(key, options);
    secureValues.delete(storageKey);
    nativeWrites.push({ key: storageKey, operation: 'delete' });
  };
  const asyncStorage = {
    async getItem(key: string) {
      return asyncValues.get(key) ?? null;
    },
    async setItem(key: string, contents: string) {
      asyncValues.set(key, contents);
    },
    async removeItem(key: string) {
      asyncValues.delete(key);
    },
  };
  const appState = {
    currentState: 'active',
    addEventListener() {
      return { remove() {} };
    },
  };
  const browserReturn = async (url: string) => {
    effects.browserStarts += 1;
    if (!io.browserReturn) throw new Error('Browser fixture return unavailable');
    return io.browserReturn(url);
  };
  const platformModules: Record<string, Exports> = {
    'expo-secure-store': {
      AFTER_FIRST_UNLOCK: 1,
      getItemAsync: async (key: unknown, options?: unknown) => getSecure(key, options),
      getItem: getSecure,
      setItemAsync: async (key: unknown, contents: unknown, options?: unknown) => setSecure(key, contents, options),
      setItem: setSecure,
      deleteItemAsync: async (key: unknown, options?: unknown) => deleteSecure(key, options),
      deleteItem: deleteSecure,
    },
    '@react-native-async-storage/async-storage': { default: asyncStorage },
    'expo-crypto': {
      CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
      CryptoEncoding: { HEX: 'hex' },
      getRandomBytes: (length: number) => new Uint8Array(randomBytes(length)),
      digestStringAsync: async (_algorithm: unknown, contents: string) =>
        createHash('sha256').update(contents).digest('hex'),
    },
    'react-native': {
      AppState: appState,
      Platform: {
        OS: release.platform,
        select: (choices: Exports) => choices[release.platform] ?? choices.native ?? choices.default,
      },
      Linking: {
        addEventListener(_event: unknown, listener: (event: { url: string }) => void) {
          urlListeners.add(listener);
          return {
            remove() {
              urlListeners.delete(listener);
            },
          };
        },
      },
    },
    'expo-application': { nativeApplicationVersion: release.version, nativeBuildVersion: null },
    'expo-apple-authentication': {
      AppleAuthenticationScope: { FULL_NAME: 'full-name', EMAIL: 'email' },
      async signInAsync(options: { nonce?: string }) {
        if (!io.providerToken) throw new Error('Provider fixture unavailable');
        return { identityToken: await io.providerToken('apple', options.nonce), fullName: null };
      },
    },
    '@react-native-google-signin/google-signin': {
      statusCodes: {
        SIGN_IN_CANCELLED: 'cancelled',
        IN_PROGRESS: 'in-progress',
        PLAY_SERVICES_NOT_AVAILABLE: 'unavailable',
        SIGN_IN_REQUIRED: 'sign-in-required',
      },
      GoogleSignin: {
        configure() {},
        async hasPlayServices() {
          return true;
        },
        async signIn() {
          if (!io.providerToken) throw new Error('Provider fixture unavailable');
          return { type: 'success', data: { idToken: await io.providerToken('google') } };
        },
      },
    },
    'expo-web-browser': {
      async openAuthSessionAsync(url: string) {
        return { type: 'success', url: await browserReturn(url) };
      },
      async openBrowserAsync(url: string) {
        const returned = await browserReturn(url);
        // iOS keeps SFSafariViewController pending until explicitly dismissed;
        // Android reports opened immediately while Linking owns the callback.
        if (release.platform === 'ios') {
          return new Promise<{ type: 'dismiss' }>((resolve) => {
            const dismissed = () => {
              browserDismissals.delete(dismissed);
              resolve({ type: 'dismiss' });
            };
            browserDismissals.add(dismissed);
            setImmediate(() => {
              for (const listener of urlListeners) listener({ url: returned });
            });
          });
        }
        setImmediate(() => {
          for (const listener of urlListeners) listener({ url: returned });
        });
        return { type: 'opened' };
      },
      dismissBrowser() {
        for (const dismissed of browserDismissals) dismissed();
      },
      dismissAuthSession() {
        for (const dismissed of browserDismissals) dismissed();
      },
    },
  };
  const boundaryModules: Record<string, Exports> = {
    'packages/mobile/src/lib/analytics.ts': {
      track() {
        effects.telemetry += 1;
      },
    },
    'packages/mobile/src/lib/error-reporting.ts': {
      reportError() {
        effects.reported += 1;
      },
      reportHandledError() {
        effects.reported += 1;
      },
    },
    'packages/mobile/src/lib/privacy/privacy-cache.ts': {
      invalidateCredentialSnapshots() {
        effects.credentialInvalidations += 1;
      },
      invalidatePrivacySnapshots(reason: 'privacy' | 'credential' = 'privacy') {
        if (reason === 'credential') effects.credentialInvalidations += 1;
      },
    },
    'packages/mobile/src/lib/connectivity/connectivity-store.ts': {
      getConnectivitySnapshot() {
        return { effectiveOffline: false };
      },
      reportBackendOutcome() {
        effects.backendOutcomes += 1;
      },
    },
    'packages/mobile/src/lib/consent-state.ts': {
      getConsentSnapshot() {
        return { authEpoch: 0 };
      },
      subscribeConsent() {
        return () => {};
      },
    },
  };
  const aliases: Record<string, string> = {
    '@boardsesh/shared-schema/client-identity': 'packages/shared-schema/src/client-identity.ts',
  };
  function resolvePath(specifier: string, parent: string): string {
    if (aliases[specifier]) return aliases[specifier];
    if (!specifier.startsWith('.')) return specifier;
    const base = posix.normalize(posix.join(posix.dirname(parent), specifier));
    return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((path) => release.modules[path]) ?? base;
  }
  async function moduleFor(identifier: string): Promise<Module> {
    const cached = linkedModules.get(identifier);
    if (cached) return cached;
    const pending = pendingModules.get(identifier);
    if (pending) return pending;
    const created = constructModule(identifier);
    pendingModules.set(identifier, created);
    return created;
  }
  async function constructModule(identifier: string): Promise<Module> {
    const exports = platformModules[identifier] ?? boundaryModules[identifier];
    if (exports) {
      const synthetic = new SyntheticModule(
        Object.keys(exports),
        function () {
          for (const [name, exported] of Object.entries(exports)) this.setExport(name, exported);
        },
        { context, identifier },
      );
      linkedModules.set(identifier, synthetic);
      return synthetic;
    }
    if (!release.modules[identifier]) throw new Error(`Unrecorded client module refused: ${identifier}`);
    const source = recordedSource(release, identifier);
    const transformed = await transformWithOxc(source, identifier, { jsx: { runtime: 'automatic' } });
    const module = new SourceTextModule(transformed.code, {
      context,
      identifier,
      importModuleDynamically: async (specifier, parent) => {
        const dependency = await moduleFor(resolvePath(specifier, parent.identifier));
        if (dependency.status === 'unlinked') await dependency.link(linker);
        if (dependency.status === 'linked') await dependency.evaluate();
        return dependency;
      },
    });
    linkedModules.set(identifier, module);
    return module;
  }
  async function linker(specifier: string, parent: Module) {
    return moduleFor(resolvePath(specifier, parent.identifier));
  }
  async function load(path: string): Promise<Exports> {
    const module = await moduleFor(path);
    if (module.status === 'unlinked') await module.link(linker);
    if (module.status === 'linked') await module.evaluate();
    return module.namespace as Exports;
  }
  const receiptPath = 'packages/shared/analytics/src/account-creation.ts';
  const receiptExports = release.modules[receiptPath] ? await load(receiptPath) : {};
  platformModules['@boardsesh/analytics'] = {
    ...receiptExports,
    // Event names are telemetry I/O, not credential or response parsing.
    SHARED_EVENTS: new Proxy({}, { get: (_target, name) => String(name) }),
  };
  const auth = await load('packages/mobile/src/lib/auth.ts');
  const store = await load('packages/mobile/src/lib/auth-store.ts');
  const interceptor = await load('packages/mobile/src/lib/auth-interceptor.ts');
  async function evaluateFragment(source: string, bindings: Exports): Promise<Exports> {
    context.__nativeContractBindings = bindings;
    const names = Object.keys(bindings);
    if (names.some((name) => !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name))) throw new Error('Invalid fragment binding');
    const identifier = 'packages/mobile/src/providers/__native-contract-fragment.ts';
    const transformed = await transformWithOxc(
      `const { ${names.join(', ')} } = globalThis.__nativeContractBindings;\n${source}`,
      identifier,
    );
    const fragment = new SourceTextModule(transformed.code, {
      context,
      identifier,
      importModuleDynamically: async (specifier, parent) => {
        const dependency = await moduleFor(resolvePath(specifier, parent.identifier));
        if (dependency.status === 'unlinked') await dependency.link(linker);
        if (dependency.status === 'linked') await dependency.evaluate();
        return dependency;
      },
    });
    await fragment.link(linker);
    await fragment.evaluate();
    delete context.__nativeContractBindings;
    return fragment.namespace as Exports;
  }
  return { release, auth, store, interceptor, load, evaluateFragment, effects, secureValues, nativeWrites };
}

export async function callRecorded(exports: Exports, name: string, ...arguments_: unknown[]): Promise<unknown> {
  const method = exports[name];
  if (typeof method !== 'function') throw new Error('Recorded client entry point unavailable');
  return Reflect.apply(method, undefined, arguments_) as unknown;
}
