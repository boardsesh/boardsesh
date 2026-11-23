import { describe, expect, it } from 'vite-plus/test';
import { gymListingRunner, gymPageHref } from '../manage-no-access-logic';

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
