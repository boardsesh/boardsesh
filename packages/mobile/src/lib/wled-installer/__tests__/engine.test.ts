import { describe, expect, it, vi } from 'vitest';
import {
  createWledInstaller,
  readManifest,
  settingsPreserved,
  WledInstallerError,
  WLED_APP_SLOT_BYTES,
  type FirmwareRelease,
  type InstallerIO,
  type InstallJournal,
} from '../engine';

const original = {
  mac: '001122aabbcc',
  name: 'Gym LEDs',
  ver: '16.0.1',
  arch: 'esp32',
  flash: 4,
  brand: 'WLED',
  product: 'FOSS',
  leds: { count: 1000 },
};
const release: FirmwareRelease = {
  id: 'test-qualified',
  hardwareModel: 'GL-C-015WL-D',
  architecture: 'esp32',
  flashBytes: 4_194_304,
  sourceProfiles: [{ version: '16.0.1', brand: 'WLED', product: 'FOSS', appSlotBytes: WLED_APP_SLOT_BYTES }],
  wledVersion: '16.0.1',
  usermodVersion: '0.1.0',
  protocolVersion: 1,
  buildId: 'test-audio',
  audio: true,
  imageBytes: 1_000_000,
  appSlotBytes: WLED_APP_SLOT_BYTES,
  url: 'https://example.com/firmware.bin',
  sha256: 'a'.repeat(64),
  qualified: true,
};
const config = {
  hw: { led: { count: 1000, pin: 16 }, relay: { pin: 18 } },
  nw: { ssid: 'local' },
  um: { AudioReactive: { enabled: true, pin: [32, 33] } },
};
const presets = { '1': { name: 'Audio', fx: 123 } };
function setup(releases: FirmwareRelease[] = [release]) {
  let uploaded = false;
  let pending: InstallJournal | null = null;
  let downloadedRelease = release;
  const io: InstallerIO = {
    readJson: vi.fn(async (url) => {
      if (url.endsWith('release-manifest.json')) return { manifestVersion: 1, releases };
      if (url.endsWith('/cfg.json')) return config;
      if (url.endsWith('/presets.json')) return presets;
      return uploaded
        ? {
            ...original,
            bleJson: {
              controllerId: 'wled-001122aabbcc',
              protocolVersion: 1,
              usermodVersion: '0.1.0',
              buildId: downloadedRelease.buildId,
              audio: downloadedRelease.audio,
              ledCount: 1000,
              maxMessageBytes: 8192,
            },
          }
        : original;
    }),
    checkUpdateAccess: vi.fn(async () => undefined),
    saveBackup: vi.fn(async () => 'file:///backup.json'),
    exportBackup: vi.fn(async () => undefined),
    download: vi.fn(async (candidate) => {
      downloadedRelease = candidate;
      return { uri: 'file:///firmware.bin', bytes: candidate.imageBytes, sha256: candidate.sha256 };
    }),
    upload: vi.fn(async () => {
      uploaded = true;
    }),
    readJournal: vi.fn(async () => pending),
    writeJournal: vi.fn(async (journal) => {
      pending = journal;
    }),
    clearJournal: vi.fn(async () => {
      pending = null;
    }),
    awake: vi.fn(async () => undefined),
    wait: vi.fn(async () => undefined),
  };
  const installer = createWledInstaller('192.168.1.5', io, vi.fn());
  return {
    io,
    installer,
    setJournal: (journal: InstallJournal) => {
      pending = journal;
    },
  };
}
describe('WLED owner installer', () => {
  it('normalizes legacy qualified releases and accepts explicit unqualified betas', () => {
    expect(readManifest({ manifestVersion: 1, releases: [release] })[0]).toMatchObject({
      channel: 'stable',
      qualified: true,
    });
    expect(
      readManifest({ manifestVersion: 1, releases: [{ ...release, channel: 'beta', qualified: false }] })[0],
    ).toMatchObject({ channel: 'beta', qualified: false });
  });
  it.each([
    { qualified: false },
    { channel: 'stable', qualified: false },
    { channel: 'beta', qualified: true },
    { channel: 'alpha', qualified: false },
    { channel: 'alpha', qualified: true },
  ])('rejects release status without an explicit valid channel/qualification pair: %j', (status) => {
    expect(() => readManifest({ manifestVersion: 1, releases: [{ ...release, ...status }] })).toThrow();
  });
  it('requires explicit beta consent before downloading or uploading unqualified firmware', async () => {
    const { io, installer } = setup([{ ...release, channel: 'beta', qualified: false }]);
    await installer.inspect();
    expect(installer.getSnapshot().release).toMatchObject({ channel: 'beta', qualified: false });
    await installer.install(true, false);
    expect(io.download).not.toHaveBeenCalled();
    expect(io.upload).not.toHaveBeenCalled();
    expect(io.writeJournal).not.toHaveBeenCalled();
  });
  it('allows a matching beta after model and beta consent and verifies preservation', async () => {
    const { io, installer } = setup([{ ...release, channel: 'beta', qualified: false }]);
    await installer.inspect();
    await installer.install(true, false, true);
    expect(installer.getSnapshot().stage).toBe('complete');
    expect(io.upload).toHaveBeenCalledOnce();
    expect(io.writeJournal).toHaveBeenCalledWith(
      expect.objectContaining({ release: expect.objectContaining({ channel: 'beta', qualified: false }) }),
    );
    expect(io.clearJournal).toHaveBeenCalledOnce();
  });
  it.each([
    [false, true, true],
    [true, false, true],
    [true, true, false],
  ])(
    'keeps model, no-audio and beta confirmations independent: %j',
    async (modelConfirmed, noAudioConfirmed, betaConfirmed) => {
      const { io, installer } = setup([{ ...release, audio: false, channel: 'beta', qualified: false }]);
      await installer.inspect();
      await installer.install(modelConfirmed, noAudioConfirmed, betaConfirmed);
      expect(io.download).not.toHaveBeenCalled();
      expect(io.upload).not.toHaveBeenCalled();
    },
  );
  it('permits a no-audio beta only when all three confirmations are explicit', async () => {
    const { io, installer } = setup([{ ...release, audio: false, channel: 'beta', qualified: false }]);
    await installer.inspect();
    await installer.install(true, true, true);
    expect(installer.getSnapshot().stage).toBe('complete');
    expect(io.upload).toHaveBeenCalledOnce();
  });
  it('keeps source firmware matching for a beta image', async () => {
    const { io, installer } = setup([
      {
        ...release,
        channel: 'beta',
        qualified: false,
        sourceProfiles: [{ ...release.sourceProfiles[0], version: '16.0.2' }],
      },
    ]);
    await installer.inspect();
    expect(installer.getSnapshot().release).toBeUndefined();
    await installer.install(true, true, true);
    expect(io.download).not.toHaveBeenCalled();
    expect(io.upload).not.toHaveBeenCalled();
  });
  it('prefers a qualified audio release when an opt-in beta is also compatible', async () => {
    const stable = { ...release, id: 'stable-audio', buildId: 'stable-audio' };
    const beta: FirmwareRelease = {
      ...release,
      id: 'beta-audio',
      buildId: 'beta-audio',
      channel: 'beta',
      qualified: false,
    };
    const { io, installer } = setup([beta, stable]);
    await installer.inspect();
    expect(installer.getSnapshot().release?.id).toBe('stable-audio');
    await installer.install(true, false);
    expect(installer.getSnapshot().stage).toBe('complete');
    expect(io.download).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'stable-audio', channel: 'stable' }),
      expect.any(AbortSignal),
    );
  });
  it('backs up locally but cannot install when no compatible release exists', async () => {
    const { io, installer } = setup([]);
    await installer.inspect();
    expect(installer.getSnapshot()).toMatchObject({ stage: 'ready', backup: { uri: 'file:///backup.json' } });
    expect(installer.getSnapshot().release).toBeUndefined();
    await installer.install(true, true);
    expect(io.upload).not.toHaveBeenCalled();
  });
  it('requires owner model confirmation after the backup is durable', async () => {
    const { io, installer } = setup();
    await installer.inspect();
    expect(io.saveBackup).toHaveBeenCalledWith(
      expect.objectContaining({ controllerId: 'wled-001122aabbcc' }),
      config,
      presets,
    );
    await installer.install(false, false);
    expect(io.download).not.toHaveBeenCalled();
    expect(io.upload).not.toHaveBeenCalled();
  });
  it('verifies build, identity, settings and presets before reporting success', async () => {
    const { io, installer } = setup();
    await installer.inspect();
    await installer.install(true, false);
    expect(installer.getSnapshot().stage).toBe('complete');
    expect(io.writeJournal).toHaveBeenCalledBefore(vi.mocked(io.upload));
    expect(io.clearJournal).toHaveBeenCalledOnce();
  });
  it('never uploads a checksum mismatch', async () => {
    const { io, installer } = setup();
    vi.mocked(io.download).mockResolvedValue({
      uri: 'file:///firmware.bin',
      bytes: release.imageBytes,
      sha256: 'b'.repeat(64),
    });
    await installer.inspect();
    await installer.install(true, false);
    expect(installer.getSnapshot()).toMatchObject({ stage: 'failed', error: 'checksum' });
    expect(io.upload).not.toHaveBeenCalled();
  });
  it('never uploads oversized or truncated images', async () => {
    const { io, installer } = setup();
    vi.mocked(io.download).mockResolvedValue({
      uri: 'file:///firmware.bin',
      bytes: WLED_APP_SLOT_BYTES + 1,
      sha256: release.sha256,
    });
    await installer.inspect();
    await installer.install(true, false);
    expect(installer.getSnapshot().error).toBe('imageSize');
    expect(io.upload).not.toHaveBeenCalled();
  });
  it('honors OTA/PIN locks before download or upload', async () => {
    const { io, installer } = setup();
    vi.mocked(io.checkUpdateAccess).mockRejectedValue(new WledInstallerError('locked'));
    await installer.inspect();
    expect(io.download).not.toHaveBeenCalled();
    expect(io.upload).not.toHaveBeenCalled();
  });
  it('does not use a version match as proof of hardware compatibility', async () => {
    const { io, installer } = setup([
      { ...release, sourceProfiles: [{ ...release.sourceProfiles[0], brand: 'Other factory' }] },
    ]);
    await installer.inspect();
    await installer.install(true, false);
    expect(io.upload).not.toHaveBeenCalled();
  });
  it('requires explicit approval for an audio-disabled image', async () => {
    const { io, installer } = setup([{ ...release, audio: false }]);
    await installer.inspect();
    await installer.install(true, false);
    expect(io.upload).not.toHaveBeenCalled();
  });
  it('does not claim success from an HTTP upload disconnect', async () => {
    const { io, installer } = setup();
    vi.mocked(io.upload).mockRejectedValue(new Error('disconnect'));
    await installer.inspect();
    await installer.install(true, false);
    expect(installer.getSnapshot()).toMatchObject({ stage: 'interrupted', error: 'verification' });
    expect(io.clearJournal).not.toHaveBeenCalled();
    expect(io.upload).toHaveBeenCalledOnce();
  });
  it('rejects changed LED or microphone settings after reboot', async () => {
    const { io, installer } = setup();
    vi.mocked(io.readJson)
      .mockReset()
      .mockImplementation(async (url) => {
        if (url.endsWith('release-manifest.json')) return { manifestVersion: 1, releases: [release] };
        if (url.endsWith('/cfg.json'))
          return vi.mocked(io.upload).mock.calls.length ? { ...config, hw: { led: { pin: 2 } } } : config;
        if (url.endsWith('/presets.json')) return presets;
        return vi.mocked(io.upload).mock.calls.length
          ? {
              ...original,
              bleJson: {
                controllerId: 'wled-001122aabbcc',
                protocolVersion: 1,
                usermodVersion: '0.1.0',
                buildId: release.buildId,
                audio: true,
                ledCount: 1000,
                maxMessageBytes: 8192,
              },
            }
          : original;
      });
    await installer.inspect();
    await installer.install(true, false);
    expect(installer.getSnapshot()).toMatchObject({ stage: 'interrupted', error: 'preservation' });
    expect(io.clearJournal).not.toHaveBeenCalled();
  });
  it('serializes duplicate install taps', async () => {
    const { io, installer } = setup();
    await installer.inspect();
    await Promise.all([installer.install(true, false), installer.install(true, false)]);
    expect(io.upload).toHaveBeenCalledOnce();
  });
  it('cancels before uploading and never replays a cancelled download', async () => {
    const { io, installer } = setup();
    await installer.inspect();
    vi.mocked(io.download).mockImplementation(async () => {
      installer.cancel();
      return { uri: 'file:///firmware.bin', bytes: release.imageBytes, sha256: release.sha256 };
    });
    await installer.install(true, false);
    expect(io.upload).not.toHaveBeenCalled();
  });
  it('inspects an interrupted upload before permitting another owner attempt', async () => {
    const { io, installer } = setup();
    vi.mocked(io.upload).mockRejectedValue(new Error('lost local Wi-Fi'));
    await installer.inspect();
    await installer.install(true, false);
    expect(installer.getSnapshot().stage).toBe('interrupted');
    const resumed = createWledInstaller('192.168.1.5', io, vi.fn());
    await resumed.inspect();
    expect(resumed.getSnapshot().stage).toBe('interrupted');
    await resumed.verify();
    expect(resumed.getSnapshot().stage).toBe('ready');
    expect(io.upload).toHaveBeenCalledOnce();
    expect(io.clearJournal).toHaveBeenCalledOnce();
  });
  it('rejects a different controller returning at the same local IP', async () => {
    const { io, installer } = setup();
    await installer.inspect();
    const originalRead = vi.mocked(io.readJson).getMockImplementation()!;
    vi.mocked(io.readJson).mockImplementation(async (url, signal) =>
      url.endsWith('/json/info') && vi.mocked(io.upload).mock.calls.length
        ? { ...original, mac: 'aabbccddeeff' }
        : originalRead(url, signal),
    );
    await installer.install(true, false);
    expect(installer.getSnapshot()).toMatchObject({ stage: 'interrupted', error: 'verification' });
    expect(io.clearJournal).not.toHaveBeenCalled();
  });
  it('only ignores the BLE module defaults when comparing saved settings', () => {
    const backup = { config, presets, uri: 'file:///backup.json' };
    expect(settingsPreserved(backup, { ...config, um: { ...config.um, 'BLE JSON': { enabled: true } } }, presets)).toBe(
      true,
    );
    expect(settingsPreserved(backup, { ...config, um: { AudioReactive: { enabled: false } } }, presets)).toBe(false);
    expect(settingsPreserved(backup, config, {})).toBe(false);
    for (const enabled of [false, true]) {
      const savedConfig = { ...config, um: { ...config.um, 'BLE JSON': { enabled } } };
      const saved = { ...backup, config: savedConfig };
      expect(settingsPreserved(saved, savedConfig, presets)).toBe(true);
      expect(
        settingsPreserved(
          saved,
          { ...savedConfig, um: { ...savedConfig.um, 'BLE JSON': { enabled: !enabled } } },
          presets,
        ),
      ).toBe(false);
    }
  });
  it('rejects unqualified releases and external plaintext image URLs', () => {
    expect(() => readManifest({ manifestVersion: 1, releases: [{ ...release, qualified: false }] })).toThrow();
    expect(() =>
      readManifest({ manifestVersion: 1, releases: [{ ...release, url: 'http://example.com/fw.bin' }] }),
    ).toThrow();
    expect(() =>
      readManifest({ manifestVersion: 1, releases: [{ ...release, imageBytes: WLED_APP_SLOT_BYTES + 1 }] }),
    ).toThrow();
  });
});
