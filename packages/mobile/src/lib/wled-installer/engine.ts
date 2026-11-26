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
/**
 * A settings change measured for one source firmware, so the read-back check can expect it.
 * `removed`: the key is gone afterwards (present with another value still fails).
 * `changed`: any value afterwards. `feature`: the integration the build leaves out.
 */
export type SettingsChange = { path: string; kind: 'removed' | 'changed'; feature?: string };
export type SourceProfile = {
  version: string;
  brand: string;
  product: string;
  appSlotBytes: number;
  settingsChanges?: SettingsChange[];
};
export type FirmwareRelease = {
  id: string;
  hardwareModel: 'GL-C-015WL-D';
  architecture: 'esp32';
  flashBytes: 4_194_304;
  sourceProfiles: SourceProfile[];
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
  /** Settings the installer itself wrote before the upload (controller name, update network check). */
  changes?: JsonObject;
  /** The installer switched off WLED's "Only allow update from same network/WiFi" and turns it back on. */
  restoreSameSubnet?: boolean;
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
  /** Dotted paths of the settings that differed, when the read-back check failed. */
  differences?: string[];
};
export interface InstallerIO {
  readJson(this: void, url: string, signal: AbortSignal): Promise<unknown>;
  checkUpdateAccess(this: void, url: string, signal: AbortSignal): Promise<void>;
  /** Merges settings through WLED's /json/cfg. Throws `locked` when a settings PIN refuses it. */
  writeConfig(this: void, url: string, changes: JsonObject, signal: AbortSignal): Promise<void>;
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
          profile.appSlotBytes === WLED_APP_SLOT_BYTES &&
          (profile.settingsChanges === undefined || validSettingsChanges(profile.settingsChanges)),
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
/**
 * Settings no manifest may excuse: what a wall needs to light and to be reached (the doc's
 * preservation rules). A waiver equal to, inside or above one of these makes the release unusable.
 */
export const PROTECTED_SETTINGS = [
  'hw.led.ins',
  'hw.led.total',
  'hw.led.maxpwr',
  'hw.relay',
  'hw.btn.ins',
  'hw.btn.pull',
  'nw.ins',
  'ap',
  'wifi',
  'id.name',
  'id.mdns',
  'um.AudioReactive',
  'um.BLE JSON',
  'def',
  'light.gc',
];
const SETTING_PATH = /^[A-Za-z0-9_-]+( [A-Za-z0-9_-]+)*(\.[A-Za-z0-9_-]+( [A-Za-z0-9_-]+)*)*$/;
function overlaps(path: string, protectedPath: string) {
  return path === protectedPath || path.startsWith(`${protectedPath}.`) || protectedPath.startsWith(`${path}.`);
}
function validSettingsChanges(candidate: unknown): boolean {
  return (
    Array.isArray(candidate) &&
    candidate.every(
      (change: unknown) =>
        isObject(change) &&
        typeof change.path === 'string' &&
        SETTING_PATH.test(change.path) &&
        (change.kind === 'removed' || change.kind === 'changed') &&
        (change.feature === undefined || (typeof change.feature === 'string' && change.feature.length > 0)) &&
        !PROTECTED_SETTINGS.some((protectedPath) => overlaps(change.path as string, protectedPath)),
    )
  );
}
function matchesProfile(profile: SourceProfile, identity: ControllerIdentity) {
  return (
    profile.version === identity.version && profile.brand === identity.brand && profile.product === identity.product
  );
}
/** The measured source firmware a release was qualified from, for the controller as it was. */
export function sourceProfileFor(release: FirmwareRelease, identity: ControllerIdentity): SourceProfile | undefined {
  return release.sourceProfiles.find((profile) => matchesProfile(profile, identity));
}
export function compatibleReleases(identity: ControllerIdentity, manifest: FirmwareRelease[]): FirmwareRelease[] {
  return manifest.filter(
    (release) =>
      release.architecture === identity.architecture &&
      release.flashBytes === identity.flashBytes &&
      release.sourceProfiles.some((profile) => matchesProfile(profile, identity)),
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
/** `base` with `changes` merged in, objects recursively. Arrays and values in `changes` replace. */
export function mergeSettings(base: JsonObject, changes: JsonObject): JsonObject {
  const merged: JsonObject = { ...base };
  for (const [key, value] of Object.entries(changes)) {
    merged[key] = isObject(value) && isObject(base[key]) ? mergeSettings(base[key], value) : value;
  }
  return merged;
}
/**
 * Collects the paths where `after` lost or changed a setting of `before`. Keys only in `after` are
 * allowed: WLED 16 writes its full settings format the first time it saves, adding keys an older
 * file lacked. Arrays keep their length and order.
 */
function collectDifferences(before: unknown, after: unknown, path: string, found: string[]) {
  if (Array.isArray(before)) {
    if (!Array.isArray(after) || before.length !== after.length) found.push(path);
    else before.forEach((item, index) => collectDifferences(item, after[index], `${path}[${index}]`, found));
  } else if (isObject(before)) {
    if (!isObject(after)) found.push(path);
    else
      for (const key of Object.keys(before))
        collectDifferences(before[key], after[key], path ? `${path}.${key}` : key, found);
  } else if (canonical(before) !== canonical(after)) found.push(path);
}
function settingAt(document: JsonObject, segments: string[]): { found: boolean; value?: unknown } {
  let current: unknown = document;
  for (const segment of segments) {
    if (!isObject(current) || !Object.hasOwn(current, segment)) return { found: false };
    current = current[segment];
  }
  return { found: true, value: current };
}
function withoutSetting(document: JsonObject, segments: string[]): JsonObject {
  const [head, ...rest] = segments;
  if (!Object.hasOwn(document, head)) return document;
  const copy = { ...document };
  if (rest.length === 0) delete copy[head];
  else if (isObject(copy[head])) copy[head] = withoutSetting(copy[head], rest);
  return copy;
}
/** A button slot WLED keeps for nothing: no type and no pin. WLED 16 stops saving those. */
function isUnusedButton(button: unknown) {
  if (!isObject(button) || button.type !== 0) return false;
  const pins = Array.isArray(button.pin) ? button.pin : [button.pin];
  return pins.every((pin) => pin === -1);
}
/** Differences no owner made and no measurement is needed for, fixed here rather than in a manifest. */
function normalised(document: JsonObject): JsonObject {
  const copy = { ...document };
  delete copy.rev;
  if (isObject(copy.wifi)) {
    // The add-on keeps modem sleep on while Bluetooth runs.
    const wifi = { ...copy.wifi };
    delete wifi.sleep;
    copy.wifi = wifi;
  }
  if (isObject(copy.hw) && isObject(copy.hw.btn) && Array.isArray(copy.hw.btn.ins)) {
    copy.hw = { ...copy.hw, btn: { ...copy.hw.btn, ins: copy.hw.btn.ins.filter((button) => !isUnusedButton(button)) } };
  }
  return copy;
}
/**
 * Settings the controller lost or changed, as dotted paths (`presets` for the presets file). Allowed:
 * keys WLED adds when it rewrites the file, `rev`, Wi-Fi sleep, unused button slots, a button count
 * that only grows, `changes` the installer wrote itself, and the source profile's measured
 * `settingsChanges`, which can never cover a protected setting.
 */
export function settingsDifferences(
  before: Backup,
  config: JsonObject,
  presets: JsonObject,
  changes: JsonObject = {},
  settingsChanges: SettingsChange[] = [],
): string[] {
  let expected = normalised(mergeSettings(before.config, changes));
  let actual = normalised(config);
  const found: string[] = [];
  const buttonCount = settingAt(expected, ['hw', 'btn', 'max']);
  const newButtonCount = settingAt(actual, ['hw', 'btn', 'max']);
  if (
    typeof buttonCount.value === 'number' &&
    typeof newButtonCount.value === 'number' &&
    newButtonCount.value >= buttonCount.value
  ) {
    expected = withoutSetting(expected, ['hw', 'btn', 'max']);
    actual = withoutSetting(actual, ['hw', 'btn', 'max']);
  }
  for (const change of settingsChanges) {
    if (PROTECTED_SETTINGS.some((protectedPath) => overlaps(change.path, protectedPath))) continue;
    const segments = change.path.split('.');
    const was = settingAt(expected, segments);
    if (!was.found) continue;
    const now = settingAt(actual, segments);
    if (change.kind === 'removed' && now.found && canonical(now.value) !== canonical(was.value))
      found.push(change.path);
    expected = withoutSetting(expected, segments);
    actual = withoutSetting(actual, segments);
  }
  collectDifferences(expected, actual, '', found);
  if (canonical(before.presets) !== canonical(presets)) found.push('presets');
  return found;
}
export function settingsPreserved(
  before: Backup,
  config: JsonObject,
  presets: JsonObject,
  changes: JsonObject = {},
  settingsChanges: SettingsChange[] = [],
): boolean {
  return settingsDifferences(before, config, presets, changes, settingsChanges).length === 0;
}
/** App-coded test of whether a dropped integration was in use, by the manifest's `feature` name. */
const FEATURE_IN_USE: Record<string, (config: JsonObject) => boolean> = {
  mqtt: (config) => settingAt(config, ['if', 'mqtt', 'en']).value === true,
  hue: (config) => settingAt(config, ['if', 'hue', 'en']).value === true,
  alexa: (config) => settingAt(config, ['if', 'va', 'alexa']).value === true,
  ir: (config) => {
    const pin = settingAt(config, ['hw', 'ir', 'pin']).value;
    return typeof pin === 'number' && pin >= 0;
  },
  espnow: (config) =>
    settingAt(config, ['nw', 'espnow']).value === true || settingAt(config, ['if', 'sync', 'espnow']).value === true,
};
/** Integrations the new firmware leaves out that the owner had on. An unknown feature counts as on. */
export function droppedFeaturesInUse(config: JsonObject, profile: SourceProfile | undefined): string[] {
  const features = new Set<string>();
  for (const change of profile?.settingsChanges ?? []) {
    if (!change.feature) continue;
    const inUse = FEATURE_IN_USE[change.feature];
    if (!inUse || inUse(config)) features.add(change.feature);
  }
  return [...features];
}
/** Bytes WLED's device name may use in the add-on's advertised `<name>#<serial>`. */
export const CONTROLLER_NAME_BYTES = 22;
/**
 * The name the add-on will advertise, as the add-on itself trims it: whole characters within
 * 22 UTF-8 bytes, without `#` and `@` (they delimit the serial) or control characters.
 */
export function controllerName(raw: string): string {
  const encoder = new TextEncoder();
  let name = '';
  // eslint-disable-next-line no-control-regex -- control characters are what this removes
  for (const character of raw.replace(/[#@\u0000-\u001f\u007f]/g, '').trim()) {
    if (encoder.encode(name + character).length > CONTROLLER_NAME_BYTES) break;
    name += character;
  }
  return name.trim();
}
/**
 * WLED 16 refuses an update from a phone on its own hotspot while "Only allow update from same
 * network/WiFi" is on: it compares the phone with its station address, which is empty when it only
 * runs the hotspot. The option is on by default in 16 and absent before it.
 */
export function blocksHotspotUpdate(config: JsonObject, version: string): boolean {
  const sameSubnet = isObject(config.ota) ? config.ota['same-subnet'] : undefined;
  if (typeof sameSubnet === 'boolean') return sameSubnet;
  return Number.parseInt(version, 10) >= 16;
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
  async function readSettings(signal: AbortSignal) {
    const [config, presets] = await Promise.all([
      io.readJson(`${url}/cfg.json`, signal),
      io.readJson(`${url}/presets.json`, signal),
    ]);
    ensureCurrent(signal);
    return { config: requireObject(config), presets: requireObject(presets) };
  }
  /** Puts the owner's update protection back. Best effort: a failure must not hide a good install. */
  async function restoreSameSubnet(pending: InstallJournal, signal: AbortSignal) {
    if (!pending.restoreSameSubnet) return;
    for (let attempt = 0; attempt < 2 && !signal.aborted; attempt++) {
      try {
        await io.writeConfig(url, { ota: { 'same-subnet': true } }, signal);
        return;
      } catch {
        // Retried once; WLED answers again after its settings write.
      }
    }
  }
  /** Against the backup, the installer's own writes and what the source firmware was measured to change. */
  function differencesFor(pending: InstallJournal, config: JsonObject, presets: JsonObject) {
    const profile = sourceProfileFor(pending.release, pending.before);
    return settingsDifferences(pending.backup, config, presets, pending.changes, profile?.settingsChanges);
  }
  function isInstalled(identity: ControllerIdentity, pending: InstallJournal) {
    const caps = identity.capabilities;
    return (
      identity.version === pending.release.wledVersion &&
      caps?.buildId === pending.release.buildId &&
      caps.controllerId === identity.controllerId &&
      caps.protocolVersion === 1 &&
      caps.usermodVersion === pending.release.usermodVersion &&
      caps.audio === pending.release.audio &&
      caps.ledCount === pending.before.ledCount &&
      caps.maxMessageBytes === 8192
    );
  }
  function isOriginalFirmware(identity: ControllerIdentity, pending: InstallJournal) {
    const original = pending.before;
    return (
      identity.controllerId === original.controllerId &&
      identity.version === original.version &&
      identity.architecture === original.architecture &&
      identity.flashBytes === original.flashBytes &&
      identity.brand === original.brand &&
      identity.product === original.product &&
      identity.capabilities?.buildId !== pending.release.buildId
    );
  }
  async function verify(signal: AbortSignal, allowSourceRecovery = false) {
    if (!journal) throw new WledInstallerError('verification');
    const pending = journal;
    // An owner's check is not a restart, and no earlier error carries into it.
    update({
      ...snapshot,
      stage: allowSourceRecovery ? 'verifying' : 'rebooting',
      error: undefined,
      differences: undefined,
    });
    let originalFirmware: ControllerIdentity | null = null;
    for (let attempt = 0; attempt < 45; attempt++) {
      ensureCurrent(signal);
      try {
        // WLED's hotspot goes down while it restarts. Rejoin before reading.
        if (link) await link.ensure(signal);
        const identity = readIdentity(await io.readJson(`${url}/json/info`, signal));
        if (identity.controllerId !== pending.before.controllerId) throw new WledInstallerError('verification');
        if (isInstalled(identity, pending)) {
          update({ ...snapshot, stage: 'verifying' });
          const { config, presets } = await readSettings(signal);
          const differences = differencesFor(pending, config, presets);
          if (identity.ledCount !== pending.before.ledCount) differences.push('leds.count');
          if (differences.length) {
            update({ ...snapshot, differences });
            throw new WledInstallerError('preservation');
          }
          await restoreSameSubnet(pending, signal);
          await io.clearJournal(url);
          journal = null;
          update({ ...snapshot, stage: 'complete', identity, error: undefined });
          return;
        }
        // An owner's check after an interrupted upload: the original firmware answering is the result.
        if (allowSourceRecovery && isOriginalFirmware(identity, pending)) {
          originalFirmware = identity;
          break;
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
      if (!originalFirmware) {
        if (link) await link.ensure(signal);
        const identity = readIdentity(await io.readJson(`${url}/json/info`, signal));
        if (isOriginalFirmware(identity, pending)) originalFirmware = identity;
      }
      if (originalFirmware) {
        const { config, presets } = await readSettings(signal);
        const differences = differencesFor(pending, config, presets);
        if (differences.length) {
          update({ ...snapshot, differences });
          throw new WledInstallerError('preservation');
        }
        await restoreSameSubnet(pending, signal);
        // The controller kept the owner's settings; what it holds now is the next attempt's baseline.
        const current = await readSettings(signal);
        const backup = { ...current, uri: await io.saveBackup(originalFirmware, current.config, current.presets) };
        await io.checkUpdateAccess(url, signal);
        releases = await compatibleWith(originalFirmware, signal);
        ensureCurrent(signal);
        await io.clearJournal(url);
        journal = null;
        update({ stage: 'ready', identity: originalFirmware, backup, release: preferredRelease(releases) });
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
    /**
     * `name`: what the controller should advertise to climbers; trimmed as the add-on trims it.
     * `droppedFeaturesConfirmed`: the owner accepted losing integrations they use that the build leaves out.
     */
    install: (
      modelConfirmed: boolean,
      audioDisabledConfirmed: boolean,
      betaConfirmed = false,
      name?: string,
      droppedFeaturesConfirmed = false,
    ) =>
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
          !releases.includes(release) ||
          (droppedFeaturesInUse(backup.config, sourceProfileFor(release, identity)).length > 0 &&
            !droppedFeaturesConfirmed)
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
        const changes: JsonObject = {};
        const advertised = name === undefined ? '' : controllerName(name);
        if (advertised) changes.id = { name: advertised };
        const disablesSameSubnet = link !== null && blocksHotspotUpdate(backup.config, identity.version);
        if (disablesSameSubnet) changes.ota = { 'same-subnet': false };
        // Durable before any controller write, so a lost connection still restores the setting.
        journal = { url, before: identity, backup, release, changes, restoreSameSubnet: disablesSameSubnet };
        await io.writeJournal(journal);
        ensureCurrent(signal);
        // Nothing has been uploaded yet: a refusal here leaves no install to confirm.
        const abandon = async (error: unknown): Promise<never> => {
          const abandoned = journal;
          journal = null;
          if (abandoned) await restoreSameSubnet(abandoned, signal);
          await io.clearJournal(url).catch(() => undefined);
          throw error;
        };
        if (Object.keys(changes).length) await io.writeConfig(url, changes, signal).catch(abandon);
        ensureCurrent(signal);
        update({ ...snapshot, stage: 'uploading', progress: 0 });
        try {
          await io.upload(url, image.uri, signal, (progress) => update({ ...snapshot, progress }));
        } catch (error) {
          ensureCurrent(signal);
          // WLED refuses before writing any of the image (PIN, OTA lock or "same network" check).
          if (error instanceof WledInstallerError && error.code === 'locked') await abandon(error);
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
