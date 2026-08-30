import {
  QUANTUM_DEFAULT_LIMITS,
  QUANTUM_DEFAULT_RELAYS,
  QUANTUM_MANIFEST_D_TAG,
  QUANTUM_MANIFEST_SIGNER,
  QUANTUM_MANIFEST_SOURCE,
} from './constants';
import { QuantumSyncError } from './errors';

export type QuantumSyncLimits = {
  maxManifestBytes: number;
  maxEventsPerRelay: number;
  maxCompressedBytes: number;
  maxDecompressedBytes: number;
  maxMirrorUrls: number;
  maxFutureEventSeconds: number;
  relayTimeoutMs: number;
  mirrorTimeoutMs: number;
};

export type QuantumSyncContract = {
  signerPubkey: string;
  dTag: string;
  source: string;
  relays: readonly string[];
  limits: Readonly<QuantumSyncLimits>;
};

export type QuantumSyncConfigOverrides = {
  relays?: readonly string[];
  limits?: Partial<QuantumSyncLimits>;
};

export type QuantumSyncEnvironment = Readonly<Record<string, string | undefined>>;

const LIMIT_ENV_NAMES: Readonly<Record<keyof QuantumSyncLimits, string>> = {
  maxManifestBytes: 'QUANTUM_SYNC_MAX_MANIFEST_BYTES',
  maxEventsPerRelay: 'QUANTUM_SYNC_MAX_EVENTS_PER_RELAY',
  maxCompressedBytes: 'QUANTUM_SYNC_MAX_COMPRESSED_BYTES',
  maxDecompressedBytes: 'QUANTUM_SYNC_MAX_DECOMPRESSED_BYTES',
  maxMirrorUrls: 'QUANTUM_SYNC_MAX_MIRROR_URLS',
  maxFutureEventSeconds: 'QUANTUM_SYNC_MAX_FUTURE_EVENT_SECONDS',
  relayTimeoutMs: 'QUANTUM_SYNC_RELAY_TIMEOUT_MS',
  mirrorTimeoutMs: 'QUANTUM_SYNC_MIRROR_TIMEOUT_MS',
};

export function resolveQuantumSyncContract(
  overrides: QuantumSyncConfigOverrides = {},
  environment: QuantumSyncEnvironment = process.env,
): QuantumSyncContract {
  const relays = resolveRelays(overrides.relays, environment.QUANTUM_SYNC_RELAYS);
  const limits = resolveLimits(overrides.limits, environment);

  return Object.freeze({
    signerPubkey: QUANTUM_MANIFEST_SIGNER,
    dTag: QUANTUM_MANIFEST_D_TAG,
    source: QUANTUM_MANIFEST_SOURCE,
    relays: Object.freeze([...relays]),
    limits: Object.freeze(limits),
  });
}

function resolveRelays(overrideRelays: readonly string[] | undefined, environmentRelays: string | undefined): string[] {
  const relayCandidates =
    overrideRelays ??
    (environmentRelays
      ? environmentRelays
          .split(',')
          .map((relay) => relay.trim())
          .filter(Boolean)
      : QUANTUM_DEFAULT_RELAYS);

  if (relayCandidates.length === 0 || relayCandidates.length > 32) {
    throw new QuantumSyncError('CONFIG_INVALID', 'Quantum sync requires between 1 and 32 Nostr relays.');
  }

  const uniqueRelays = new Set<string>();
  for (const relay of relayCandidates) {
    let parsed: URL;
    try {
      parsed = new URL(relay);
    } catch {
      throw new QuantumSyncError('CONFIG_INVALID', `Invalid Quantum Nostr relay URL: ${relay}`);
    }
    if (parsed.protocol !== 'wss:' || parsed.username || parsed.password || parsed.hash) {
      throw new QuantumSyncError('CONFIG_INVALID', `Quantum Nostr relay must be a credential-free wss URL: ${relay}`);
    }
    uniqueRelays.add(parsed.toString());
  }

  return [...uniqueRelays];
}

function resolveLimits(
  overrideLimits: Partial<QuantumSyncLimits> | undefined,
  environment: QuantumSyncEnvironment,
): QuantumSyncLimits {
  const resolved = { ...QUANTUM_DEFAULT_LIMITS } as QuantumSyncLimits;
  for (const key of Object.keys(LIMIT_ENV_NAMES) as Array<keyof QuantumSyncLimits>) {
    const override = overrideLimits?.[key];
    const environmentValue = environment[LIMIT_ENV_NAMES[key]];
    const parsedEnvironmentValue = environmentValue === undefined ? undefined : Number(environmentValue);
    const selected = override ?? parsedEnvironmentValue ?? QUANTUM_DEFAULT_LIMITS[key];
    if (!Number.isSafeInteger(selected) || selected <= 0) {
      throw new QuantumSyncError('CONFIG_INVALID', `${LIMIT_ENV_NAMES[key]} must be a positive safe integer.`);
    }
    resolved[key] = selected;
  }

  if (resolved.maxDecompressedBytes < resolved.maxCompressedBytes) {
    throw new QuantumSyncError(
      'CONFIG_INVALID',
      'Quantum maxDecompressedBytes must be greater than or equal to maxCompressedBytes.',
    );
  }

  return resolved;
}
