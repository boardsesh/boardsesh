import { describe, expect, it } from 'vitest';
import {
  canEnterRouteWithoutAccount,
  isAccessMode,
  isCoreClimbingRoute,
  isLocalPlaylistRoute,
  isLocalProfileRoute,
  resolveAccessCapabilities,
  type AccessContext,
} from '../access-mode';

const NATIVE_LOCAL: AccessContext = {
  accessMode: 'local',
  isAuthenticated: false,
  localCatalogReady: false,
  platform: 'native',
};
const NATIVE_LOCAL_READY: AccessContext = { ...NATIVE_LOCAL, localCatalogReady: true };
const WEB_ANONYMOUS: AccessContext = {
  accessMode: 'local',
  isAuthenticated: false,
  localCatalogReady: true,
  platform: 'web',
};

describe('resolveAccessCapabilities', () => {
  it('permits native local setup but withholds climbing until a catalog is durable', () => {
    expect(resolveAccessCapabilities(NATIVE_LOCAL)).toEqual({
      readPublicClimbs: true,
      chooseLocalProfile: true,
      enterCoreClimbingRoutes: false,
      configureLocalBoard: true,
      downloadBoardCatalog: true,
      logLocalAscents: false,
      useLocalFavorites: false,
      useLocalPlaylists: false,
      logCloudAscents: false,
      useAccountFeatures: false,
    });
  });

  it('unlocks core routes and local logs after the board catalog is durable', () => {
    expect(resolveAccessCapabilities(NATIVE_LOCAL_READY)).toMatchObject({
      configureLocalBoard: true,
      downloadBoardCatalog: true,
      enterCoreClimbingRoutes: true,
      logLocalAscents: true,
      useLocalFavorites: true,
      useLocalPlaylists: true,
      logCloudAscents: false,
    });
  });

  it('keeps anonymous web ascent logging and account features disabled', () => {
    expect(resolveAccessCapabilities(WEB_ANONYMOUS)).toMatchObject({
      readPublicClimbs: true,
      chooseLocalProfile: false,
      enterCoreClimbingRoutes: false,
      configureLocalBoard: false,
      downloadBoardCatalog: false,
      logLocalAscents: false,
      useLocalFavorites: false,
      useLocalPlaylists: false,
      logCloudAscents: false,
      useAccountFeatures: false,
    });
  });

  it('grants cloud capabilities only to an authenticated account-mode session', () => {
    expect(
      resolveAccessCapabilities({
        accessMode: 'account',
        isAuthenticated: true,
        localCatalogReady: false,
        platform: 'native',
      }),
    ).toMatchObject({
      enterCoreClimbingRoutes: true,
      logLocalAscents: false,
      useLocalFavorites: false,
      useLocalPlaylists: false,
      logCloudAscents: true,
      useAccountFeatures: true,
    });
    expect(
      resolveAccessCapabilities({
        accessMode: 'local',
        isAuthenticated: true,
        localCatalogReady: true,
        platform: 'native',
      }),
    ).toMatchObject({
      enterCoreClimbingRoutes: true,
      logLocalAscents: true,
      useLocalFavorites: true,
      useLocalPlaylists: true,
      logCloudAscents: false,
      useAccountFeatures: false,
    });
  });
});

describe('local-profile route policy', () => {
  it.each([
    ['(tabs)', 'climbs'],
    ['(tabs)', 'climbs', '[climbUuid]'],
    ['(tabs)', 'climbs', 'holds'],
    ['(tabs)', 'climbs', 'setters'],
    ['(tabs)', 'climbs', 'zone'],
    ['play'],
  ])('admits the core climbing route %j', (...segments) => {
    expect(isCoreClimbingRoute(segments)).toBe(true);
    expect(canEnterRouteWithoutAccount(NATIVE_LOCAL_READY, segments)).toBe(true);
  });

  it.each([
    ['(tabs)', 'profile'],
    ['(tabs)', 'profile', 'more'],
  ])('admits the SQLite-backed local profile route %j', (...segments) => {
    expect(isLocalProfileRoute(segments)).toBe(true);
    expect(canEnterRouteWithoutAccount(NATIVE_LOCAL_READY, segments)).toBe(true);
  });

  it.each([
    ['(tabs)', 'discover', 'all'],
    ['(tabs)', 'discover', '[playlist_uuid]'],
  ])('admits the SQLite-backed private playlist route %j', (...segments) => {
    expect(isLocalPlaylistRoute(segments)).toBe(true);
    expect(canEnterRouteWithoutAccount(NATIVE_LOCAL_READY, segments)).toBe(true);
  });

  it.each([
    ['(tabs)', 'home'],
    ['(tabs)', 'record'],
    ['(tabs)', 'discover'],
    ['(tabs)', 'discover', 'smart'],
    ['(tabs)', 'discover', 'smart', '[type]'],
    ['(tabs)', 'discover', 'all', 'unknown'],
    ['(tabs)', 'discover', '[playlist_uuid]', 'unknown'],
    ['(tabs)', 'profile', 'edit'],
    ['(tabs)', 'profile', 'notifications'],
    ['(tabs)', 'profile', 'more', 'unknown'],
    ['(tabs)', 'climbs', 'create'],
    ['(tabs)', 'climbs', 'unknown'],
    ['(tabs)', 'climbs', '[climbUuid]', 'extra'],
    ['play', 'unknown'],
    ['boards'],
    ['boards', 'create'],
    ['join', '[sessionId]'],
    ['auth', 'login'],
    [],
  ])('keeps the non-core route %j out of local-profile access', (...segments) => {
    expect(isCoreClimbingRoute(segments)).toBe(false);
    expect(canEnterRouteWithoutAccount(NATIVE_LOCAL_READY, segments)).toBe(false);
  });

  it('does not let a retained account token bypass local-profile route policy', () => {
    const retainedTokenLocal = { ...NATIVE_LOCAL_READY, isAuthenticated: true };
    expect(canEnterRouteWithoutAccount(retainedTokenLocal, ['(tabs)', 'profile'])).toBe(true);
    expect(canEnterRouteWithoutAccount(retainedTokenLocal, ['(tabs)', 'home'])).toBe(false);
    expect(canEnterRouteWithoutAccount(retainedTokenLocal, ['(tabs)', 'profile', 'edit'])).toBe(false);
  });

  it('admits only the dedicated setup route before a catalog download completes', () => {
    expect(canEnterRouteWithoutAccount(NATIVE_LOCAL, ['boards', 'local-setup'])).toBe(true);
    expect(canEnterRouteWithoutAccount(NATIVE_LOCAL, ['(tabs)', 'climbs'])).toBe(false);
    expect(canEnterRouteWithoutAccount(NATIVE_LOCAL, ['boards', 'create'])).toBe(false);
  });

  it('does not admit core routes on anonymous web or account-mode native', () => {
    expect(canEnterRouteWithoutAccount(WEB_ANONYMOUS, ['(tabs)', 'climbs'])).toBe(false);
    expect(
      canEnterRouteWithoutAccount(
        { accessMode: 'account', isAuthenticated: false, localCatalogReady: false, platform: 'native' },
        ['(tabs)', 'climbs'],
      ),
    ).toBe(false);
  });
});

describe('isAccessMode', () => {
  it('accepts only persisted mode values', () => {
    expect(isAccessMode('account')).toBe(true);
    expect(isAccessMode('local')).toBe(true);
    expect(isAccessMode('offline')).toBe(false);
    expect(isAccessMode(null)).toBe(false);
  });
});
