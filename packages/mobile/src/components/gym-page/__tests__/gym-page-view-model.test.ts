import { describe, expect, it } from 'vitest';
import type { GymListingState, GymMemberRole } from '@boardsesh/shared-schema';
import {
  boardsHeaderIndex,
  buildGymPageItems,
  deriveGymPageViewModel,
  groupedCellPosition,
  gymEmailUrl,
  gymMapsUrl,
  gymPhoneUrl,
  gymViewerRole,
  gymWebsiteLabel,
  gymWebsiteUrl,
  isGymPageExternalUrl,
  shouldLoadPendingClaim,
  type GymPageGym,
  type GymPageViewer,
} from '../gym-page-view-model';

const SIGNED_OUT: GymPageViewer = { isAuthenticated: false, userId: undefined };
const CLIMBER: GymPageViewer = { isAuthenticated: true, userId: 'climber-1' };
const OWNER: GymPageViewer = { isAuthenticated: true, userId: 'owner-1' };

function gym(overrides: Partial<GymPageGym> = {}): GymPageGym {
  return {
    ownerId: 'owner-1',
    ownerDisplayName: 'Sam',
    myRole: null,
    canEdit: false,
    canClaim: false,
    isPublic: true,
    listingState: 'CLIMBER_LISTED',
    hours: null,
    website: null,
    contactPhone: null,
    contactEmail: null,
    ...overrides,
  };
}

const PENDING = { id: 'claim-1', method: 'admin' as const, createdAt: '2026-11-20T10:00:00.000Z' };

describe('gymViewerRole', () => {
  it.each<[string, Partial<GymPageGym>, GymPageViewer, string]>([
    ['signed out', {}, SIGNED_OUT, 'signed_out'],
    // The server reports an owner's myRole as admin; ownership is read first.
    ['the owner', { myRole: 'admin', canEdit: true }, OWNER, 'owner'],
    ['a gym admin', { myRole: 'admin', canEdit: true }, CLIMBER, 'admin'],
    ['a gym editor', { myRole: 'editor', canEdit: true }, CLIMBER, 'editor'],
    ['a community leader who can edit', { canEdit: true }, CLIMBER, 'moderator'],
    ['a member', { myRole: 'member' as GymMemberRole }, CLIMBER, 'member'],
    ['any other climber', {}, CLIMBER, 'climber'],
  ])('reads %s', (_label, overrides, viewer, expected) => {
    expect(gymViewerRole(gym(overrides), viewer)).toBe(expected);
  });

  it('never treats a signed-in viewer whose id has not resolved as the owner', () => {
    expect(gymViewerRole(gym({ ownerId: 'owner-1' }), { isAuthenticated: true, userId: undefined })).toBe('climber');
  });
});

describe('deriveGymPageViewModel: who runs this gym', () => {
  it.each<[GymListingState, string, string, string]>([
    ['RUN_BY_GYM', 'runByGym', 'positive', 'staff'],
    ['CLIMBER_LISTED', 'climberListed', 'neutral', 'climber'],
    ['UNCLAIMED', 'unclaimed', 'neutral', 'unclaimed'],
  ])('a climber on a %s gym sees the %s pill', (listingState, pill, tone, line) => {
    const model = deriveGymPageViewModel(gym({ listingState }), CLIMBER);
    expect(model.pill).toBe(pill);
    expect(model.pillTone).toBe(tone);
    expect(model.runByLine.kind).toBe(line);
  });

  it('names the climber who added the gym, and says "a climber" when the name is withheld', () => {
    expect(deriveGymPageViewModel(gym(), CLIMBER).runByLine).toEqual({ kind: 'climber', name: 'Sam' });
    expect(deriveGymPageViewModel(gym({ ownerDisplayName: null }), CLIMBER).runByLine).toEqual({
      kind: 'climber',
      name: null,
    });
    expect(deriveGymPageViewModel(gym({ ownerDisplayName: '  ' }), CLIMBER).runByLine).toEqual({
      kind: 'climber',
      name: null,
    });
  });

  it.each<[string, Partial<GymPageGym>, GymPageViewer, string]>([
    ['owner', { myRole: 'admin', canEdit: true, listingState: 'RUN_BY_GYM' }, OWNER, 'youOwner'],
    ['admin', { myRole: 'admin', canEdit: true }, CLIMBER, 'youAdmin'],
    ['editor', { myRole: 'editor', canEdit: true }, CLIMBER, 'youEditor'],
  ])('tells the %s their own role instead of the listing state, with no line', (_role, overrides, viewer, pill) => {
    const model = deriveGymPageViewModel(gym(overrides), viewer);
    expect(model.pill).toBe(pill);
    expect(model.pillTone).toBe('positive');
    expect(model.runByLine).toEqual({ kind: 'none' });
  });

  it('shows a community leader the listing state, not a staff pill', () => {
    const model = deriveGymPageViewModel(gym({ canEdit: true, listingState: 'UNCLAIMED' }), CLIMBER);
    expect(model.staffRole).toBeNull();
    expect(model.pill).toBe('unclaimed');
  });
});

describe('deriveGymPageViewModel: claiming', () => {
  it('offers a claim to a climber the server lets claim, on a gym its staff do not run', () => {
    const model = deriveGymPageViewModel(gym({ canClaim: true }), CLIMBER);
    expect(model.claimCard).toBe('claim');
    expect(model.inlineClaim).toBe(true);
  });

  it('asks a signed-out visitor to log in first (the server never says canClaim without an account)', () => {
    const model = deriveGymPageViewModel(gym({ listingState: 'UNCLAIMED', canClaim: false }), SIGNED_OUT);
    expect(model.claimCard).toBe('signIn');
    expect(model.inlineClaim).toBe(true);
  });

  it('shows no claim card while the session is still being restored', () => {
    const model = deriveGymPageViewModel(gym({ canClaim: true }), { ...SIGNED_OUT, authResolved: false });
    expect(model.claimCard).toBe('hidden');
    expect(model.inlineClaim).toBe(false);
  });

  it('hides the claim for everyone on a gym its staff run', () => {
    const runByGym = gym({ listingState: 'RUN_BY_GYM', canClaim: true });
    expect(deriveGymPageViewModel(runByGym, CLIMBER).claimCard).toBe('hidden');
    expect(deriveGymPageViewModel(runByGym, SIGNED_OUT).claimCard).toBe('hidden');
    expect(deriveGymPageViewModel(runByGym, CLIMBER).inlineClaim).toBe(false);
  });

  it('hides the claim on a private gym, for staff and for a community leader', () => {
    expect(deriveGymPageViewModel(gym({ isPublic: false, canClaim: true }), CLIMBER).claimCard).toBe('hidden');
    expect(deriveGymPageViewModel(gym({ myRole: 'editor', canEdit: true }), CLIMBER).claimCard).toBe('hidden');
    expect(deriveGymPageViewModel(gym({ canEdit: true }), CLIMBER).claimCard).toBe('hidden');
  });

  it('shows a pending claim instead of a second claim, and drops the inline prompt', () => {
    const model = deriveGymPageViewModel(gym({ canClaim: true }), CLIMBER, PENDING);
    expect(model.claimCard).toBe('pending');
    expect(model.inlineClaim).toBe(false);
  });

  it('opens on the denial card, with the claim offered again, from a denied-claim notice', () => {
    const model = deriveGymPageViewModel(gym({ canClaim: true, listingState: 'UNCLAIMED' }), CLIMBER, null, {
      claimDenied: true,
    });
    expect(model.claimCard).toBe('denied');
    expect(model.inlineClaim).toBe(false);
  });

  it('says the claim was denied without a retry once the gym is no longer claimable', () => {
    const runByGym = gym({ listingState: 'RUN_BY_GYM', canClaim: true });
    expect(deriveGymPageViewModel(runByGym, CLIMBER, null, { claimDenied: true }).claimCard).toBe('deniedClosed');
    expect(deriveGymPageViewModel(gym({ canClaim: false }), CLIMBER, null, { claimDenied: true }).claimCard).toBe(
      'deniedClosed',
    );
  });

  it('lets a claim filed since the denial, staff rights, or no session win over the denial', () => {
    expect(deriveGymPageViewModel(gym({ canClaim: true }), CLIMBER, PENDING, { claimDenied: true }).claimCard).toBe(
      'pending',
    );
    const staff = gym({ myRole: 'admin', canEdit: true, listingState: 'RUN_BY_GYM' });
    expect(deriveGymPageViewModel(staff, CLIMBER, null, { claimDenied: true }).claimCard).toBe('hidden');
    expect(deriveGymPageViewModel(gym(), SIGNED_OUT, null, { claimDenied: true }).claimCard).toBe('signIn');
    expect(deriveGymPageViewModel(gym({ isPublic: false }), CLIMBER, null, { claimDenied: true }).claimCard).toBe(
      'hidden',
    );
  });

  it('only asks for a pending claim where a claim card could show', () => {
    expect(shouldLoadPendingClaim(gym(), CLIMBER)).toBe(true);
    expect(shouldLoadPendingClaim(gym(), SIGNED_OUT)).toBe(false);
    expect(shouldLoadPendingClaim(gym({ listingState: 'RUN_BY_GYM' }), CLIMBER)).toBe(false);
    expect(shouldLoadPendingClaim(gym({ isPublic: false }), CLIMBER)).toBe(false);
    expect(shouldLoadPendingClaim(gym({ myRole: 'admin', canEdit: true }), CLIMBER)).toBe(false);
    expect(shouldLoadPendingClaim(gym({ canEdit: true }), CLIMBER)).toBe(false);
  });
});

describe('deriveGymPageViewModel: staff', () => {
  it('gives new staff Start here until the hours are in, and the staff tools', () => {
    const model = deriveGymPageViewModel(gym({ myRole: 'admin', canEdit: true }), CLIMBER);
    expect(model.startHere).toEqual(['boards', 'hours', 'tv']);
    expect(model.staffTools).toEqual(['editDetails', 'nearbyBoards', 'kiosks', 'insights']);
  });

  it('drops Start here once the gym has opening hours', () => {
    const model = deriveGymPageViewModel(gym({ myRole: 'editor', canEdit: true, hours: 'Mon-Fri 10-22' }), CLIMBER);
    expect(model.startHere).toEqual([]);
  });

  it('gives a community leader the staff tools but no Start here', () => {
    const model = deriveGymPageViewModel(gym({ canEdit: true }), CLIMBER);
    expect(model.startHere).toEqual([]);
    expect(model.staffTools).toHaveLength(4);
  });

  it('gives a climber neither', () => {
    const model = deriveGymPageViewModel(gym(), CLIMBER);
    expect(model.startHere).toEqual([]);
    expect(model.staffTools).toEqual([]);
  });

  it('only lets a signed-in viewer follow', () => {
    expect(deriveGymPageViewModel(gym(), CLIMBER).canFollow).toBe(true);
    expect(deriveGymPageViewModel(gym(), SIGNED_OUT).canFollow).toBe(false);
  });
});

describe('deriveGymPageViewModel: info', () => {
  it('lists only what the gym has set, in a fixed order', () => {
    expect(deriveGymPageViewModel(gym(), CLIMBER).info).toEqual([]);
    expect(
      deriveGymPageViewModel(
        gym({ hours: 'Daily 9-21', website: 'crux.com', contactPhone: '+44 20 7946 0000', contactEmail: ' ' }),
        CLIMBER,
      ).info,
    ).toEqual(['hours', 'website', 'phone']);
  });
});

describe('buildGymPageItems', () => {
  const boards = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];

  it('lays out a climber page: top, boards, claim card', () => {
    const model = deriveGymPageViewModel(gym({ canClaim: true }), CLIMBER);
    const items = buildGymPageItems({ model, boards, boardsState: 'ready', canReport: false });
    expect(items.map((item) => item.kind)).toEqual(['top', 'boardsHeader', 'board', 'board', 'board', 'claim']);
    expect(items.filter((item) => item.kind === 'board').map((item) => item.position)).toEqual([
      'first',
      'middle',
      'last',
    ]);
  });

  it('lays out a staff page: Start here before the boards, staff tools and info after', () => {
    const model = deriveGymPageViewModel(
      gym({ myRole: 'admin', canEdit: true, website: 'crux.com', listingState: 'RUN_BY_GYM' }),
      CLIMBER,
    );
    const items = buildGymPageItems({ model, boards: [boards[0]], boardsState: 'ready', canReport: false });
    expect(items.map((item) => item.kind)).toEqual(['top', 'start', 'boardsHeader', 'board', 'staff', 'info']);
    expect(items[3]).toMatchObject({ kind: 'board', position: 'only', key: 'board:a' });
    expect(boardsHeaderIndex(items)).toBe(2);
  });

  it('puts a claim denial straight under the top block, where the climber lands', () => {
    const model = deriveGymPageViewModel(gym({ canClaim: true }), CLIMBER, null, { claimDenied: true });
    const items = buildGymPageItems({ model, boards, boardsState: 'ready', canReport: false });
    expect(items.map((item) => item.kind)).toEqual(['top', 'claim', 'boardsHeader', 'board', 'board', 'board']);
    expect(items[1]).toMatchObject({ kind: 'claim', card: 'denied' });
  });

  it('puts Report a problem last, only once the seam is wired', () => {
    const model = deriveGymPageViewModel(gym({ canClaim: true }), CLIMBER);
    const items = buildGymPageItems({ model, boards, boardsState: 'ready', canReport: true });
    expect(items.at(-1)?.kind).toBe('report');
  });

  it.each([
    ['loading', 'boardsLoading', null],
    ['error', 'boardsError', null],
    ['ready', 'boardsEmpty', 0],
  ] as const)('with no boards and the list %s, shows %s', (boardsState, kind, count) => {
    const model = deriveGymPageViewModel(gym(), CLIMBER);
    const items = buildGymPageItems({ model, boards: [], boardsState, canReport: false });
    expect(items.map((item) => item.kind)).toEqual(['top', 'boardsHeader', kind]);
    expect(items[1]).toMatchObject({ count });
  });

  it('shows no count while placeholder rows stand in for the loading list', () => {
    const model = deriveGymPageViewModel(gym(), CLIMBER);
    const items = buildGymPageItems({ model, boards, boardsState: 'loading', canReport: false });
    expect(items[1]).toMatchObject({ kind: 'boardsHeader', count: null });
  });

  it('keeps boards on screen through a refetch that fails', () => {
    const model = deriveGymPageViewModel(gym(), CLIMBER);
    const items = buildGymPageItems({ model, boards, boardsState: 'error', canReport: false });
    expect(items.filter((item) => item.kind === 'board')).toHaveLength(3);
    expect(items.some((item) => item.kind === 'boardsError')).toBe(false);
  });
});

describe('groupedCellPosition', () => {
  it('rounds the ends of a group and squares the middle', () => {
    expect(groupedCellPosition(0, 1)).toBe('only');
    expect(groupedCellPosition(0, 2)).toBe('first');
    expect(groupedCellPosition(1, 2)).toBe('last');
    expect(groupedCellPosition(1, 3)).toBe('middle');
  });
});

describe('links the page opens', () => {
  it('turns a typed website into a web link and refuses anything else', () => {
    expect(gymWebsiteUrl('crux.com')).toBe('https://crux.com');
    expect(gymWebsiteUrl(' https://crux.com/climb ')).toBe('https://crux.com/climb');
    expect(gymWebsiteUrl('http://crux.co.uk')).toBe('http://crux.co.uk');
    expect(gymWebsiteUrl('javascript:alert(1)')).toBeNull();
    expect(gymWebsiteUrl('localhost')).toBeNull();
    expect(gymWebsiteUrl('')).toBeNull();
    expect(gymWebsiteUrl(null)).toBeNull();
  });

  it('shows the website without its scheme', () => {
    expect(gymWebsiteLabel('https://crux.com/')).toBe('crux.com');
    expect(gymWebsiteLabel('crux.com')).toBe('crux.com');
  });

  it('dials only the digits of a phone number', () => {
    expect(gymPhoneUrl('+44 (20) 7946-0000')).toBe('tel:+442079460000');
    expect(gymPhoneUrl('call us')).toBeNull();
    expect(gymPhoneUrl(undefined)).toBeNull();
  });

  it('mails only an address that looks like one', () => {
    expect(gymEmailUrl(' hello@crux.com ')).toBe('mailto:hello@crux.com');
    expect(gymEmailUrl('hello')).toBeNull();
  });

  it('searches Apple Maps on iOS and Google Maps elsewhere, coordinates first', () => {
    const withCoordinates = { name: 'Crux & Co', address: '1 Crag St', latitude: 51.5, longitude: -0.12 };
    expect(gymMapsUrl(withCoordinates, 'ios')).toBe('https://maps.apple.com/?q=Crux%20%26%20Co&ll=51.5,-0.12');
    expect(gymMapsUrl(withCoordinates, 'android')).toBe('https://www.google.com/maps/search/?api=1&query=51.5%2C-0.12');
    const addressOnly = { name: 'Crux', address: '1 Crag St', latitude: null, longitude: null };
    expect(gymMapsUrl(addressOnly, 'ios')).toBe('https://maps.apple.com/?q=Crux&address=1%20Crag%20St');
    expect(gymMapsUrl(addressOnly, 'web')).toBe(
      'https://www.google.com/maps/search/?api=1&query=Crux%2C%201%20Crag%20St',
    );
    expect(gymMapsUrl({ name: 'Crux', address: null, latitude: null, longitude: null }, 'ios')).toBeNull();
  });

  it('only ever opens the schemes it builds', () => {
    expect(isGymPageExternalUrl('https://crux.com')).toBe(true);
    expect(isGymPageExternalUrl('tel:+44')).toBe(true);
    expect(isGymPageExternalUrl('mailto:a@b.co')).toBe(true);
    expect(isGymPageExternalUrl('http://crux.com')).toBe(true);
    expect(isGymPageExternalUrl('geo:51.5,-0.12')).toBe(false);
    expect(isGymPageExternalUrl('javascript:alert(1)')).toBe(false);
  });
});
