/**
 * How this installation is currently using Boardsesh.
 *
 * `local` is an explicit user choice, not a synonym for disconnected. A signed-in
 * climber can eventually choose it too; connectivity must never silently change
 * where their writes go.
 */
export type AccessMode = 'account' | 'local';

/** The platform boundary that decides whether a device-local profile exists. */
export type AccessPlatform = 'native' | 'web';

export type AccessContext = {
  accessMode: AccessMode;
  isAuthenticated: boolean;
  localCatalogReady: boolean;
  platform: AccessPlatform;
};

/**
 * Central capability policy for account and local-profile surfaces.
 *
 * The local write capabilities describe product permission only. Their storage
 * implementations are intentionally separate, so adding a capability here cannot
 * accidentally turn a server mutation into a local write.
 */
export type AccessCapabilities = {
  readPublicClimbs: boolean;
  chooseLocalProfile: boolean;
  enterCoreClimbingRoutes: boolean;
  configureLocalBoard: boolean;
  downloadBoardCatalog: boolean;
  logLocalAscents: boolean;
  useLocalFavorites: boolean;
  useLocalPlaylists: boolean;
  logCloudAscents: boolean;
  useAccountFeatures: boolean;
};

export const ACCOUNT_ACCESS_MODE: AccessMode = 'account';
export const LOCAL_ACCESS_MODE: AccessMode = 'local';
export const LOCAL_BOARD_SETUP_PATH = '/boards/local-setup' as const;

export function isAccessMode(value: unknown): value is AccessMode {
  return value === ACCOUNT_ACCESS_MODE || value === LOCAL_ACCESS_MODE;
}

export function resolveAccessCapabilities(context: AccessContext): AccessCapabilities {
  const localProfileActive = context.platform === 'native' && context.accessMode === LOCAL_ACCESS_MODE;
  const localClimbingReady = localProfileActive && context.localCatalogReady;
  const accountActive = context.isAuthenticated && context.accessMode === ACCOUNT_ACCESS_MODE;

  return {
    // Public climb reads retain their existing anonymous web behaviour and form
    // the native local profile's read-only foundation.
    readPublicClimbs: true,
    chooseLocalProfile: context.platform === 'native',
    enterCoreClimbingRoutes: context.isAuthenticated || localClimbingReady,
    configureLocalBoard: localProfileActive,
    downloadBoardCatalog: localProfileActive,
    logLocalAscents: localClimbingReady,
    useLocalFavorites: localClimbingReady,
    useLocalPlaylists: localClimbingReady,
    logCloudAscents: accountActive,
    useAccountFeatures: accountActive,
  };
}

/**
 * Initial default-deny route corpus for a tokenless native local profile.
 *
 * Only surfaces whose local read/control foundation exists belong here. Record,
 * profile social children, Discover social children, and board CRUD stay out until
 * their local stores land.
 * The dedicated setup route is checked separately, so today's account-backed
 * `/boards` tree never gets admitted by accident.
 */
export function isCoreClimbingRoute(segments: readonly string[]): boolean {
  if (segments.length === 1 && segments[0] === 'play') return true;
  if (segments[0] !== '(tabs)' || segments[1] !== 'climbs') return false;
  if (segments.length === 2) return true;
  if (segments.length !== 3) return false;
  return ['[climbUuid]', 'holds', 'setters', 'zone'].includes(segments[2] ?? '');
}

export function isLocalBoardSetupRoute(segments: readonly string[]): boolean {
  return segments.length === 2 && segments[0] === 'boards' && segments[1] === 'local-setup';
}

/** Local-profile You surfaces backed entirely by the device database. */
export function isLocalProfileRoute(segments: readonly string[]): boolean {
  if (segments[0] !== '(tabs)' || segments[1] !== 'profile') return false;
  return segments.length === 2 || (segments.length === 3 && segments[2] === 'more');
}

/** Exact private-playlist surfaces backed by the local-profile database. */
export function isLocalPlaylistRoute(segments: readonly string[]): boolean {
  if (segments[0] !== '(tabs)' || segments[1] !== 'discover' || segments.length !== 3) return false;
  return segments[2] === 'all' || segments[2] === '[playlist_uuid]';
}

export function canEnterRouteWithoutAccount(context: AccessContext, segments: readonly string[]): boolean {
  const capabilities = resolveAccessCapabilities(context);
  if (isLocalBoardSetupRoute(segments)) return capabilities.configureLocalBoard;
  return (
    capabilities.enterCoreClimbingRoutes &&
    (isCoreClimbingRoute(segments) ||
      isLocalProfileRoute(segments) ||
      (capabilities.useLocalPlaylists && isLocalPlaylistRoute(segments)))
  );
}
