import { describe, expect, it } from 'vitest';
import { derivePlayDrawerLightbulbPressAction } from '../../../components/play-drawer/lightbulb-control';
import { resolveWallControl, type WallControlInput } from '../../../components/play-drawer/wall-control';
import { wallControlFrostHasLeds, wallControlUsesFrost } from '../../../components/play-drawer/wall-control-frost';
import { resolveWallLit } from '../../../components/play-drawer/wall-lit';
import { boardHasLights, drivesWithoutBluetooth } from '../../boards/board-lighting';
import { resolvePlayerWallLink } from '../spray-led-wall-link';

type Scenario = {
  boardType: string;
  hasLeds?: boolean;
  /** `useSprayWallLedsEnabled` said yes for the wall on screen. */
  sprayLedWall?: boolean;
  radioConnected?: boolean;
  wallHeldLocally?: boolean;
  holderIsAuthoritative?: boolean;
  canRelay?: boolean;
  commitButton?: WallControlInput['commitButton'];
  displayedLit?: boolean;
  driveMode?: WallControlInput['driveMode'];
};

/** The reads PlayCore makes for its wall control, in its order. */
function playerWall({
  boardType,
  hasLeds = true,
  sprayLedWall = false,
  radioConnected = false,
  wallHeldLocally = false,
  holderIsAuthoritative = false,
  canRelay = false,
  commitButton = null,
  displayedLit = false,
  driveMode = 'off',
}: Scenario) {
  const bulbPressAction = derivePlayDrawerLightbulbPressAction({
    hasBluetooth: true,
    isBluetoothConnected: radioConnected,
    isBluetoothLoading: false,
    ledless: drivesWithoutBluetooth({ hasLeds }),
    wallDevice: false,
    wallHeld: wallHeldLocally,
    holderIsAuthoritative,
    canRelay,
  });
  const link = resolvePlayerWallLink({
    sprayLedWall,
    pressAction: bulbPressAction,
    radioConnected,
    wallHeldLocally,
    holderIsAuthoritative,
    canRelay,
  });
  const lighting = { boardType, hasLeds, litByWallDevice: sprayLedWall };
  const playerBoardHasLights = boardHasLights(lighting);
  const model = resolveWallControl({
    commitButton,
    pressAction: link.pressAction,
    holderIsAuthoritative,
    localConnected: link.phoneLinked,
    pending: false,
    displayedLit,
    offWall: !playerBoardHasLights,
    wallHeldLocally,
    holderIsSelfAccount: false,
    selfFace: null,
    crewFace: null,
    confirmArmed: false,
    commitLabel: 'putOnWall',
    otherClimbLit: false,
    writing: false,
    navigationCommits: false,
    driveMode,
    swipeToDriveEnabled: true,
  });
  return { bulbPressAction, link, lighting, playerHasWall: playerBoardHasLights, model };
}

const CONFIGURED_SPRAY = { boardType: 'spray', hasLeds: false, sprayLedWall: true };
const UNCONFIGURED_SPRAY = { boardType: 'spray', hasLeds: false };
const KILTER = { boardType: 'kilter', hasLeds: true };

describe('a spray wall with LEDs set up on this phone', () => {
  it('gets the wall button and asks to put the climb on the board', () => {
    const { playerHasWall, model, link } = playerWall(CONFIGURED_SPRAY);
    expect(playerHasWall).toBe(true);
    expect(link).toEqual({ pressAction: 'connect', phoneLinked: false, sprayLedHold: false });
    expect(model).toMatchObject({
      state: 'connect',
      labelKey: 'putOnBoard',
      tapAction: 'connect',
      swipeAction: 'drive',
      longPress: null,
    });
  });

  it('reads as lit while this phone holds the wall, with the long press into the board sheet', () => {
    const { model, link } = playerWall({ ...CONFIGURED_SPRAY, wallHeldLocally: true, displayedLit: true });
    expect(link).toEqual({ pressAction: 'disconnect', phoneLinked: true, sprayLedHold: true });
    expect(model).toMatchObject({
      state: 'lit',
      labelKey: 'disconnectBoard',
      tapAction: 'disconnect',
      swipeAction: 'drive',
      longPress: 'sheet',
      holder: 'self',
      selected: true,
    });
  });

  it('asks to put a dark climb back up', () => {
    const { model } = playerWall({ ...CONFIGURED_SPRAY, wallHeldLocally: true, displayedLit: false });
    expect(model).toMatchObject({ state: 'dark', labelKey: 'putOnBoard', tapAction: 'relight', swipeAction: 'drive' });
  });

  it('puts a preview up, with the swipe to drive', () => {
    const { model } = playerWall({ ...CONFIGURED_SPRAY, wallHeldLocally: true, commitButton: 'putOnWall' });
    expect(model).toMatchObject({
      state: 'put_on_wall',
      labelKey: 'putOnBoard',
      tapAction: 'put_on_wall',
      swipeAction: 'drive',
    });
  });

  it('wears the frost while driving', () => {
    const { model, lighting } = playerWall({
      ...CONFIGURED_SPRAY,
      wallHeldLocally: true,
      displayedLit: true,
      driveMode: 'live',
    });
    expect(model).toMatchObject({ labelKey: 'youAreDriving', tapAction: 'stop_driving', driving: true });
    expect(wallControlUsesFrost(model)).toBe(true);
    expect(wallControlFrostHasLeds(lighting)).toBe(true);
  });

  it('reads the climb as lit from the same inputs as an LED board', () => {
    const { playerHasWall } = playerWall(CONFIGURED_SPRAY);
    expect(
      resolveWallLit({
        isAnonymous: false,
        boardHasLights: playerHasWall,
        boardMismatch: false,
        otherBoard: false,
        displayedClimbUuid: 'climb-a',
        committedHeadUuid: 'climb-a',
        wallClimbUuid: 'climb-a',
        isPreview: false,
        wallDriven: true,
        currentDark: false,
      }),
    ).toBe('lit');
  });

  it("relays a preview to a crewmate's hold instead of taking the wall from them", () => {
    const { bulbPressAction, model } = playerWall({
      ...CONFIGURED_SPRAY,
      holderIsAuthoritative: true,
      canRelay: true,
    });
    // The bulb on its own would take it: the reason the player maps the press.
    expect(bulbPressAction).toBe('takeWall');
    expect(model).toMatchObject({ state: 'crew', tapAction: 'relay', labelKey: 'putOnBoard', swipeAction: null });
  });

  it("leaves a crewmate's hold alone with nothing to relay", () => {
    const { model } = playerWall({ ...CONFIGURED_SPRAY, holderIsAuthoritative: true, canRelay: false });
    expect(model).toMatchObject({ state: 'crew', tapAction: 'noop', swipeAction: null });
  });

  it('lets a live Bluetooth link win', () => {
    const { link } = playerWall({ ...CONFIGURED_SPRAY, radioConnected: true });
    expect(link).toEqual({ pressAction: 'disconnect', phoneLinked: true, sprayLedHold: false });
  });
});

describe('a spray wall with no LED setup keeps today’s behaviour', () => {
  it('has no wall button, and the bulb takes the wall', () => {
    const { playerHasWall, model, link } = playerWall(UNCONFIGURED_SPRAY);
    expect(playerHasWall).toBe(false);
    expect(link).toEqual({ pressAction: 'takeWall', phoneLinked: false, sprayLedHold: false });
    expect(model).toMatchObject({ state: 'take_wall', labelKey: 'takeWall', swipeAction: null, longPress: null });
  });

  it('releases a held wall, with no lit state or sheet', () => {
    const { model, link } = playerWall({ ...UNCONFIGURED_SPRAY, wallHeldLocally: true });
    expect(link).toEqual({ pressAction: 'releaseWall', phoneLinked: false, sprayLedHold: false });
    expect(model).toMatchObject({
      state: 'release_wall',
      labelKey: 'releaseWall',
      swipeAction: null,
      longPress: null,
      selected: false,
    });
  });

  it('offers no swipe on a preview', () => {
    const { model } = playerWall({ ...UNCONFIGURED_SPRAY, wallHeldLocally: true, commitButton: 'putOnWall' });
    expect(model.swipeAction).toBeNull();
  });
});

describe('a Kilter board is unchanged', () => {
  it.each<[string, Partial<Scenario>]>([
    ['no link', {}],
    ['a live link', { radioConnected: true, displayedLit: true }],
    ['a crewmate holding it', { holderIsAuthoritative: true, canRelay: true }],
  ])('passes the bulb press straight through with %s', (_name, scenario) => {
    const { bulbPressAction, link, playerHasWall } = playerWall({ ...KILTER, ...scenario });
    expect(playerHasWall).toBe(true);
    expect(link).toEqual({
      pressAction: bulbPressAction,
      phoneLinked: scenario.radioConnected === true,
      sprayLedHold: false,
    });
  });

  it('ignores a virtual hold that is not on an LED spray wall', () => {
    const link = resolvePlayerWallLink({
      sprayLedWall: false,
      pressAction: 'releaseWall',
      radioConnected: false,
      wallHeldLocally: true,
      holderIsAuthoritative: false,
      canRelay: false,
    });
    expect(link).toEqual({ pressAction: 'releaseWall', phoneLinked: false, sprayLedHold: false });
  });

  it('still reads connect, lit and Disconnect board', () => {
    expect(playerWall(KILTER).model).toMatchObject({ state: 'connect', labelKey: 'putOnBoard' });
    expect(playerWall({ ...KILTER, radioConnected: true, displayedLit: true }).model).toMatchObject({
      state: 'lit',
      labelKey: 'disconnectBoard',
      longPress: 'sheet',
    });
  });
});
