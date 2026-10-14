import { describe, expect, it, vi } from 'vitest';
import { buildStorageModel, type StorageModelInput } from '../storage-model';
import type { MoreButtonRow, MoreRow, MoreValueRow } from '../../MoreForm.types';

function makeInput(overrides: Partial<StorageModelInput> = {}): StorageModelInput {
  return {
    // Echo the key plus any interpolation, so a test can assert WHICH string was
    // chosen and what went into it without a real catalog.
    t: (key, options) => (options ? `${key}:${JSON.stringify(options)}` : key),
    formatSize: (bytes) => `${bytes} B`,
    offlineEnabled: true,
    totalBytes: 1000,
    freeBytes: 5000,
    reclaimableBytes: 0,
    showReclaimable: false,
    cachedImages: { artBytes: 10, photoBytes: 20, leftoverSnapshotBytes: 0 },
    boards: [
      {
        scopeKey: 'kilter:1:5',
        title: 'Kilter Board Original',
        subtitle: 'Kilter · 12 x 14',
        caption: 'About 180 MB · 41,000 climbs',
        statusLabel: 'Kept offline',
      },
    ],
    removingScopeKey: null,
    isRemovingAll: false,
    isCompacting: false,
    isClearingCache: false,
    onRemoveBoard: vi.fn(),
    onRemoveAll: vi.fn(),
    onCompact: vi.fn(),
    onClearCachedImages: vi.fn(),
    ...overrides,
  };
}

function rowByKey(input: StorageModelInput, key: string): MoreRow {
  const row = buildStorageModel(input)
    .sections.flatMap((section) => section.rows)
    .find((candidate) => candidate.key === key);
  if (!row) throw new Error(`no row ${key}`);
  return row;
}

function buttonRow(input: StorageModelInput, key: string): MoreButtonRow {
  const row = rowByKey(input, key);
  if (row.kind !== 'button') throw new Error(`${key} is not a button`);
  return row;
}

function valueRow(input: StorageModelInput, key: string): MoreValueRow {
  const row = rowByKey(input, key);
  if (row.kind !== 'value') throw new Error(`${key} is not a value row`);
  return row;
}

describe('buildStorageModel — layout', () => {
  it('leads with the measured total, then cached images, the boards and the remove-all action', () => {
    expect(buildStorageModel(makeInput()).sections.map((section) => section.key)).toEqual([
      'usage',
      'cachedImages',
      'boards',
      'removeAll',
    ]);
  });

  it('puts reserved space above the boards when a compaction has not landed', () => {
    const model = buildStorageModel(makeInput({ showReclaimable: true, reclaimableBytes: 64 }));
    expect(model.sections.map((section) => section.key)).toEqual([
      'usage',
      'reserved',
      'cachedImages',
      'boards',
      'removeAll',
    ]);
    expect(model.sections[1].footer).toBe('mobile.settings.storage.reservedNote:{"size":"64 B"}');
  });

  it('keeps the intro as the first footer and adds the off note when downloads are switched off', () => {
    expect(buildStorageModel(makeInput()).sections[0].footer).toBe('mobile.settings.storage.intro');
    expect(buildStorageModel(makeInput({ offlineEnabled: false })).sections[0].footer).toBe(
      'mobile.settings.storage.intro\n\nmobile.settings.storage.offNote',
    );
  });

  it('shows the free-space row only when the platform can measure it', () => {
    expect(valueRow(makeInput(), 'free').value).toBe('5000 B');
    expect(() => rowByKey(makeInput({ freeBytes: null }), 'free')).toThrow();
  });

  it('omits the photos row (never 0 B) when the photo cache could not be found', () => {
    const input = makeInput({ cachedImages: { artBytes: 10, photoBytes: null, leftoverSnapshotBytes: 0 } });
    expect(valueRow(input, 'cachedArt').value).toBe('10 B');
    expect(() => rowByKey(input, 'cachedPhotos')).toThrow();
    expect(buttonRow(input, 'clearCachedImages').role).toBe('destructive');
  });

  it('drops the cached-images section where there is no cache directory to measure', () => {
    const keys = buildStorageModel(makeInput({ cachedImages: null })).sections.map((section) => section.key);
    expect(keys).not.toContain('cachedImages');
  });

  it('says there are no boards, with no remove-all, when only reserved space or caches are left', () => {
    const model = buildStorageModel(makeInput({ boards: [], showReclaimable: true, reclaimableBytes: 64 }));
    const boards = model.sections.find((section) => section.key === 'boards');
    expect(boards?.rows).toEqual([]);
    expect(boards?.footer).toBe('mobile.settings.storage.emptySubtitle');
    expect(model.sections.map((section) => section.key)).not.toContain('removeAll');
  });
});

describe('buildStorageModel — boards', () => {
  it('shows each board with its size, footprint and offline status, and removes it on tap', () => {
    const input = makeInput();
    const board = valueRow(input, 'board:kilter:1:5');
    expect(board.label).toBe('Kilter Board Original');
    expect(board.subtitle).toBe('Kilter · 12 x 14\nAbout 180 MB · 41,000 climbs\nKept offline');
    board.onPress?.();
    expect(input.onRemoveBoard).toHaveBeenCalledWith('kilter:1:5');
  });

  it('tells a screen reader that a tap removes the board, by name', () => {
    const board = valueRow(makeInput(), 'board:kilter:1:5');
    expect(board.accessibilityHint).toBe('mobile.settings.storage.removeAria:{"name":"Kilter Board Original"}');
  });

  it('tells the climber a tap removes a board', () => {
    const boards = buildStorageModel(makeInput()).sections.find((section) => section.key === 'boards');
    expect(boards?.footer).toBe('mobile.settings.storage.tapToRemove mobile.settings.storage.estimateNote');
  });

  it('spins the board being removed and makes no board tappable meanwhile', () => {
    const input = makeInput({
      removingScopeKey: 'kilter:1:5',
      boards: [
        ...makeInput().boards,
        { scopeKey: 'tension:9:1', title: 'Tension', subtitle: 's', caption: 'c', statusLabel: 'x' },
      ],
    });
    expect(valueRow(input, 'board:kilter:1:5').busy).toBe(true);
    expect(valueRow(input, 'board:kilter:1:5').onPress).toBeUndefined();
    expect(valueRow(input, 'board:tension:9:1').busy).toBe(false);
    expect(valueRow(input, 'board:tension:9:1').onPress).toBeUndefined();
    // No hint promising a removal a tap won't do.
    expect(valueRow(input, 'board:tension:9:1').accessibilityHint).toBeUndefined();
    expect(buttonRow(input, 'removeAll').disabled).toBe(true);
    expect(buttonRow(input, 'clearCachedImages').disabled).toBe(true);
  });

  it.each([
    ['isCompacting', { isCompacting: true }],
    ['isClearingCache', { isClearingCache: true }],
    ['isRemovingAll', { isRemovingAll: true }],
  ] as const)('locks the board rows while %s', (_label, busy) => {
    expect(valueRow(makeInput(busy), 'board:kilter:1:5').onPress).toBeUndefined();
  });
});

describe('buildStorageModel — actions', () => {
  it('makes Remove all a destructive action in the last section, spinning while it runs', () => {
    const model = buildStorageModel(makeInput({ isRemovingAll: true }));
    const last = model.sections[model.sections.length - 1];
    expect(last.key).toBe('removeAll');
    const removeAll = last.rows[0];
    expect(removeAll.kind === 'button' && removeAll.role).toBe('destructive');
    expect(removeAll.kind === 'button' && removeAll.loading).toBe(true);
  });

  it('greys out Remove all while a single board or a compaction is running', () => {
    expect(buttonRow(makeInput({ removingScopeKey: 'kilter:1:5' }), 'removeAll').disabled).toBe(true);
    expect(buttonRow(makeInput({ isCompacting: true }), 'removeAll').disabled).toBe(true);
    expect(buttonRow(makeInput(), 'removeAll').disabled).toBe(false);
  });

  it('labels Compact with the size it frees and locks it during a removal', () => {
    const input = makeInput({ showReclaimable: true, reclaimableBytes: 64, isRemovingAll: true });
    const compact = buttonRow(input, 'compact');
    expect(compact.label).toBe('mobile.settings.storage.compact:{"size":"64 B"}');
    expect(compact.disabled).toBe(true);
    expect(compact.role).toBeUndefined();
  });

  it('spins Clear cached images while it runs and hands taps to the screen', () => {
    const input = makeInput({ isClearingCache: true });
    expect(buttonRow(input, 'clearCachedImages').loading).toBe(true);
    const idle = makeInput();
    buttonRow(idle, 'clearCachedImages').onPress();
    expect(idle.onClearCachedImages).toHaveBeenCalledTimes(1);
  });
});
