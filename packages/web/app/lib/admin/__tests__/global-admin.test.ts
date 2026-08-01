import { describe, expect, it } from 'vite-plus/test';
import { isGlobalCommunityAdmin } from '../global-admin';

describe('isGlobalCommunityAdmin', () => {
  it('accepts only unscoped admin roles', () => {
    expect(isGlobalCommunityAdmin({ role: 'admin', boardType: null })).toBe(true);
    expect(isGlobalCommunityAdmin({ role: 'admin' })).toBe(true);
    expect(isGlobalCommunityAdmin({ role: 'admin', boardType: 'kilter' })).toBe(false);
    expect(isGlobalCommunityAdmin({ role: 'community_leader', boardType: null })).toBe(false);
  });
});
