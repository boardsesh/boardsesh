import { describe, it, expect } from 'vitest';
import {
  ADMIN_VOTE_WEIGHT,
  DEFAULT_VOTE_WEIGHT,
  LEADER_VOTE_WEIGHT,
  roleAppliesToBoard,
  rolesGrantAdmin,
  rolesGrantAdminOrLeader,
  voteWeightForRoles,
  type CommunityRoleScope,
} from '../index';

const globalAdmin: CommunityRoleScope = { role: 'admin', boardType: null };
const globalLeader: CommunityRoleScope = { role: 'community_leader', boardType: null };
const kilterLeader: CommunityRoleScope = { role: 'community_leader', boardType: 'kilter' };
const kilterAdmin: CommunityRoleScope = { role: 'admin', boardType: 'kilter' };
const globalTester: CommunityRoleScope = { role: 'tester', boardType: null };

describe('roleAppliesToBoard', () => {
  it('treats a null board type as a grant over every board', () => {
    expect(roleAppliesToBoard(globalAdmin, 'kilter')).toBe(true);
    expect(roleAppliesToBoard(globalAdmin, 'tension')).toBe(true);
    expect(roleAppliesToBoard(globalAdmin)).toBe(true);
  });

  it('keeps a board-scoped grant on its own board', () => {
    expect(roleAppliesToBoard(kilterLeader, 'kilter')).toBe(true);
    expect(roleAppliesToBoard(kilterLeader, 'tension')).toBe(false);
  });

  it('does not let a board-scoped grant answer an unscoped check', () => {
    expect(roleAppliesToBoard(kilterLeader)).toBe(false);
    expect(roleAppliesToBoard(kilterLeader, null)).toBe(false);
  });
});

describe('a global admin', () => {
  it('is admin on any board', () => {
    expect(rolesGrantAdmin([globalAdmin], 'kilter')).toBe(true);
    expect(rolesGrantAdmin([globalAdmin], 'tension')).toBe(true);
    expect(rolesGrantAdmin([globalAdmin])).toBe(true);
  });

  it('clears the wider moderation gate too', () => {
    expect(rolesGrantAdminOrLeader([globalAdmin], 'kilter')).toBe(true);
    expect(rolesGrantAdminOrLeader([globalAdmin], 'moonboard')).toBe(true);
  });

  it('votes with the admin weight everywhere', () => {
    expect(voteWeightForRoles([globalAdmin], 'kilter')).toBe(ADMIN_VOTE_WEIGHT);
    expect(voteWeightForRoles([globalAdmin], 'tension')).toBe(ADMIN_VOTE_WEIGHT);
    expect(voteWeightForRoles([globalAdmin])).toBe(ADMIN_VOTE_WEIGHT);
  });
});

describe('a board-scoped community leader', () => {
  it('moderates its own board but is not an admin there', () => {
    expect(rolesGrantAdminOrLeader([kilterLeader], 'kilter')).toBe(true);
    expect(rolesGrantAdmin([kilterLeader], 'kilter')).toBe(false);
  });

  it('votes with the leader weight on its own board', () => {
    expect(voteWeightForRoles([kilterLeader], 'kilter')).toBe(LEADER_VOTE_WEIGHT);
  });

  it('grants nothing on a different board', () => {
    expect(rolesGrantAdminOrLeader([kilterLeader], 'tension')).toBe(false);
    expect(rolesGrantAdmin([kilterLeader], 'tension')).toBe(false);
    expect(voteWeightForRoles([kilterLeader], 'tension')).toBe(DEFAULT_VOTE_WEIGHT);
  });
});

describe('a global community leader', () => {
  it('moderates every board', () => {
    expect(rolesGrantAdminOrLeader([globalLeader], 'kilter')).toBe(true);
    expect(rolesGrantAdminOrLeader([globalLeader], 'tension')).toBe(true);
    expect(rolesGrantAdminOrLeader([globalLeader], 'moonboard')).toBe(true);
  });

  it('carries the leader weight on every board, but never admin', () => {
    expect(voteWeightForRoles([globalLeader], 'tension')).toBe(LEADER_VOTE_WEIGHT);
    expect(voteWeightForRoles([globalLeader])).toBe(LEADER_VOTE_WEIGHT);
    expect(rolesGrantAdmin([globalLeader], 'tension')).toBe(false);
  });
});

describe('roles with no authority', () => {
  it('gives a tester nothing beyond the default weight', () => {
    expect(rolesGrantAdmin([globalTester], 'kilter')).toBe(false);
    expect(rolesGrantAdminOrLeader([globalTester], 'kilter')).toBe(false);
    expect(voteWeightForRoles([globalTester], 'kilter')).toBe(DEFAULT_VOTE_WEIGHT);
  });

  it('gives a user with no roles at all nothing beyond the default weight', () => {
    expect(rolesGrantAdmin([], 'kilter')).toBe(false);
    expect(rolesGrantAdminOrLeader([], 'kilter')).toBe(false);
    expect(rolesGrantAdminOrLeader([])).toBe(false);
    expect(voteWeightForRoles([], 'kilter')).toBe(DEFAULT_VOTE_WEIGHT);
    expect(voteWeightForRoles([])).toBe(DEFAULT_VOTE_WEIGHT);
  });
});

describe('a user holding several roles', () => {
  it('takes the strongest in-scope role, so admin beats leader', () => {
    const adminAndLeader = [globalLeader, globalAdmin];
    expect(voteWeightForRoles(adminAndLeader, 'kilter')).toBe(ADMIN_VOTE_WEIGHT);
    expect(rolesGrantAdmin(adminAndLeader, 'kilter')).toBe(true);
  });

  it('ignores an out-of-scope admin and falls back to the in-scope leader', () => {
    const kilterAdminAndTensionLeader = [kilterAdmin, { role: 'community_leader', boardType: 'tension' }];
    expect(voteWeightForRoles(kilterAdminAndTensionLeader, 'tension')).toBe(LEADER_VOTE_WEIGHT);
    expect(rolesGrantAdmin(kilterAdminAndTensionLeader, 'tension')).toBe(false);
    expect(rolesGrantAdminOrLeader(kilterAdminAndTensionLeader, 'tension')).toBe(true);
  });

  it('ignores inert roles sitting alongside a real one', () => {
    expect(voteWeightForRoles([globalTester, kilterLeader], 'kilter')).toBe(LEADER_VOTE_WEIGHT);
  });
});
