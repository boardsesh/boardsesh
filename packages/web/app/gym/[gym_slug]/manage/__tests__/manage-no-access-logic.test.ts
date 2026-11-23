import { describe, expect, it } from 'vite-plus/test';
import { gymClaimOpenToViewer, gymListingRunner, gymPageHref } from '../manage-no-access-logic';

describe('who can change this gym', () => {
  it('reads who runs it from the listing state', () => {
    expect(gymListingRunner({ listingState: 'RUN_BY_GYM', ownerDisplayName: 'Crux staff' })).toBe('staff');
    expect(gymListingRunner({ listingState: 'CLIMBER_LISTED', ownerDisplayName: 'Sam' })).toBe('climber');
    expect(gymListingRunner({ listingState: 'CLIMBER_LISTED', ownerDisplayName: null })).toBe('climber_hidden');
    expect(gymListingRunner({ listingState: 'CLIMBER_LISTED', ownerDisplayName: '  ' })).toBe('climber_hidden');
    expect(gymListingRunner({ listingState: 'UNCLAIMED', ownerDisplayName: 'Boardsesh' })).toBe('unclaimed');
  });

  it('goes back to the gym page, or the directory for a gym without a slug', () => {
    expect(gymPageHref({ slug: 'crux' })).toBe('/gym/crux');
    expect(gymPageHref({ slug: 'crux & co' })).toBe('/gym/crux%20%26%20co');
    expect(gymPageHref({ slug: null })).toBe('/gyms');
  });
});

describe('whether the lock state offers the claim', () => {
  it("follows the server's canClaim", () => {
    expect(gymClaimOpenToViewer({ canClaim: true, listingState: 'UNCLAIMED' })).toBe(true);
    expect(gymClaimOpenToViewer({ canClaim: true, listingState: 'CLIMBER_LISTED' })).toBe(true);
    expect(gymClaimOpenToViewer({ canClaim: false, listingState: 'UNCLAIMED' })).toBe(false);
  });

  it('never offers it on a gym its staff run, even when canClaim says yes', () => {
    expect(gymClaimOpenToViewer({ canClaim: true, listingState: 'RUN_BY_GYM' })).toBe(false);
  });
});
