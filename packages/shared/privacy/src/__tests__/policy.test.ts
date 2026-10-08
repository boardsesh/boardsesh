import { describe, expect, it } from 'vite-plus/test';
import { canReadActivity, canReadContent, canReadLocation, canReadResource, type PrivacyViewer } from '../index';

const stranger: PrivacyViewer = { isOwner: false, isApprovedFollower: false };
const follower: PrivacyViewer = { isOwner: false, isApprovedFollower: true };
const owner: PrivacyViewer = { isOwner: true, isApprovedFollower: false };
const privateSettings = { isPrivate: true, privacyRevision: 3 };

describe('account and individual publication audiences', () => {
  it('keeps private activity available to its owner and approved followers', () => {
    expect(canReadActivity(true, owner)).toBe(true);
    expect(canReadActivity(true, follower)).toBe(true);
    expect(canReadActivity(true, stranger)).toBe(false);
    expect(canReadActivity(false, stranger)).toBe(true);
  });
  it('defaults private activity to followers and public activity to everyone', () => {
    expect(canReadContent(privateSettings, null, stranger)).toBe(false);
    expect(canReadContent(privateSettings, null, follower)).toBe(true);
    expect(canReadContent({ isPrivate: false, privacyRevision: 0 }, null, stranger)).toBe(true);
  });
  it('a private switch retracts every older public consent but keeps follower access', () => {
    const oldPublication = { audience: 'public' as const, publicConsentRevision: 2 };
    expect(canReadContent(privateSettings, oldPublication, stranger)).toBe(false);
    expect(canReadContent(privateSettings, oldPublication, follower)).toBe(true);
    expect(canReadContent(privateSettings, oldPublication, owner)).toBe(true);
  });
  it('supports deliberate public republication without opening the whole account', () => {
    expect(canReadContent(privateSettings, { audience: 'public', publicConsentRevision: 3 }, stranger)).toBe(true);
    expect(canReadContent(privateSettings, null, stranger)).toBe(false);
    expect(
      canReadContent(
        { ...privateSettings, privacyRevision: 4 },
        { audience: 'public', publicConsentRevision: 3 },
        stranger,
      ),
    ).toBe(false);
  });
  it('never lets approved followers override an only-me item', () => {
    const onlyMe = { audience: 'only_me' as const, publicConsentRevision: 3 };
    expect(canReadContent(privateSettings, onlyMe, follower)).toBe(false);
    expect(canReadContent(privateSettings, onlyMe, owner)).toBe(true);
  });
  it('honors followers-only posts even on a public account', () => {
    expect(
      canReadContent(
        { isPrivate: false, privacyRevision: 0 },
        { audience: 'followers', publicConsentRevision: null },
        stranger,
      ),
    ).toBe(false);
  });
});

describe('resource invitations and location', () => {
  const resourceStranger = { ...stranger, hasApprovedGrant: false, hasRevokedGrant: false, inheritFollowers: false };
  it('invitation approval grants access; a pending request does not', () => {
    expect(canReadResource('invite_only', resourceStranger)).toBe(false);
    expect(canReadResource('invite_only', { ...resourceStranger, hasApprovedGrant: true })).toBe(true);
  });
  it('revocation defeats old approval, accepted following and public/unlisted links', () => {
    const revoked = {
      ...resourceStranger,
      isApprovedFollower: true,
      inheritFollowers: true,
      hasApprovedGrant: true,
      hasRevokedGrant: true,
    };
    for (const audience of ['public', 'unlisted', 'followers', 'invite_only'] as const)
      expect(canReadResource(audience, revoked)).toBe(false);
    expect(canReadResource('only_me', { ...revoked, isOwner: true })).toBe(true);
  });
  it('invited members do not gain access to an only-me resource', () => {
    expect(canReadResource('only_me', { ...resourceStranger, hasApprovedGrant: true })).toBe(false);
  });
  it('follower inheritance is opt-in on an invite-only home board', () => {
    const following = { ...resourceStranger, isApprovedFollower: true };
    expect(canReadResource('invite_only', following)).toBe(false);
    expect(canReadResource('invite_only', { ...following, inheritFollowers: true })).toBe(true);
    expect(canReadResource('followers', following)).toBe(true);
  });
  it('a readable board does not disclose members-only location to strangers', () => {
    const viewer = { ...stranger, hasResourceAccess: true, hasApprovedGrant: false };
    expect(canReadLocation('members', viewer)).toBe(false);
    expect(canReadLocation('members', { ...viewer, hasApprovedGrant: true })).toBe(true);
    expect(canReadLocation('only_me', { ...viewer, hasApprovedGrant: true })).toBe(false);
  });
  it('location never escapes a resource the viewer cannot access', () => {
    expect(canReadLocation('public', { ...follower, hasResourceAccess: false, hasApprovedGrant: true })).toBe(false);
    expect(canReadLocation('only_me', { ...owner, hasResourceAccess: true, hasApprovedGrant: false })).toBe(true);
  });
});
