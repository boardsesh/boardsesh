import { describe, expect, it, vi } from 'vitest';

const appState = vi.hoisted(() => ({ currentState: 'active' }));
vi.mock('react-native', () => ({ AppState: appState }));
vi.mock('../../../../modules/wifi-join/src', () => ({
  join: vi.fn(),
  release: vi.fn(),
  isJoined: vi.fn(() => false),
}));

import {
  createWledHotspotInstaller,
  createWledInstaller,
  WledInstallerError,
  WLED_APP_SLOT_BYTES,
  WLED_HOTSPOT_URL,
  WLED_RELEASE_MANIFEST_URL,
  type ControllerLink,
  type FirmwareRelease,
  type InstallerIO,
  type InstallerSnapshot,
  type InstallJournal,
} from '../engine';
import { createHotspotLink, hotspotInstallerIO, type HotspotLinkDeps } from '../hotspot';

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
  id: 'beta-audio',
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
  qualified: false,
  channel: 'beta',
};
const config = { hw: { led: { count: 1000, pin: 16 } }, nw: { ssid: '' } };
const presets = { '1': { name: 'Climb', fx: 0 } };

/**
 * A controller that answers only while the phone is on its hotspot, and an
 * event log that shows the order of internet, join and controller work.
 */
function setup(releases: FirmwareRelease[] = [release]) {
  const events: string[] = [];
  const state = { joined: false, uploaded: false, journal: null as InstallJournal | null };
  const snapshots: InstallerSnapshot[] = [];
  const io: InstallerIO = {
    readJson: vi.fn(async (url: string) => {
      if (url === WLED_RELEASE_MANIFEST_URL) {
        if (state.joined) throw new WledInstallerError('unavailable');
        events.push('manifest');
        return { manifestVersion: 1, releases };
      }
      if (!state.joined) throw new WledInstallerError('unavailable');
      const path = url.slice(WLED_HOTSPOT_URL.length);
      events.push(`read ${path}`);
      if (path === '/cfg.json') return config;
      if (path === '/presets.json') return presets;
      return state.uploaded
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
    }),
    checkUpdateAccess: vi.fn(async () => {
      if (!state.joined) throw new WledInstallerError('unavailable');
      events.push('updateAccess');
    }),
    saveBackup: vi.fn(async () => 'file:///backup.json'),
    exportBackup: vi.fn(async () => undefined),
    download: vi.fn(async (candidate: FirmwareRelease) => {
      if (state.joined) throw new WledInstallerError('unavailable');
      events.push(`download ${candidate.id}`);
      return { uri: `file:///${candidate.id}.bin`, bytes: candidate.imageBytes, sha256: candidate.sha256 };
    }),
    upload: vi.fn(async () => {
      events.push('upload');
      state.uploaded = true;
    }),
    readJournal: vi.fn(async () => state.journal),
    writeJournal: vi.fn(async (journal: InstallJournal) => {
      state.journal = journal;
    }),
    clearJournal: vi.fn(async () => {
      state.journal = null;
    }),
    awake: vi.fn(async () => undefined),
    wait: vi.fn(async () => undefined),
  };
  const link: ControllerLink = {
    join: vi.fn(async () => {
      events.push('join');
      state.joined = true;
    }),
    ensure: vi.fn(async () => {
      if (state.joined) return;
      events.push('rejoin');
      state.joined = true;
    }),
    release: vi.fn(async () => {
      events.push('release');
      state.joined = false;
    }),
  };
  const installer = createWledHotspotInstaller(io, link, (next) => snapshots.push(next));
  return { io, link, installer, events, state, snapshots };
}

describe('WLED install over the controller hotspot', () => {
  it('downloads and verifies every image before joining, then inspects at 4.3.2.1', async () => {
    const { installer, events, link } = setup();
    await installer.inspect(true);
    expect(events.slice(0, 4)).toEqual(['release', 'manifest', 'download beta-audio', 'join']);
    expect(events.indexOf('join')).toBeLessThan(events.indexOf('read /json/info'));
    expect(installer.getSnapshot()).toMatchObject({ stage: 'ready', release: { id: 'beta-audio' } });
    // Joined and waiting for the owner's install tap; nothing else released it.
    expect(vi.mocked(link.release)).toHaveBeenCalledOnce();
  });

  it('publishes Downloading, then Connecting, then the controller check', async () => {
    const { installer, snapshots } = setup();
    await installer.inspect(true);
    const stages = snapshots.map((snapshot) => snapshot.stage);
    expect(stages.slice(0, 4)).toEqual(['downloading', 'connecting', 'inspecting', 'backingUp']);
  });

  it('installs the image it already downloaded, verifies, then releases the hotspot', async () => {
    const { installer, events, io, snapshots } = setup();
    await installer.inspect(true);
    await installer.install(true, false, true);
    expect(installer.getSnapshot().stage).toBe('complete');
    expect(io.download).toHaveBeenCalledOnce();
    expect(io.upload).toHaveBeenCalledWith(
      WLED_HOTSPOT_URL,
      'file:///beta-audio.bin',
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(io.writeJournal).toHaveBeenCalledBefore(vi.mocked(io.upload));
    expect(events.at(-1)).toBe('release');
    expect(snapshots.map((snapshot) => snapshot.stage)).toEqual(
      expect.arrayContaining(['uploading', 'rebooting', 'verifying', 'complete']),
    );
  });

  it('never downloads beta firmware before the owner accepts the beta', async () => {
    const { installer, io, link } = setup();
    await installer.inspect(false);
    expect(io.download).not.toHaveBeenCalled();
    expect(installer.getSnapshot()).toMatchObject({ stage: 'ready' });
    expect(installer.getSnapshot().release).toBeUndefined();
    // No installable release, so the hotspot is not kept.
    expect(vi.mocked(link.release)).toHaveBeenCalledTimes(2);
  });

  it('never joins when the download fails its checksum', async () => {
    const { installer, io, link } = setup();
    vi.mocked(io.download).mockResolvedValue({ uri: 'file:///bad.bin', bytes: 1_000_000, sha256: 'b'.repeat(64) });
    await installer.inspect(true);
    expect(installer.getSnapshot()).toMatchObject({ stage: 'failed', error: 'checksum' });
    expect(link.join).not.toHaveBeenCalled();
    expect(io.upload).not.toHaveBeenCalled();
  });

  it('reports a refused join and releases', async () => {
    const { installer, io, link } = setup();
    vi.mocked(link.join).mockRejectedValue(new WledInstallerError('hotspotDenied'));
    await installer.inspect(true);
    expect(installer.getSnapshot()).toMatchObject({ stage: 'failed', error: 'hotspotDenied' });
    expect(vi.mocked(io.readJson).mock.calls.every(([url]) => url === WLED_RELEASE_MANIFEST_URL)).toBe(true);
    expect(vi.mocked(link.release)).toHaveBeenCalledTimes(2);
  });

  it('releases when the owner cancels while joining', async () => {
    const { installer, link, events } = setup();
    vi.mocked(link.join).mockImplementation(async () => {
      events.push('join');
      installer.cancel();
    });
    await installer.inspect(true);
    expect(installer.getSnapshot().error).toBe('cancelled');
    expect(events.at(-1)).toBe('release');
  });

  it('releases when cancelled at a ready backup, and rejoins for a later install', async () => {
    const { installer, link, events } = setup();
    await installer.inspect(true);
    installer.release();
    await vi.waitFor(() => expect(events.at(-1)).toBe('release'));
    await installer.install(true, false, true);
    expect(link.ensure).toHaveBeenCalled();
    expect(events).toContain('rejoin');
    expect(installer.getSnapshot().stage).toBe('complete');
  });

  it('releases after a failed upload', async () => {
    const { installer, io, events } = setup();
    vi.mocked(io.upload).mockRejectedValue(new WledInstallerError('locked'));
    await installer.inspect(true);
    await installer.install(true, false, true);
    expect(installer.getSnapshot()).toMatchObject({ stage: 'interrupted', error: 'locked' });
    expect(events.at(-1)).toBe('release');
  });

  it('rejoins the hotspot after WLED restarts before verifying', async () => {
    const { installer, io, state, events } = setup();
    vi.mocked(io.upload).mockImplementation(async () => {
      events.push('upload');
      state.uploaded = true;
      // WLED reboots: its hotspot goes away with it.
      state.joined = false;
    });
    await installer.inspect(true);
    await installer.install(true, false, true);
    expect(installer.getSnapshot().stage).toBe('complete');
    const afterUpload = events.slice(events.indexOf('upload'));
    expect(afterUpload.slice(0, 2)).toEqual(['upload', 'rejoin']);
    expect(afterUpload).toContain('read /cfg.json');
  });

  it('marks the install unconfirmed when the hotspot never comes back', async () => {
    const { installer, io, link, state, events } = setup();
    vi.mocked(io.upload).mockImplementation(async () => {
      state.uploaded = true;
      state.joined = false;
    });
    vi.mocked(link.ensure).mockImplementation(async () => {
      if (!state.joined) throw new WledInstallerError('hotspotLost');
    });
    await installer.inspect(true);
    await installer.install(true, false, true);
    expect(installer.getSnapshot()).toMatchObject({ stage: 'interrupted', error: 'hotspotLost' });
    expect(io.clearJournal).not.toHaveBeenCalled();
    expect(events.at(-1)).toBe('release');
  });

  it('rejoins to check an interrupted install, then releases', async () => {
    const { installer, io, link, state } = setup();
    vi.mocked(io.upload).mockImplementation(async () => {
      state.uploaded = true;
      state.joined = false;
      // The first rejoin after the restart fails.
      vi.mocked(link.ensure).mockRejectedValueOnce(new WledInstallerError('hotspotLost'));
    });
    await installer.inspect(true);
    await installer.install(true, false, true);
    expect(installer.getSnapshot().stage).toBe('interrupted');
    await installer.verify();
    expect(installer.getSnapshot().stage).toBe('complete');
    expect(state.joined).toBe(false);
  });

  it('keeps the Wi-Fi route downloading only at install, after checking the controller', async () => {
    const { io } = setup();
    const order: string[] = [];
    vi.mocked(io.checkUpdateAccess).mockImplementation(async () => {
      order.push('updateAccess');
    });
    vi.mocked(io.download).mockImplementation(async (candidate) => {
      order.push('download');
      return { uri: 'file:///fw.bin', bytes: candidate.imageBytes, sha256: candidate.sha256 };
    });
    vi.mocked(io.readJson).mockImplementation(async (url) => {
      if (url === WLED_RELEASE_MANIFEST_URL) return { manifestVersion: 1, releases: [release] };
      if (url.endsWith('/cfg.json')) return config;
      if (url.endsWith('/presets.json')) return presets;
      return original;
    });
    const wifi = createWledInstaller('192.168.1.5', io, vi.fn());
    await wifi.inspect();
    expect(order).toEqual(['updateAccess']);
    await wifi.install(true, false, true);
    expect(order.slice(0, 3)).toEqual(['updateAccess', 'updateAccess', 'download']);
  });
});

function linkDeps(overrides: Partial<HotspotLinkDeps> = {}) {
  const wifi = {
    join: vi.fn(async () => ({ joined: true as const })),
    release: vi.fn(async () => undefined),
    isJoined: vi.fn(() => true),
  };
  return {
    wifi,
    deps: { wifi, wait: vi.fn(async () => undefined), isForeground: () => true, ...overrides } as HotspotLinkDeps,
  };
}
const credentials = { ssid: 'WLED-AP', passphrase: 'wled1234' };

describe('controller hotspot link', () => {
  it('joins WLED-AP for the 4.3.2.1 subnet', async () => {
    const { wifi, deps } = linkDeps();
    await createHotspotLink(credentials, deps).join(new AbortController().signal);
    expect(wifi.join).toHaveBeenCalledWith(expect.objectContaining({ ssid: 'WLED-AP', hostIp: '4.3.2.1' }));
  });

  it.each([
    ['user-denied', 'hotspotDenied'],
    ['not-found', 'hotspotNotFound'],
    ['timeout', 'hotspotTimeout'],
    ['wrong-password', 'hotspotPassword'],
    ['unsupported', 'hotspotUnsupported'],
    ['failed', 'hotspotNotFound'],
  ] as const)('maps %s to %s', async (nativeError, installerError) => {
    const { wifi, deps } = linkDeps();
    wifi.join.mockResolvedValue({ joined: false, error: nativeError } as never);
    await expect(createHotspotLink(credentials, deps).join(new AbortController().signal)).rejects.toMatchObject({
      code: installerError,
    });
  });

  it('withdraws the OS request when cancelled mid-join', async () => {
    const { wifi, deps } = linkDeps();
    const controller = new AbortController();
    wifi.join.mockImplementation(async () => {
      controller.abort();
      return { joined: false, error: 'failed' } as never;
    });
    await expect(createHotspotLink(credentials, deps).join(controller.signal)).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(wifi.release).toHaveBeenCalled();
  });

  it('reports joining while the OS prompt is up, so backgrounding does not cancel it', async () => {
    const { wifi, deps } = linkDeps();
    const link = createHotspotLink(credentials, deps);
    let duringJoin = false;
    wifi.join.mockImplementation(async () => {
      duringJoin = link.isJoining();
      return { joined: true };
    });
    await link.join(new AbortController().signal);
    expect(duringJoin).toBe(true);
    expect(link.isJoining()).toBe(false);
  });

  it('leaves the hotspot when the join lands after the owner left the app', async () => {
    const { wifi, deps } = linkDeps({ isForeground: () => false });
    await expect(createHotspotLink(credentials, deps).join(new AbortController().signal)).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(wifi.release).toHaveBeenCalled();
  });

  it('does nothing to ensure a link that is still joined', async () => {
    const { wifi, deps } = linkDeps();
    await createHotspotLink(credentials, deps).ensure(new AbortController().signal);
    expect(wifi.join).not.toHaveBeenCalled();
  });

  it('waits for the OS to rejoin by itself before asking again', async () => {
    const { wifi, deps } = linkDeps();
    wifi.isJoined.mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValue(true);
    await createHotspotLink(credentials, deps).ensure(new AbortController().signal);
    expect(wifi.join).not.toHaveBeenCalled();
    expect(deps.wait).toHaveBeenCalledTimes(2);
  });

  it('asks again after a restart and gives up with hotspotLost after two failed joins', async () => {
    const { wifi, deps } = linkDeps();
    wifi.isJoined.mockReturnValue(false);
    wifi.join.mockResolvedValue({ joined: false, error: 'timeout' } as never);
    await expect(createHotspotLink(credentials, deps).ensure(new AbortController().signal)).rejects.toMatchObject({
      code: 'hotspotLost',
    });
    expect(wifi.join).toHaveBeenCalledTimes(2);
  });

  it('stops rejoining when the owner refuses the prompt', async () => {
    const { wifi, deps } = linkDeps();
    wifi.isJoined.mockReturnValue(false);
    wifi.join.mockResolvedValue({ joined: false, error: 'user-denied' } as never);
    await expect(createHotspotLink(credentials, deps).ensure(new AbortController().signal)).rejects.toMatchObject({
      code: 'hotspotDenied',
    });
    expect(wifi.join).toHaveBeenCalledOnce();
  });
});

describe('hotspot request guard', () => {
  it('never sends a request to 4.3.2.1 unless the phone is on the hotspot', async () => {
    const { io } = setup();
    let joined = false;
    const guarded = hotspotInstallerIO(io, () => joined);
    const signal = new AbortController().signal;
    await expect(guarded.readJson(`${WLED_HOTSPOT_URL}/json/info`, signal)).rejects.toMatchObject({
      code: 'unavailable',
    });
    await expect(guarded.checkUpdateAccess(WLED_HOTSPOT_URL, signal)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(guarded.upload(WLED_HOTSPOT_URL, 'file:///fw.bin', signal, vi.fn())).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(io.readJson).not.toHaveBeenCalled();
    expect(io.upload).not.toHaveBeenCalled();
    // The manifest is internet work and is never gated on the hotspot.
    await guarded.readJson(WLED_RELEASE_MANIFEST_URL, signal);
    expect(io.readJson).toHaveBeenCalledWith(WLED_RELEASE_MANIFEST_URL, signal);
    joined = true;
    vi.mocked(io.readJson).mockResolvedValueOnce(original);
    await expect(guarded.readJson(`${WLED_HOTSPOT_URL}/json/info`, signal)).resolves.toEqual(original);
  });
});
