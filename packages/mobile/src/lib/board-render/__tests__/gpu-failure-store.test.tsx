// @vitest-environment jsdom
import { useEffect } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GpuFailureRecord } from '../gpu-failure-store-core';

const identity = vi.hoisted(() => ({
  applicationId: 'com.boardsesh.app',
  nativeApplicationVersion: '2.6.0',
  nativeBuildVersion: '200',
  apiVersion: 5,
  updateId: '0f3c2a4e-6b1d-4c8e-9a7f-2d5e8b1c4a90' as string | null,
}));
const storage = vi.hoisted(() => ({ record: null as unknown }));
const getPreference = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
const setPreference = vi.hoisted(() => vi.fn<(key: string, record: unknown) => Promise<void>>());
const digest = vi.hoisted(() => vi.fn<(algorithm: string, input: string) => Promise<string>>());

vi.mock('expo-application', () => ({
  get applicationId() {
    return identity.applicationId;
  },
  get nativeApplicationVersion() {
    return identity.nativeApplicationVersion;
  },
  get nativeBuildVersion() {
    return identity.nativeBuildVersion;
  },
}));
vi.mock('expo-updates', () => ({
  get updateId() {
    return identity.updateId;
  },
}));
vi.mock('expo-crypto', () => ({ CryptoDigestAlgorithm: { SHA256: 'SHA-256' }, digestStringAsync: digest }));
vi.mock('react-native', () => {
  throw new Error('The failure wrapper must not initialize React Native');
});
vi.mock('../../../../modules/climb-overlay-gpu/src', () => {
  throw new Error('The failure wrapper must not initialize native GPU views');
});
vi.mock('../../preference-store', () => ({ getPreference, setPreference }));

const firstConfig = '{"frames":"","layout_id":8,"private_marker":"first"}';
const secondConfig = '{"frames":"","layout_id":8,"private_marker":"second"}';
const firstHash = 'a'.repeat(64);
const secondHash = 'b'.repeat(64);
const binaryIdentity = () =>
  JSON.stringify([
    'android',
    identity.applicationId,
    identity.nativeApplicationVersion,
    identity.nativeBuildVersion,
    identity.apiVersion,
    identity.updateId ?? 'embedded',
  ]);
const persisted = (hashes: string[], binary = binaryIdentity()): GpuFailureRecord => ({
  version: 1,
  binaryIdentity: binary,
  configHashes: hashes,
});

function deferred<T>() {
  let resolve!: (result: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function loadGate() {
  const wrapper = await import('../gpu-failure-store');
  const attempted = vi.fn<(configJson: string) => void>();
  function NativeAttempt({ configJson }: { configJson: string }) {
    useEffect(() => attempted(configJson), [configJson]);
    return <span data-testid="gpu-attempt">{configJson}</span>;
  }
  function Gate({ configJson }: { configJson: string | null }) {
    const status = wrapper.useGpuFailureStatus(configJson, identity.apiVersion);
    return (
      <>
        <span data-testid="gpu-status">{status}</span>
        {configJson && status === 'allowed' ? <NativeAttempt configJson={configJson} /> : null}
      </>
    );
  }
  return { ...wrapper, Gate, attempted };
}

describe('GPU failure wrapper integration', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('EXPO_OS', 'android');
    Object.assign(identity, {
      applicationId: 'com.boardsesh.app',
      nativeApplicationVersion: '2.6.0',
      nativeBuildVersion: '200',
      apiVersion: 5,
      updateId: '0f3c2a4e-6b1d-4c8e-9a7f-2d5e8b1c4a90',
    });
    storage.record = null;
    getPreference.mockReset().mockImplementation(async () => storage.record);
    setPreference.mockReset().mockImplementation(async (_key, record) => {
      storage.record = structuredClone(record);
    });
    digest
      .mockReset()
      .mockImplementation(async (_algorithm, configJson) => (configJson === firstConfig ? firstHash : secondHash));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  it.each(['hash-first', 'storage-first'])(
    'prevents a GPU attempt until hashing AND storage finish: %s',
    async (order) => {
      const hash = deferred<string>();
      const saved = deferred<unknown>();
      digest.mockReturnValue(hash.promise);
      getPreference.mockReturnValue(saved.promise);
      const { Gate, attempted } = await loadGate();
      render(<Gate configJson={firstConfig} />);
      expect(screen.getByTestId('gpu-status').textContent).toBe('loading');
      expect(attempted).not.toHaveBeenCalled();
      await act(async () => {
        if (order === 'hash-first') hash.resolve(firstHash);
        else saved.resolve(null);
      });
      expect(screen.getByTestId('gpu-status').textContent).toBe('loading');
      expect(attempted).not.toHaveBeenCalled();
      await act(async () => {
        if (order === 'hash-first') saved.resolve(null);
        else hash.resolve(firstHash);
      });
      await waitFor(() => expect(attempted).toHaveBeenCalledExactlyOnceWith(firstConfig));
      expect(digest).toHaveBeenCalledExactlyOnceWith('SHA-256', firstConfig);
      expect(getPreference).toHaveBeenCalledExactlyOnceWith('auraGpuFailedConfigs.v1');
    },
  );

  it('blocks a saved matching hash before mounting native GPU', async () => {
    storage.record = persisted([firstHash]);
    const { Gate, attempted } = await loadGate();
    render(<Gate configJson={firstConfig} />);
    await waitFor(() => expect(screen.getByTestId('gpu-status').textContent).toBe('blocked'));
    expect(attempted).not.toHaveBeenCalled();
    expect(setPreference).not.toHaveBeenCalled();
  });

  it('unmounts a failed configuration and never retries it on a same-binary remount', async () => {
    const { Gate, attempted, recordGpuConfigFailure } = await loadGate();
    const view = render(<Gate configJson={firstConfig} />);
    await waitFor(() => expect(attempted).toHaveBeenCalledTimes(1));
    act(() => recordGpuConfigFailure(firstConfig, identity.apiVersion));
    expect(screen.getByTestId('gpu-status').textContent).toBe('blocked');
    expect(screen.queryByTestId('gpu-attempt')).toBeNull();
    await waitFor(() => expect(storage.record).toEqual(persisted([firstHash])));
    view.unmount();
    render(<Gate configJson={firstConfig} />);
    expect(screen.getByTestId('gpu-status').textContent).toBe('blocked');
    expect(attempted).toHaveBeenCalledTimes(1);
    expect(getPreference).toHaveBeenCalledTimes(1);
    expect(digest).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(storage.record)).not.toContain(firstConfig);
    expect(JSON.stringify(storage.record)).not.toContain('private_marker');
  });

  it('restores the latch after a fresh module/runtime restart using only its saved digest', async () => {
    const first = await loadGate();
    const view = render(<first.Gate configJson={firstConfig} />);
    await waitFor(() => expect(first.attempted).toHaveBeenCalledTimes(1));
    act(() => first.recordGpuConfigFailure(firstConfig, identity.apiVersion));
    await waitFor(() => expect(storage.record).toEqual(persisted([firstHash])));
    view.unmount();
    vi.resetModules();
    const restarted = await loadGate();
    render(<restarted.Gate configJson={firstConfig} />);
    await waitFor(() => expect(screen.getByTestId('gpu-status').textContent).toBe('blocked'));
    expect(restarted.attempted).not.toHaveBeenCalled();
    expect(getPreference).toHaveBeenCalledTimes(2);
    expect(digest).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['applicationId', 'com.boardsesh.app.other'],
    ['nativeApplicationVersion', '2.7.0'],
    ['nativeBuildVersion', '201'],
    ['apiVersion', 6],
    ['updateId', '7d1e9b3a-2c4f-4e6a-8b0d-5f9c1a3e7b24'],
    ['updateId', null],
  ] as const)('isolates saved failures when the native binary or OTA update changes: %s', async (part, replacement) => {
    storage.record = persisted([firstHash]);
    Object.assign(identity, { [part]: replacement });
    const { Gate, attempted, recordGpuConfigFailure } = await loadGate();
    render(<Gate configJson={firstConfig} />);
    await waitFor(() => expect(attempted).toHaveBeenCalledExactlyOnceWith(firstConfig));
    expect(setPreference).not.toHaveBeenCalled();
    act(() => recordGpuConfigFailure(firstConfig, identity.apiVersion));
    await waitFor(() => expect(storage.record).toEqual(persisted([firstHash])));
    expect(setPreference).toHaveBeenCalledExactlyOnceWith('auraGpuFailedConfigs.v1', persisted([firstHash]));
  });

  it('retries a config blocked under an earlier OTA update after a new update launches', async () => {
    const first = await loadGate();
    const view = render(<first.Gate configJson={firstConfig} />);
    await waitFor(() => expect(first.attempted).toHaveBeenCalledTimes(1));
    act(() => first.recordGpuConfigFailure(firstConfig, identity.apiVersion));
    await waitFor(() => expect(storage.record).toEqual(persisted([firstHash])));
    view.unmount();
    // The same native binary relaunches into an OTA that fixed the failure.
    vi.resetModules();
    identity.updateId = '7d1e9b3a-2c4f-4e6a-8b0d-5f9c1a3e7b24';
    const updated = await loadGate();
    render(<updated.Gate configJson={firstConfig} />);
    await waitFor(() => expect(screen.getByTestId('gpu-status').textContent).toBe('allowed'));
    expect(updated.attempted).toHaveBeenCalledExactlyOnceWith(firstConfig);
    // A failure under the new update replaces the stale set rather than adding to it.
    act(() => updated.recordGpuConfigFailure(secondConfig, identity.apiVersion));
    await waitFor(() => expect(storage.record).toEqual(persisted([secondHash])));
  });

  it('uses PNG for the rest of the session after two presentation timeouts in a row, without saving it', async () => {
    const first = await loadGate();
    render(<first.Gate configJson={firstConfig} />);
    await waitFor(() => expect(first.attempted).toHaveBeenCalledTimes(1));
    await act(async () => first.recordGpuPresentationTimeout(firstConfig));
    expect(screen.getByTestId('gpu-status').textContent).toBe('allowed');
    await act(async () => first.recordGpuPresentationTimeout(firstConfig));
    expect(screen.getByTestId('gpu-status').textContent).toBe('blocked');
    expect(screen.queryByTestId('gpu-attempt')).toBeNull();
    expect(setPreference).not.toHaveBeenCalled();
    cleanup();
    // A relaunch (or an OTA) starts a fresh JS runtime and tries the GPU again.
    vi.resetModules();
    const relaunched = await loadGate();
    render(<relaunched.Gate configJson={firstConfig} />);
    await waitFor(() => expect(screen.getByTestId('gpu-status').textContent).toBe('allowed'));
    expect(relaunched.attempted).toHaveBeenCalledExactlyOnceWith(firstConfig);
  });

  it('starts the timeout count over after the config presents', async () => {
    const { Gate, attempted, recordGpuPresentationTimeout, recordGpuPresented } = await loadGate();
    render(<Gate configJson={firstConfig} />);
    await waitFor(() => expect(attempted).toHaveBeenCalledTimes(1));
    await act(async () => recordGpuPresentationTimeout(firstConfig));
    await act(async () => recordGpuPresented(firstConfig));
    await act(async () => recordGpuPresentationTimeout(firstConfig));
    expect(screen.getByTestId('gpu-status').textContent).toBe('allowed');
    // Another config's timeouts never count against this one.
    await act(async () => recordGpuPresentationTimeout(secondConfig));
    expect(screen.getByTestId('gpu-status').textContent).toBe('allowed');
    await act(async () => recordGpuPresentationTimeout(firstConfig));
    expect(screen.getByTestId('gpu-status').textContent).toBe('blocked');
    expect(setPreference).not.toHaveBeenCalled();
  });

  it('keeps GPU unavailable when saved latches cannot be read, including on remount', async () => {
    getPreference.mockRejectedValue(new Error('Storage locked'));
    const { Gate, attempted, recordGpuConfigFailure } = await loadGate();
    const view = render(<Gate configJson={firstConfig} />);
    await waitFor(() => expect(screen.getByTestId('gpu-status').textContent).toBe('unavailable'));
    act(() => recordGpuConfigFailure(firstConfig, identity.apiVersion));
    view.unmount();
    render(<Gate configJson={firstConfig} />);
    expect(screen.getByTestId('gpu-status').textContent).toBe('unavailable');
    expect(attempted).not.toHaveBeenCalled();
    expect(getPreference).toHaveBeenCalledTimes(1);
    expect(setPreference).not.toHaveBeenCalled();
  });

  it('keeps API 0 failures RAM-only and leaves a native API record untouched across restarts', async () => {
    const nativeRecord = persisted([firstHash]);
    storage.record = nativeRecord;
    identity.apiVersion = 0;
    const first = await loadGate();
    const view = render(<first.Gate configJson={firstConfig} />);
    await waitFor(() => expect(first.attempted).toHaveBeenCalledTimes(1));
    act(() => first.recordGpuConfigFailure(firstConfig, identity.apiVersion));
    expect(screen.getByTestId('gpu-status').textContent).toBe('blocked');
    expect(getPreference).not.toHaveBeenCalled();
    expect(setPreference).not.toHaveBeenCalled();
    expect(storage.record).toBe(nativeRecord);
    view.unmount();
    vi.resetModules();
    const restarted = await loadGate();
    render(<restarted.Gate configJson={firstConfig} />);
    await waitFor(() => expect(restarted.attempted).toHaveBeenCalledTimes(1));
    expect(getPreference).not.toHaveBeenCalled();
    expect(setPreference).not.toHaveBeenCalled();
    expect(storage.record).toBe(nativeRecord);
  });

  it.each([
    ['nativeBuildVersion', ''],
    ['applicationId', '   '],
  ] as const)('keeps an incomplete binary identity RAM-only: %s', async (part, replacement) => {
    Object.assign(identity, { [part]: replacement });
    const { Gate, attempted, recordGpuConfigFailure } = await loadGate();
    render(<Gate configJson={firstConfig} />);
    await waitFor(() => expect(attempted).toHaveBeenCalledTimes(1));
    act(() => recordGpuConfigFailure(firstConfig, identity.apiVersion));
    expect(screen.getByTestId('gpu-status').textContent).toBe('blocked');
    expect(getPreference).not.toHaveBeenCalled();
    expect(setPreference).not.toHaveBeenCalled();
  });

  it('uses PNG rather than attempting GPU when asynchronous hashing fails', async () => {
    digest.mockRejectedValue(new Error('Digest unavailable'));
    const { Gate, attempted } = await loadGate();
    render(<Gate configJson={firstConfig} />);
    await waitFor(() => expect(screen.getByTestId('gpu-status').textContent).toBe('unavailable'));
    expect(attempted).not.toHaveBeenCalled();
    expect(setPreference).not.toHaveBeenCalled();
  });

  it('ignores an old configuration digest completing after its replacement failed hashing', async () => {
    const oldHash = deferred<string>();
    const newHash = deferred<string>();
    digest.mockImplementation((_algorithm, configJson) =>
      configJson === firstConfig ? oldHash.promise : newHash.promise,
    );
    const { Gate, attempted } = await loadGate();
    const view = render(<Gate configJson={firstConfig} />);
    view.rerender(<Gate configJson={secondConfig} />);
    await act(async () => newHash.reject(new Error('Replacement hash failed')));
    expect(screen.getByTestId('gpu-status').textContent).toBe('unavailable');
    await act(async () => oldHash.resolve(firstHash));
    expect(screen.getByTestId('gpu-status').textContent).toBe('unavailable');
    expect(attempted).not.toHaveBeenCalled();
  });

  it('honors a failure recorded before its digest and storage hydration resolve', async () => {
    const hash = deferred<string>();
    const saved = deferred<unknown>();
    digest.mockReturnValue(hash.promise);
    getPreference.mockReturnValue(saved.promise);
    const { Gate, attempted, recordGpuConfigFailure } = await loadGate();
    recordGpuConfigFailure(firstConfig, identity.apiVersion);
    render(<Gate configJson={firstConfig} />);
    await act(async () => hash.resolve(firstHash));
    expect(screen.getByTestId('gpu-status').textContent).toBe('loading');
    await act(async () => saved.resolve(null));
    await waitFor(() => expect(screen.getByTestId('gpu-status').textContent).toBe('blocked'));
    expect(attempted).not.toHaveBeenCalled();
    await waitFor(() => expect(storage.record).toEqual(persisted([firstHash])));
  });
});
