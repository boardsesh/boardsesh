// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBoardBuilder } from '../use-board-builder';

// Kilter layout 1 = "Original"; selecting it auto-picks a default size + all its
// sets, which is the behaviour that lets the per-set toggles stay behind Advanced.
describe('useBoardBuilder', () => {
  it('auto-selects a size and all its sets when a layout is picked, satisfying canCreate', () => {
    const { result } = renderHook(() => useBoardBuilder());
    expect(result.current.canCreate).toBe(false);

    act(() => result.current.selectBoard('kilter'));
    act(() => result.current.selectLayout(1));

    expect(result.current.layoutId).toBe(1);
    expect(result.current.sizeId).not.toBeNull();
    expect(result.current.setIds.length).toBeGreaterThan(0);
    expect(result.current.canCreate).toBe(true);
  });

  // Woods ships one synthetic hold set. If the cascade returned no sets, the
  // builder's `setIds.length > 0` gate would keep Create disabled forever.
  it('auto-selects the single Woods set and defaults to the 12x12 board', () => {
    const { result } = renderHook(() => useBoardBuilder());

    act(() => result.current.selectBoard('woods'));
    act(() => result.current.selectLayout(1));

    expect(result.current.sizeId).toBe(2);
    expect(result.current.setIds).toEqual([1]);
    expect(result.current.canCreate).toBe(true);

    act(() => result.current.selectSize(1));
    expect(result.current.setIds).toEqual([1]);
    expect(result.current.canCreate).toBe(true);
    expect(result.current.buildCreateInput()).toMatchObject({
      boardType: 'woods',
      layoutId: 1,
      sizeId: 1,
      setIds: '1',
    });
  });

  it('resets downstream selections when the board changes', () => {
    const { result } = renderHook(() => useBoardBuilder());
    act(() => result.current.selectBoard('kilter'));
    act(() => result.current.selectLayout(1));
    expect(result.current.canCreate).toBe(true);

    act(() => result.current.selectBoard('tension'));

    expect(result.current.layoutId).toBeNull();
    expect(result.current.sizeId).toBeNull();
    expect(result.current.setIds).toEqual([]);
    expect(result.current.canCreate).toBe(false);
  });

  it('builds a create input carrying serial + visibility from More options', () => {
    const { result } = renderHook(() => useBoardBuilder());
    act(() => result.current.selectBoard('kilter'));
    act(() => result.current.selectLayout(1));
    act(() => {
      result.current.setSerialNumber('SN-1');
      result.current.setIsPublic(false);
      result.current.setName('Garage');
    });

    const input = result.current.buildCreateInput();
    expect(input).not.toBeNull();
    expect(input?.serialNumber).toBe('SN-1');
    expect(input?.isPublic).toBe(false);
    expect(input?.name).toBe('Garage');
    expect(input?.isOwned).toBe(true);
    // Angle-adjustable defaults on (most home boards tilt).
    expect(input?.isAngleAdjustable).toBe(true);
  });

  it('toggles isAngleAdjustable independently of the default angle', () => {
    const { result } = renderHook(() => useBoardBuilder());
    act(() => result.current.selectBoard('kilter'));
    act(() => result.current.selectLayout(1));
    act(() => result.current.setIsAngleAdjustable(false));
    expect(result.current.buildCreateInput()?.isAngleAdjustable).toBe(false);
  });

  it('defaults hasLeds on and carries it into both inputs', () => {
    const { result } = renderHook(() => useBoardBuilder());
    act(() => result.current.selectBoard('kilter'));
    act(() => result.current.selectLayout(1));

    // Almost every Kilter/Tension wall ships with a light kit, so the create
    // flow must not ask the 99% case to think about it.
    expect(result.current.hasLeds).toBe(true);
    expect(result.current.buildCreateInput()?.hasLeds).toBe(true);
    expect(result.current.buildUpdateInput('board-uuid-1')?.hasLeds).toBe(true);

    act(() => result.current.setHasLeds(false));
    expect(result.current.buildCreateInput()?.hasLeds).toBe(false);
    expect(result.current.buildUpdateInput('board-uuid-1')?.hasLeds).toBe(false);
  });

  it('keeps a seeded hasLeds=false across re-renders', () => {
    // A fresh seed object every render, like an unmemoised prop: the meta seeds
    // run once in the useState initialisers, so a re-render can't reset the flag.
    const { result, rerender } = renderHook(() =>
      useBoardBuilder({ boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '20,1', hasLeds: false }),
    );
    expect(result.current.hasLeds).toBe(false);

    rerender();

    expect(result.current.hasLeds).toBe(false);
    expect(result.current.buildCreateInput()?.hasLeds).toBe(false);
  });

  // The no-LED toggle is purely additive: it must not hide the serial or the
  // timer. Both are submitted from retained state on every save, so a hidden
  // field would be a silent submit trap — and the Rogue workout timer isn't an
  // LED device in the first place.
  it('still submits the serial and the timer when hasLeds is off', () => {
    const { result } = renderHook(() =>
      useBoardBuilder({
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '20,1',
        hasLeds: false,
        serialNumber: 'SN-9',
        timerName: 'Rogue-1234',
      }),
    );

    const createInput = result.current.buildCreateInput();
    expect(createInput?.hasLeds).toBe(false);
    expect(createInput?.serialNumber).toBe('SN-9');
    expect(createInput?.timerName).toBe('Rogue-1234');

    const updateInput = result.current.buildUpdateInput('board-uuid-1');
    expect(updateInput?.hasLeds).toBe(false);
    expect(updateInput?.serialNumber).toBe('SN-9');
    expect(updateInput?.timerName).toBe('Rogue-1234');
  });

  it('returns a null create input before the config is complete', () => {
    const { result } = renderHook(() => useBoardBuilder());
    expect(result.current.buildCreateInput()).toBeNull();
  });

  it('pre-fills from a seed and normalises set order in the create input', () => {
    const { result } = renderHook(() =>
      useBoardBuilder({ boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '20,1' }),
    );
    expect(result.current.boardName).toBe('kilter');
    expect(result.current.layoutId).toBe(1);
    expect(result.current.sizeId).toBe(10);
    expect(result.current.canCreate).toBe(true);
    // Canonical (numeric-sorted) order so a re-ticked set matches an owned board.
    expect(result.current.buildCreateInput()?.setIds).toBe('1,20');
  });

  it('toggleSet removes then re-adds a set', () => {
    const { result } = renderHook(() => useBoardBuilder());
    act(() => result.current.selectBoard('kilter'));
    act(() => result.current.selectLayout(1));
    const first = result.current.setIds[0];
    expect(first).toBeDefined();

    act(() => result.current.toggleSet(first));
    expect(result.current.setIds).not.toContain(first);

    act(() => result.current.toggleSet(first));
    expect(result.current.setIds).toContain(first);
  });

  it('maps captured coords into the create input', () => {
    const { result } = renderHook(() => useBoardBuilder());
    act(() => result.current.selectBoard('kilter'));
    act(() => result.current.selectLayout(1));
    act(() => result.current.setCoords({ latitude: 1.5, longitude: -2.5 }));

    const input = result.current.buildCreateInput();
    expect(input?.latitude).toBe(1.5);
    expect(input?.longitude).toBe(-2.5);
  });

  it('applies the name precedence: typed name → fallbackName → cleaned layout name', () => {
    const { result } = renderHook(() => useBoardBuilder());
    act(() => result.current.selectBoard('kilter'));
    act(() => result.current.selectLayout(1));

    // Blank name + a fallback (e.g. the auto-generated name) → fallback.
    expect(result.current.buildCreateInput("Marco's Kilter")?.name).toBe("Marco's Kilter");
    // Blank name + no fallback → cleaned layout name ("Kilter Board Original" → "Original").
    expect(result.current.buildCreateInput()?.name).toBe('Original');

    // A typed name wins over the fallback.
    act(() => result.current.setName('Garage'));
    expect(result.current.buildCreateInput("Marco's Kilter")?.name).toBe('Garage');
  });

  it('pre-fills the More-options meta from a full (edit) seed', () => {
    const { result } = renderHook(() =>
      useBoardBuilder({
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '20,1',
        name: 'Garage Wall',
        isPublic: false,
        isUnlisted: true,
        isOwned: false,
        isAngleAdjustable: false,
        locationName: 'Garage',
        serialNumber: 'SN-9',
        latitude: 1.5,
        longitude: -2.5,
      }),
    );
    expect(result.current.name).toBe('Garage Wall');
    expect(result.current.isPublic).toBe(false);
    expect(result.current.isUnlisted).toBe(true);
    expect(result.current.isOwned).toBe(false);
    expect(result.current.isAngleAdjustable).toBe(false);
    expect(result.current.locationName).toBe('Garage');
    expect(result.current.serialNumber).toBe('SN-9');
    expect(result.current.coords).toEqual({ latitude: 1.5, longitude: -2.5 });
  });

  it('builds an update input carrying the uuid, meta, and normalised config', () => {
    const { result } = renderHook(() =>
      useBoardBuilder({
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '20,1',
        name: 'Garage',
        isPublic: false,
      }),
    );
    const input = result.current.buildUpdateInput('board-uuid-1');
    expect(input?.boardUuid).toBe('board-uuid-1');
    expect(input?.name).toBe('Garage');
    expect(input?.isPublic).toBe(false);
    // Config is sent (not locked) and numerically normalised.
    expect(input?.layoutId).toBe(1);
    expect(input?.sizeId).toBe(10);
    expect(input?.setIds).toBe('1,20');
  });

  it('omits the config from the update input when locked (board has ticks)', () => {
    const { result } = renderHook(() =>
      useBoardBuilder({ boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '20,1' }),
    );
    const input = result.current.buildUpdateInput('board-uuid-1', { lockedConfig: true });
    expect(input?.boardUuid).toBe('board-uuid-1');
    // Editable meta still present...
    expect(input?.name).toBeDefined();
    // ...but the config keys are omitted so the server's tick guard isn't tripped.
    expect(input?.layoutId).toBeUndefined();
    expect(input?.sizeId).toBeUndefined();
    expect(input?.setIds).toBeUndefined();
  });

  it('returns a null update input before the config is complete', () => {
    const { result } = renderHook(() => useBoardBuilder());
    expect(result.current.buildUpdateInput('board-uuid-1')).toBeNull();
  });

  // Without this the form resent the board's own config on every save, the server
  // read that as a config change and ran its duplicate guard — so an owner of two
  // same-config boards could not even rename one of them.
  it('omits the config from the update input when it matches the board on file', () => {
    const { result } = renderHook(() =>
      useBoardBuilder({ boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '20,1' }),
    );
    const input = result.current.buildUpdateInput('board-uuid-1', {
      currentConfig: { layoutId: 1, sizeId: 10, setIds: '20,1' },
    });
    expect(input?.name).toBeDefined();
    expect(input?.layoutId).toBeUndefined();
    expect(input?.sizeId).toBeUndefined();
    expect(input?.setIds).toBeUndefined();
  });

  it('treats a reordered stored setIds as unchanged', () => {
    // Stored order is whatever the board was created with, so the comparison has
    // to normalise both sides or every save of an old board looks like a change.
    const { result } = renderHook(() =>
      useBoardBuilder({ boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '20,1' }),
    );
    const input = result.current.buildUpdateInput('board-uuid-1', {
      currentConfig: { layoutId: 1, sizeId: 10, setIds: '1,20' },
    });
    expect(input?.setIds).toBeUndefined();
  });

  it('includes the config when it differs from the board on file', () => {
    const { result } = renderHook(() =>
      useBoardBuilder({ boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '20,1' }),
    );
    const input = result.current.buildUpdateInput('board-uuid-1', {
      currentConfig: { layoutId: 1, sizeId: 11, setIds: '20,1' },
    });
    expect(input?.layoutId).toBe(1);
    expect(input?.sizeId).toBe(10);
    expect(input?.setIds).toBe('1,20');
  });

  it('includes the config when no current config is supplied', () => {
    const { result } = renderHook(() =>
      useBoardBuilder({ boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '20,1' }),
    );
    const input = result.current.buildUpdateInput('board-uuid-1');
    expect(input?.layoutId).toBe(1);
    expect(input?.sizeId).toBe(10);
    expect(input?.setIds).toBe('1,20');
  });
});
