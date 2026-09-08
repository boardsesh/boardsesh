import { describe, expect, it } from 'vitest';
import { createMemoryCollector, MEMORY_LIMITS, parseMemoryCommand, type MemoryCommand } from '../memory-collector';
const command: MemoryCommand = {
  schemaVersion: 1,
  commandId: 'first',
  cycle: 1,
  surface: 'list',
  phase: 'settled',
  action: 'begin',
};
const drained = { overlayIndexSize: 200, pendingRenders: 0, queuedRenders: 0, dispatchedRenders: 0 };
describe('bounded memory observations', () => {
  it('copies only allowed scalar command fields and rejects unbounded identifiers', () => {
    expect(parseMemoryCommand({ ...command, climb: { uuid: 'hidden' } })).not.toHaveProperty('climb');
    expect(parseMemoryCommand({ ...command, targetUuid: { climb: 'object' }, targetIndex: [] })).toMatchObject({
      targetUuid: undefined,
      targetIndex: undefined,
    });
    expect(parseMemoryCommand({ ...command, commandId: 'x'.repeat(513) })).toBeNull();
    expect(parseMemoryCommand({ ...command, expectedUuids: Array(401).fill('uuid') })).toBeNull();
  });
  it('does not record mounted rows as visible and updates recycled UUIDs', () => {
    const collector = createMemoryCollector(true, 'process');
    collector.begin(command);
    collector.incidental('row-prefetch', 'prefetched');
    collector.visible('row', 'list', ['old']);
    collector.visible('row', 'list', ['new']);
    collector.visible('player', 'carousel', ['other-surface']);
    const captured = collector.snapshot(command, drained);
    expect(captured.actualVisibleUuids).toEqual(['old', 'new']);
    expect(captured.incidentalUuids).toEqual(['prefetched']);
    captured.actualVisibleUuids.push('mutation');
    expect(collector.snapshot(command, drained).actualVisibleUuids).toEqual(['old', 'new']);
    collector.begin({ ...command, cycle: 2 });
    expect(collector.snapshot({ ...command, cycle: 2 }, drained).actualVisibleUuids).toEqual(['new']);
    collector.visible('row', 'list', []);
    collector.begin(command);
    expect(collector.snapshot(command, drained).actualVisibleUuids).toEqual([]);
  });
  it('seeds current render keys across replay cycles and releases recycled owners', () => {
    const collector = createMemoryCollector(true, 'process');
    collector.rendered('owner', 'old');
    collector.rendered('owner', 'current');
    collector.rendered('gone', 'disposed');
    collector.rendered('gone', null);
    collector.begin(command);
    expect(collector.snapshot(command, drained).renderKeys).toEqual(['current']);
    collector.rendered('owner', 'recycled');
    expect(collector.snapshot(command, drained).renderKeys).toEqual(['current', 'recycled']);
  });
  it('invalidates overflow and never lets begin make dropped observations trustworthy', () => {
    const collector = createMemoryCollector(true, 'process');
    collector.begin(command);
    for (let index = 0; index <= MEMORY_LIMITS.identifiers; index += 1)
      collector.incidental('recycled-owner', `uuid-${index}`);
    expect(collector.snapshot(command, drained).incidentalUuids).toHaveLength(MEMORY_LIMITS.identifiers);
    collector.begin(command);
    expect(collector.snapshot(command, drained).invalidReasons).toContain('diagnostic-overflow');
  });
  it('counts only mounted image layers and bounds owners', () => {
    const collector = createMemoryCollector(true, 'process');
    collector.begin(command);
    collector.image('first', 3);
    collector.image('second', 2);
    collector.image('first', 0);
    expect(collector.snapshot(command, drained)).toMatchObject({ mountedImages: 2, mountedImageSurfaces: 1 });
    for (let index = 0; index <= MEMORY_LIMITS.surfaces; index += 1) collector.image(`owner-${index}`, 1);
    expect(collector.snapshot(command, drained).mountedImageSurfaces).toBe(MEMORY_LIMITS.surfaces);
    expect(collector.snapshot(command, drained).valid).toBe(false);
  });
  it('requires actual background and rejects an old clear completing in a new generation', () => {
    const collector = createMemoryCollector(true, 'process');
    collector.begin(command);
    const background = { ...command, phase: 'background' as const };
    collector.appState('inactive');
    expect(collector.snapshot(background, drained).valid).toBe(false);
    collector.appState('background');
    const oldGeneration = collector.clearStarted();
    collector.appState('active');
    collector.appState('background');
    const newGeneration = collector.clearStarted();
    collector.clearCompleted(oldGeneration, true);
    expect(collector.snapshot(background, drained).valid).toBe(false);
    collector.clearCompleted(newGeneration, true);
    expect(collector.snapshot(background, drained).valid).toBe(true);
  });
  it('rejects process replacement, missing visits, incomplete drain, timeout and wrong Home route', () => {
    const collector = createMemoryCollector(true, 'process');
    collector.begin(command);
    expect(collector.snapshot({ ...command, runId: 'previous' }, drained).invalidReasons).toContain('process-replaced');
    expect(collector.snapshot({ ...command, phase: 'browsed', expectedUuids: ['missing'] }, drained).valid).toBe(false);
    expect(collector.snapshot(command, { ...drained, pendingRenders: 1 }).invalidReasons).toContain('pending-renders');
    expect(collector.snapshot(command, drained, true).invalidReasons).toContain('checkpoint-timeout');
    expect(collector.snapshot({ ...command, phase: 'home' }, drained).valid).toBe(false);
    collector.route('(tabs)/home');
    expect(collector.snapshot({ ...command, phase: 'home' }, drained).valid).toBe(true);
  });
  it('exports actual board/account/render context and isolates its scalar copy', () => {
    const collector = createMemoryCollector(true, 'process');
    const board = { name: 'tension', layoutId: 9, sizeId: 7, setIds: '12,13', angle: 40 };
    collector.board(board);
    collector.account('authenticated-profile-id');
    collector.rendered('surface', 'key', 'aura');
    collector.begin(command);
    board.angle = 50;
    const captured = collector.snapshot(command, drained);
    expect(captured).toMatchObject({
      board: { ...board, angle: 40 },
      accountId: 'authenticated-profile-id',
      renderModes: ['aura'],
    });
    captured.board!.angle = 60;
    expect(collector.snapshot(command, drained).board?.angle).toBe(40);
    collector.account(null);
    expect(collector.snapshot(command, drained).accountId).toBeNull();
  });
  it('validates carousel setup scroll against the actual list viewport without counting it as a carousel visit', () => {
    const collector = createMemoryCollector(true, 'process');
    const carousel = { ...command, surface: 'carousel' as const };
    collector.begin(carousel);
    collector.visible('list', 'list', ['target']);
    const scroll = { ...carousel, action: 'scroll' as const, targetUuid: 'target', targetIndex: 0 };
    expect(collector.snapshot(scroll, drained)).toMatchObject({ valid: true, actualVisibleUuids: [] });
    expect(collector.snapshot({ ...scroll, action: 'open' }, drained).valid).toBe(false);
    collector.visible('carousel', 'carousel', ['target']);
    expect(collector.snapshot({ ...scroll, action: 'open' }, drained)).toMatchObject({
      valid: true,
      actualVisibleUuids: ['target'],
    });
  });

  it('records nothing when disabled', () => {
    const collector = createMemoryCollector(false, 'disabled');
    collector.begin(command);
    collector.visible('row', 'list', ['climb']);
    collector.image('row', 1);
    collector.rendered('row', 'key');
    expect(collector.snapshot(command, drained)).toMatchObject({
      actualVisibleUuids: [],
      renderKeys: [],
      mountedImages: 0,
    });
  });
});
