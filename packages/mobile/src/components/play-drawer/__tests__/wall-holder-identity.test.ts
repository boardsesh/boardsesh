import { describe, expect, it } from 'vitest';
import { resolveWallHolderIdentity } from '../wall-holder-identity';
import { isHolderSelfAccount, resolveWallControl, type WallControlInput } from '../wall-control';

// #7113 PR 4: Liz took the board from Sam's phone with a hand-off. Until
// presence names her, Sam's phone stands her in for the holder it still
// reports (Sam's own account, then nobody), so his control reads "Put on
// board" with her face for the whole window, never "On your other phone".

const LIZ = { userId: 'liz', displayName: 'Liz', avatarUrl: 'liz.png' };
const SAM_PRESENCE = { userId: 'sam', displayName: 'Sam', avatarUrl: 'sam.png' };
const SAMS_CLIMB = { sentByUserId: 'sam', sentByDisplayName: 'Sam', sentByAvatarUrl: 'sam.png' };

describe('resolveWallHolderIdentity', () => {
  it.each([
    ['presence still names Sam', SAM_PRESENCE],
    ['the release landed: nobody', null],
  ])('while taken over and %s, names Liz', (_case, holder) => {
    expect(resolveWallHolderIdentity(holder, SAMS_CLIMB, LIZ)).toEqual({
      face: { name: 'Liz', avatarUrl: 'liz.png' },
      userId: 'liz',
      holderUserId: 'liz',
    });
  });

  it("never falls back to the climber's own name off the climb they lit", () => {
    const nameless = { userId: 'liz', displayName: null, avatarUrl: null };
    expect(resolveWallHolderIdentity(null, SAMS_CLIMB, nameless)).toEqual({
      face: null,
      userId: 'liz',
      holderUserId: 'liz',
    });
  });

  it('otherwise names presence, then the climb', () => {
    expect(resolveWallHolderIdentity(SAM_PRESENCE, null, null)).toEqual({
      face: { name: 'Sam', avatarUrl: 'sam.png' },
      userId: 'sam',
      holderUserId: 'sam',
    });
    expect(resolveWallHolderIdentity(null, SAMS_CLIMB, null)).toEqual({
      face: { name: 'Sam', avatarUrl: 'sam.png' },
      userId: 'sam',
      holderUserId: null,
    });
  });
});

describe("Sam's board control after Liz took the board", () => {
  // Sam's phone let go: no link, and `takenOverBy` makes the board read as
  // held by a crewmate (`holderIsAuthoritative`), so a tap relays or waits.
  const SAMS_PHONE: WallControlInput = {
    commitButton: null,
    pressAction: 'noop',
    holderIsAuthoritative: true,
    localConnected: false,
    pending: false,
    displayedLit: true,
    offWall: false,
    wallHeldLocally: false,
    holderIsSelfAccount: false,
    selfFace: { name: 'Sam', avatarUrl: 'sam.png' },
    crewFace: null,
    confirmArmed: false,
    commitLabel: 'putOnWall',
    otherClimbLit: false,
    writing: false,
    autoDisconnectWarning: false,
    navigationCommits: false,
  };

  function samSees(
    holder: typeof SAM_PRESENCE | null,
    takenOverBy: typeof LIZ | null,
    input: Partial<WallControlInput>,
  ) {
    const identity = resolveWallHolderIdentity(holder, SAMS_CLIMB, takenOverBy);
    return resolveWallControl({
      ...SAMS_PHONE,
      ...input,
      holderIsSelfAccount: isHolderSelfAccount(identity.holderUserId, 'sam'),
      crewFace: identity.face,
    });
  }

  it.each([
    ['presence still names Sam', SAM_PRESENCE],
    ['the release landed', null],
  ])("%s: a preview reads Put on board with Liz's face", (_case, holder) => {
    expect(samSees(holder, LIZ, { commitButton: 'putOnWall', pressAction: 'relay' })).toMatchObject({
      holder: 'crew',
      holderName: 'Liz',
      holderFace: { name: 'Liz', avatarUrl: 'liz.png' },
      labelKey: 'putOnBoard',
      a11yValueKey: 'holderHasBoard',
    });
  });

  it.each([
    ['presence still names Sam', SAM_PRESENCE],
    ['the release landed', null],
  ])("%s: the climb on screen reads as Liz's board, never your other phone", (_case, holder) => {
    const model = samSees(holder, LIZ, {});
    expect(model).toMatchObject({ state: 'crew', holder: 'crew', holderName: 'Liz', labelKey: 'onBoard' });
    expect(model.labelKey).not.toBe('onOtherPhone');
  });

  it('without the stand-in, the gap read "On your other phone" (the bug this fixes)', () => {
    expect(samSees(SAM_PRESENCE, null, {}).labelKey).toBe('onOtherPhone');
  });
});
