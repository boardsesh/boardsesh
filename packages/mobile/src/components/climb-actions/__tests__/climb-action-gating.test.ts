import { describe, it, expect } from 'vitest';
import type { Climb } from '@boardsesh/shared-schema';
import { auroraAppUrlFor, resolveClimbActionIds, type ClimbActionGatingInput } from '../climb-action-gating';

// The pure rule both menus read. The overlay's own suite (use-climb-actions)
// drives it through the hook; these pin the cases the native menu leans on.
const climb = { uuid: 'climb-1', name: 'Test Climb', frames: 'p1r12' } as unknown as Climb;

const base: ClimbActionGatingInput = {
  climb,
  boardName: 'kilter',
  currentUserId: null,
  isAuthenticated: false,
  moderationEnabled: true,
  wallArchived: false,
  activeClimbUuid: null,
  hasOpenQueue: false,
  hasEditEntry: false,
};

describe('resolveClimbActionIds', () => {
  it('offers the universal actions to a signed-out climber on Kilter', () => {
    expect(resolveClimbActionIds(base)).toEqual([
      'preview',
      'queue',
      'playNext',
      'playlist',
      'favorite',
      'tick',
      'fork',
      'share',
    ]);
  });

  it('adds beta video and report once signed in', () => {
    const ids = resolveClimbActionIds({ ...base, currentUserId: 'user-2', isAuthenticated: true });
    expect(ids).toContain('betaVideo');
    expect(ids.at(-1)).toBe('report');
  });

  it('drops report behind the moderation kill switch', () => {
    const ids = resolveClimbActionIds({ ...base, isAuthenticated: true, moderationEnabled: false });
    expect(ids).not.toContain('report');
  });

  it('hides "Play next" on the climb already on the wall', () => {
    expect(resolveClimbActionIds({ ...base, activeClimbUuid: 'climb-1' })).not.toContain('playNext');
  });

  it('never shares or reports a draft', () => {
    const draft = { ...climb, is_draft: true } as unknown as Climb;
    const ids = resolveClimbActionIds({ ...base, climb: draft, isAuthenticated: true });
    expect(ids).not.toContain('share');
    expect(ids).not.toContain('report');
  });

  it('offers edit entry and open queue only when the caller hosts them', () => {
    expect(resolveClimbActionIds({ ...base, hasEditEntry: true, hasOpenQueue: true })).toEqual(
      expect.arrayContaining(['editEntry', 'openQueue']),
    );
  });

  it('gives the setter of a spray climb edit, change-grade report and delete, but none on an archived wall', () => {
    const own = {
      ...climb,
      userId: 'user-1',
      is_draft: false,
      published_at: new Date().toISOString(),
    } as unknown as Climb;
    const spray = { ...base, climb: own, boardName: 'spray', currentUserId: 'user-1', isAuthenticated: true };
    expect(resolveClimbActionIds(spray)).toEqual(expect.arrayContaining(['edit', 'fork', 'report', 'delete']));
    const archived = resolveClimbActionIds({ ...spray, wallArchived: true });
    expect(archived).not.toContain('edit');
    expect(archived).not.toContain('fork');
    expect(archived).not.toContain('delete');
  });
});

describe('auroraAppUrlFor', () => {
  it('links Tension to its app and gives Kilter and MoonBoard nothing', () => {
    expect(auroraAppUrlFor('tension', 'abc')).toBe('https://tensionboardapp2.com/climbs/abc');
    expect(auroraAppUrlFor('kilter', 'abc')).toBeNull();
    expect(auroraAppUrlFor('moonboard', 'abc')).toBeNull();
  });
});
