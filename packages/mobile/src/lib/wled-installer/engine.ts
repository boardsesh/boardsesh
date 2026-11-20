import { normalizeLocalControllerUrl } from '@boardsesh/led-controller';

export const WLED_RELEASE_MANIFEST_URL =
  'https://raw.githubusercontent.com/boardsesh/wled-usermod-ble-json/main/release-manifest.json';
export const WLED_APP_SLOT_BYTES = 1_572_864;
/** WLED's own access point always serves the controller here. It is not a LAN address. */
export const WLED_HOTSPOT_URL = 'http://4.3.2.1';
export type JsonObject = Record<string, unknown>;
export type ControllerIdentity = {
  controllerId: string;
  name: string;
  version: string;
  architecture: string;
  flashBytes: number;
  brand: string;
  product: string;
  ledCount: number;
  capabilities: JsonObject | null;
};
export type FirmwareRelease = {
  id: string;
  hardwareModel: 'GL-C-015WL-D';
  architecture: 'esp32';
  flashBytes: 4_194_304;
  sourceProfiles: { version: string; brand: string; product: string; appSlotBytes: number }[];
  wledVersion: string;
  usermodVersion: string;
  protocolVersion: 1;
  buildId: string;
  audio: boolean;
  imageBytes: number;
  appSlotBytes: number;
  url: string;
  sha256: string;
  qualified: boolean;
  channel?: 'stable' | 'beta';
};
export type Backup = { uri: string; config: JsonObject; presets: JsonObject };
export type InstallJournal = {
  url: string;
  before: ControllerIdentity;
  backup: Backup;
  release: FirmwareRelease;
};
export type InstallerStage =
  | 'idle'
  | 'inspecting'
  | 'blocked'
  | 'backingUp'
  | 'ready'
  | 'downloading'
  | 'connecting'
  | 'uploading'
  | 'rebooting'
  | 'verifying'
  | 'complete'
  | 'interrupted'
  | 'failed';
export type InstallerError =
  | 'unavailable'
  | 'locked'
  | 'incompatible'
  | 'checksum'
  | 'imageSize'
  | 'preservation'
  | 'verification'
  | 'cancelled'
  | 'hotspotNotFound'
  | 'hotspotDenied'
  | 'hotspotTimeout'
  | 'hotspotPassword'
  | 'hotspotUnsupported'
  | 'hotspotLost';
export type InstallerSnapshot = {
  stage: InstallerStage;
  identity?: ControllerIdentity;
  release?: FirmwareRelease;
  backup?: Backup;
  progress?: number | null;
  error?: InstallerError;
};
export interface InstallerIO {
  readJson(this: void, url: string, signal: AbortSignal): Promise<unknown>;
  checkUpdateAccess(this: void, url: string, signal: AbortSignal): Promise<void>;
  saveBackup(this: void, identity: ControllerIdentity, config: JsonObject, presets: JsonObject): Promise<string>;
  exportBackup(this: void, uri: string): Promise<void>;
  download(
    this: void,
    release: FirmwareRelease,
    signal: AbortSignal,
  ): Promise<{ uri: string; bytes: number; sha256: string }>;
  upload(
    this: void,
    url: string,
    uri: string,
    signal: AbortSignal,
    progress: (fraction: number | null) => void,
  ): Promise<void>;
  readJournal(this: void, url: string): Promise<InstallJournal | null>;
  writeJournal(this: void, journal: InstallJournal): Promise<void>;
  clearJournal(this: void, url: string): Promise<void>;
  awake(this: void, enabled: boolean): Promise<void>;
  wait(this: void, milliseconds: number, signal: AbortSignal): Promise<void>;
}
/**
 * The phone's route to a controller that is not on the phone's network: the
 * controller's own hotspot. Hotspot mode makes every controller request while joined.
 */
export interface ControllerLink {
  /** Asks the OS to join the hotspot. Throws a `hotspot*` WledInstallerError. */
  join(this: void, signal: AbortSignal): Promise<void>;
  /** A no-op while joined. Rejoins after the hotspot dropped, e.g. while WLED restarts. */
  ensure(this: void, signal: AbortSignal): Promise<void>;
  /** Leaves the hotspot and restores normal routing. Idempotent. */
  release(this: void): Promise<void>;
}
/**
 * The installer's controller address: a LAN address a wall may store, or WLED's
 * fixed hotspot address, which is reachable only while joined to the hotspot.
 */
export function installerControllerUrl(url: string): string {
  return url === WLED_HOTSPOT_URL ? WLED_HOTSPOT_URL : normalizeLocalControllerUrl(url);
}
export function isHotspotError(code: InstallerError | undefined): boolean {
  return code?.startsWith('hotspot') ?? false;
}
export class WledInstallerError extends Error {
  constructor(public readonly code: InstallerError) {
    super(code);
  }
}
export function isObject(candidate: unknown): candidate is JsonObject {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}
function requireObject(candidate: unknown): JsonObject {
  if (!isObject(candidate)) throw new WledInstallerError('unavailable');
  return candidate;
}
export function readIdentity(candidate: unknown): ControllerIdentity {
  const info = requireObject(candidate);
  const leds = requireObject(info.leds);
  if (
    typeof info.mac !== 'string' ||
    !/^[a-f0-9]{12}$/i.test(info.mac) ||
    typeof info.name !== 'string' ||
    typeof info.ver !== 'string' ||
    typeof info.arch !== 'string' ||
    typeof info.flash !== 'number' ||
    !Number.isSafeInteger(info.flash) ||
    info.flash <= 0 ||
    typeof info.brand !== 'string' ||
    typeof info.product !== 'string' ||
    typeof leds.count !== 'number' ||
    !Number.isSafeInteger(leds.count) ||
    leds.count <= 0
  ) {
    throw new WledInstallerError('incompatible');
  }
  return {
    controllerId: `wled-${info.mac.toLowerCase()}`,
    name: info.name,
    version: info.ver,
    architecture: info.arch.toLowerCase(),
    flashBytes: info.flash * 1_048_576,
    brand: info.brand,
    product: info.product,
    ledCount: leds.count,
    capabilities: isObject(info.bleJson) ? info.bleJson : null,
  };
}
export function readManifest(candidate: unknown): FirmwareRelease[] {
  const manifest = requireObject(candidate);
  if (manifest.manifestVersion !== 1 || !Array.isArray(manifest.releases)) throw new WledInstallerError('incompatible');
  return manifest.releases.map((entry: unknown) => {
    const release = requireObject(entry);
    if (
      typeof release.id !== 'string' ||
      !release.id ||
      release.hardwareModel !== 'GL-C-015WL-D' ||
      release.architecture !== 'esp32' ||
      release.flashBytes !== 4_194_304 ||
      !(
        (release.qualified === true && (release.channel === undefined || release.channel === 'stable')) ||
        (release.qualified === false && release.channel === 'beta')
      ) ||
      release.protocolVersion !== 1 ||
      typeof release.audio !== 'boolean' ||
      typeof release.wledVersion !== 'string' ||
      typeof release.usermodVersion !== 'string' ||
      typeof release.buildId !== 'string' ||
      !release.buildId ||
      typeof release.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(release.sha256) ||
      typeof release.url !== 'string' ||
      !release.url.startsWith('https://') ||
      typeof release.imageBytes !== 'number' ||
      !Number.isSafeInteger(release.imageBytes) ||
      release.imageBytes <= 0 ||
      release.appSlotBytes !== WLED_APP_SLOT_BYTES ||
      release.imageBytes > WLED_APP_SLOT_BYTES ||
      !Array.isArray(release.sourceProfiles) ||
      release.sourceProfiles.length === 0 ||
      !release.sourceProfiles.every(
        (profile: unknown) =>
          isObject(profile) &&
          typeof profile.version === 'string' &&
          typeof profile.brand === 'string' &&
          typeof profile.product === 'string' &&
          profile.appSlotBytes === WLED_APP_SLOT_BYTES,
      )
    ) {
      throw new WledInstallerError('incompatible');
    }
    const assetUrl = new URL(release.url);
    if (assetUrl.protocol !== 'https:' || assetUrl.username || assetUrl.password)
      throw new WledInstallerError('incompatible');
    return { ...release, channel: release.channel ?? 'stable' } as FirmwareRelease;
  });
}
export function compatibleReleases(identity: ControllerIdentity, manifest: FirmwareRelease[]): FirmwareRelease[] {
  return manifest.filter(
    (release) =>
      release.architecture === identity.architecture &&
      release.flashBytes === identity.flashBytes &&
      release.sourceProfiles.some(
        (profile) =>
          profile.version === identity.version &&
          profile.brand === identity.brand &&
          profile.product === identity.product,
      ),
  );
}
function preferredRelease(releases: FirmwareRelease[]): FirmwareRelease | undefined {
  return (
    releases.find((release) => release.audio && release.qualified) ??
    releases.find((release) => release.audio) ??
    releases.find((release) => release.qualified) ??
    releases[0]
  );
}
function canonical(candidate: unknown): string {
  if (Array.isArray(candidate)) return `[${candidate.map(canonical).join(',')}]`;
  if (isObject(candidate))
    return `{${Object.keys(candidate)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(candidate[key])}`)
      .join(',')}}`;
  return JSON.stringify(candidate) ?? 'null';
}
/** The new module may add its own defaults. All owner settings and presets remain authoritative. */
export function settingsPreserved(before: Backup, config: JsonObject, presets: JsonObject): boolean {
  const hadBleSettings = isObject(before.config.um) && Object.hasOwn(before.config.um, 'BLE JSON');
  const withoutNewBleDefaults = (document: JsonObject) => {
    const copy = { ...document };
    delete copy.rev;
    if (!hadBleSettings && isObject(copy.um)) {
      const usermods = { ...copy.um };
      delete usermods['BLE JSON'];
      if (Object.keys(usermods).length === 0 && !Object.hasOwn(before.config, 'um')) delete copy.um;
      else copy.um = usermods;
    }
    return copy;
  };
  return (
    canonical(withoutNewBleDefaults(before.config)) === canonical(withoutNewBleDefaults(config)) &&
    canonical(before.presets) === canonical(presets)
  );
}

type PreparedImage = { uri: string; bytes: number; sha256: string };
function checkImage(release: FirmwareRelease, image: PreparedImage) {
  if (image.bytes !== release.imageBytes || image.bytes > WLED_APP_SLOT_BYTES)
    throw new WledInstallerError('imageSize');
  if (image.sha256.toLowerCase() !== release.sha256) throw new WledInstallerError('checksum');
}

/** One owner-initiated session on the controller's local address. A journal is durable before the first upload byte. */
export function createWledInstaller(rawUrl: string, io: InstallerIO, publish: (snapshot: InstallerSnapshot) => void) {
  return createSession(normalizeLocalControllerUrl(rawUrl), io, publish, null);
}

/**
 * One owner-initiated session over the controller's own hotspot (WLED-AP), for
 * a wall with no Wi-Fi. The hotspot has no internet, so the manifest and every
 * firmware image the owner may install are downloaded and verified first, on
 * whatever internet the phone has. Only then does the phone join the hotspot.
 * The link is released whenever the session stops needing it: after install,
 * verification, any failure, and cancel. It stays joined only from a ready
 * backup to the owner's install tap.
 */
export function createWledHotspotInstaller(
  io: InstallerIO,
  link: ControllerLink,
  publish: (snapshot: InstallerSnapshot) => void,
) {
  return createSession(WLED_HOTSPOT_URL, io, publish, link);
}

function createSession(
  url: string,
  io: InstallerIO,
  publish: (snapshot: InstallerSnapshot) => void,
  link: ControllerLink | null,
) {
  let snapshot: InstallerSnapshot = { stage: 'idle' };
  let running = false;
  let controller: AbortController | null = null;
  let releases: FirmwareRelease[] = [];
  let journal: InstallJournal | null = null;
  // Hotspot mode only: fetched before joining, while the phone has internet.
  let offlineManifest: FirmwareRelease[] | null = null;
  const offlineImages = new Map<string, PreparedImage>();
  const update = (next: InstallerSnapshot) => {
    snapshot = next;
    publish(next);
  };
  const ensureCurrent = (signal: AbortSignal) => {
    if (signal.aborted) throw new WledInstallerError('cancelled');
  };
  const releaseLink = async () => {
    await link?.release().catch(() => undefined);
  };
  /** An operation resolving 'keepLink' leaves the hotspot joined for the owner's next step. */
  async function exclusive(operation: (signal: AbortSignal) => Promise<'keepLink' | void>) {
    if (running) return;
    running = true;
    const session = new AbortController();
    controller = session;
    let keepLink = false;
    try {
      keepLink = (await operation(session.signal)) === 'keepLink';
    } catch (error) {
      update({
        ...snapshot,
        stage: journal
          ? 'interrupted'
          : error instanceof WledInstallerError && error.code === 'locked'
            ? 'blocked'
            : 'failed',
        error: error instanceof WledInstallerError ? error.code : 'unavailable',
      });
    } finally {
      running = false;
      controller = null;
      if (!keepLink || session.signal.aborted) await releaseLink();
      await io.awake(false).catch(() => undefined);
    }
  }
  async function compatibleWith(identity: ControllerIdentity, signal: AbortSignal) {
    const manifest = offlineManifest ?? readManifest(await io.readJson(WLED_RELEASE_MANIFEST_URL, signal));
    return compatibleReleases(identity, manifest);
  }
  /** Hotspot mode: everything that needs the internet happens before the join. */
  async function prepareOffline(signal: AbortSignal, betaConfirmed: boolean) {
    update({ stage: 'downloading' });
    const manifest = readManifest(await io.readJson(WLED_RELEASE_MANIFEST_URL, signal));
    ensureCurrent(signal);
    for (const release of manifest) {
      // Beta firmware is never downloaded before the owner's beta consent.
      if (offlineImages.has(release.sha256) || (release.channel === 'beta' && !betaConfirmed)) continue;
      const image = await io.download(release, signal);
      ensureCurrent(signal);
      checkImage(release, image);
      offlineImages.set(release.sha256, image);
    }
    offlineManifest = manifest.filter((release) => offlineImages.has(release.sha256));
  }
  async function verify(signal: AbortSignal, allowSourceRecovery = false) {
    if (!journal) throw new WledInstallerError('verification');
    const pending = journal;
    update({ ...snapshot, stage: 'rebooting' });
    for (let attempt = 0; attempt < 45; attempt++) {
      ensureCurrent(signal);
      try {
        // WLED's hotspot goes down while it restarts. Rejoin before reading.
        if (link) await link.ensure(signal);
        const identity = readIdentity(await io.readJson(`${url}/json/info`, signal));
        if (identity.controllerId !== pending.before.controllerId) throw new WledInstallerError('verification');
        const caps = identity.capabilities;
        if (
          identity.version === pending.release.wledVersion &&
          caps?.buildId === pending.release.buildId &&
          caps.controllerId === identity.controllerId &&
          caps.protocolVersion === 1 &&
          caps.usermodVersion === pending.release.usermodVersion &&
          caps.audio === pending.release.audio &&
          caps.ledCount === pending.before.ledCount &&
          caps.maxMessageBytes === 8192
        ) {
          update({ ...snapshot, stage: 'verifying' });
          const [config, presets] = await Promise.all([
            io.readJson(`${url}/cfg.json`, signal),
            io.readJson(`${url}/presets.json`, signal),
          ]);
          ensureCurrent(signal);
          if (
            identity.ledCount !== pending.before.ledCount ||
            !settingsPreserved(pending.backup, requireObject(config), requireObject(presets))
          ) {
            throw new WledInstallerError('preservation');
          }
          await io.clearJournal(url);
          journal = null;
          update({ ...snapshot, stage: 'complete', identity, error: undefined });
          return;
        }
      } catch (error) {
        if (
          error instanceof WledInstallerError &&
          (['preservation', 'verification'].includes(error.code) || isHotspotError(error.code))
        )
          throw error;
      }
      await io.wait(2000, signal);
    }
    if (allowSourceRecovery) {
      // An explicit inspection after an interrupted upload may prove the original firmware still runs.
      if (link) await link.ensure(signal);
      const identity = readIdentity(await io.readJson(`${url}/json/info`, signal));
      const original = pending.before;
      if (
        identity.controllerId === original.controllerId &&
        identity.version === original.version &&
        identity.architecture === original.architecture &&
        identity.flashBytes === original.flashBytes &&
        identity.brand === original.brand &&
        identity.product === original.product &&
        identity.capabilities?.buildId !== pending.release.buildId
      ) {
        const [config, presets] = await Promise.all([
          io.readJson(`${url}/cfg.json`, signal),
          io.readJson(`${url}/presets.json`, signal),
        ]);
        ensureCurrent(signal);
        if (!settingsPreserved(pending.backup, requireObject(config), requireObject(presets)))
          throw new WledInstallerError('preservation');
        await io.checkUpdateAccess(url, signal);
        releases = await compatibleWith(identity, signal);
        ensureCurrent(signal);
        await io.clearJournal(url);
        journal = null;
        update({
          stage: 'ready',
          identity,
          backup: pending.backup,
          release: preferredRelease(releases),
        });
        return;
      }
    }
    throw new WledInstallerError('verification');
  }
  const cancel = () => {
    controller?.abort();
    // Idle at a ready backup, nothing else would release the hotspot.
    if (!running) void releaseLink();
  };
  return {
    getSnapshot: () => snapshot,
    cancel,
    /** Stops any work and leaves the hotspot: unmount, backgrounding, sign-out. */
    release: cancel,
    /** `betaConfirmed` only matters in hotspot mode, where downloading comes first. */
    inspect: (betaConfirmed = false) =>
      exclusive(async (signal) => {
        if (link) {
          // A repeated check starts from the phone's own internet, not the hotspot.
          await releaseLink();
          await prepareOffline(signal, betaConfirmed);
          update({ stage: 'connecting' });
          await link.join(signal);
          ensureCurrent(signal);
        }
        update({ stage: 'inspecting' });
        const identity = readIdentity(await io.readJson(`${url}/json/info`, signal));
        ensureCurrent(signal);
        journal = await io.readJournal(url);
        if (journal) {
          if (journal.before.controllerId !== identity.controllerId) throw new WledInstallerError('verification');
          update({ stage: 'interrupted', identity, backup: journal.backup, release: journal.release });
          return;
        }
        await io.checkUpdateAccess(url, signal);
        releases = await compatibleWith(identity, signal);
        ensureCurrent(signal);
        update({ stage: 'backingUp', identity });
        const [config, presets] = await Promise.all([
          io.readJson(`${url}/cfg.json`, signal),
          io.readJson(`${url}/presets.json`, signal),
        ]);
        ensureCurrent(signal);
        const backup = { config: requireObject(config), presets: requireObject(presets), uri: '' };
        backup.uri = await io.saveBackup(identity, backup.config, backup.presets);
        ensureCurrent(signal);
        const release = preferredRelease(releases);
        update({ stage: 'ready', identity, backup, release });
        return release ? 'keepLink' : undefined;
      }),
    exportBackup: async () => {
      if (snapshot.backup) await io.exportBackup(snapshot.backup.uri);
    },
    install: (modelConfirmed: boolean, audioDisabledConfirmed: boolean, betaConfirmed = false) =>
      exclusive(async (signal) => {
        const { identity, backup, release } = snapshot;
        if (
          snapshot.stage !== 'ready' ||
          !modelConfirmed ||
          !identity ||
          !backup ||
          !release ||
          (!release.audio && !audioDisabledConfirmed) ||
          (release.channel === 'beta' && !betaConfirmed) ||
          !releases.includes(release)
        )
          throw new WledInstallerError('incompatible');
        await io.awake(true);
        if (link) {
          // The owner may have left the app since the backup; rejoin if so.
          update({ ...snapshot, stage: 'connecting' });
          await link.ensure(signal);
        }
        const currentIdentity = readIdentity(await io.readJson(`${url}/json/info`, signal));
        if (currentIdentity.controllerId !== identity.controllerId || currentIdentity.version !== identity.version)
          throw new WledInstallerError('verification');
        await io.checkUpdateAccess(url, signal);
        let image: PreparedImage;
        if (link) {
          const prepared = offlineImages.get(release.sha256);
          if (!prepared) throw new WledInstallerError('unavailable');
          image = prepared;
        } else {
          update({ ...snapshot, stage: 'downloading' });
          image = await io.download(release, signal);
        }
        ensureCurrent(signal);
        checkImage(release, image);
        journal = { url, before: identity, backup, release };
        await io.writeJournal(journal);
        ensureCurrent(signal);
        update({ ...snapshot, stage: 'uploading', progress: 0 });
        try {
          await io.upload(url, image.uri, signal, (progress) => update({ ...snapshot, progress }));
        } catch (error) {
          ensureCurrent(signal);
          if (error instanceof WledInstallerError && error.code === 'locked') throw error;
          // A disconnect is ambiguous. Only read-back can establish success.
        }
        ensureCurrent(signal);
        await verify(signal);
      }),
    verify: () =>
      exclusive(async (signal) => {
        await io.awake(true);
        if (link) {
          update({ ...snapshot, stage: 'connecting' });
          await link.ensure(signal);
        }
        await verify(signal, true);
      }),
  };
}
