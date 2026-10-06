import { describe, expect, it } from 'vitest';
import {
  isSprayShortcutId,
  resolvePencilGesture,
  resolveSprayShortcut,
  SPRAY_SHORTCUTS,
  sprayShortcutCommands,
  type SprayShortcutContext,
  type SprayShortcutId,
} from '../spray-editor-shortcuts';

const TITLES: Record<SprayShortcutId, string> = {
  undo: 'Undo',
  redo: 'Redo',
  delete: 'Switch off or delete hold',
  escape: 'Cancel',
  add: 'Add missing holds',
  smaller: 'Make smaller',
  bigger: 'Make bigger',
  previous: 'Previous hold',
  next: 'Next hold',
  primary: 'Pick a look',
};

/** The resting editor with an ON ring picked and everything allowed. */
const RESTING: SprayShortcutContext = {
  canEdit: true,
  tool: 'edit',
  selectedRole: 'on',
  canUndo: true,
  canRedo: true,
  canStep: true,
  primaryReady: true,
  popoverOpen: false,
};

describe('the shortcut map', () => {
  it('never gives two shortcuts the same key and modifiers', () => {
    const chords = SPRAY_SHORTCUTS.flatMap(({ keys }) =>
      keys.map((key) => `${[...key.modifiers].sort().join('+')}|${key.input}`),
    );
    expect(new Set(chords).size).toBe(chords.length);
  });

  it('titles only the first key of each shortcut, so the Cmd-hold overlay lists it once', () => {
    const commands = sprayShortcutCommands(TITLES);
    const titled = commands.filter((command) => command.title !== '');
    expect(titled.map((command) => command.id)).toEqual(SPRAY_SHORTCUTS.map((shortcut) => shortcut.id));
    expect(commands.find((command) => command.input === 'delete')).toMatchObject({ id: 'delete', title: '' });
    expect(commands.find((command) => command.input === 'backspace')).toMatchObject({
      id: 'delete',
      title: 'Switch off or delete hold',
    });
    expect(commands.find((command) => command.id === 'primary')).toMatchObject({
      input: 'return',
      modifiers: ['command'],
      title: 'Pick a look',
    });
  });

  it('accepts only its own ids back from the native view', () => {
    expect(isSprayShortcutId('undo')).toBe(true);
    expect(isSprayShortcutId('primary')).toBe(true);
    expect(isSprayShortcutId('save')).toBe(false);
    expect(isSprayShortcutId('')).toBe(false);
  });
});

describe('resolveSprayShortcut', () => {
  it('runs the buttons the resting editor has', () => {
    expect(resolveSprayShortcut('undo', RESTING)).toBe('undo');
    expect(resolveSprayShortcut('redo', RESTING)).toBe('redo');
    expect(resolveSprayShortcut('add', RESTING)).toBe('toggleAdd');
    expect(resolveSprayShortcut('smaller', RESTING)).toBe('shrink');
    expect(resolveSprayShortcut('bigger', RESTING)).toBe('grow');
    expect(resolveSprayShortcut('previous', RESTING)).toBe('previous');
    expect(resolveSprayShortcut('next', RESTING)).toBe('next');
    expect(resolveSprayShortcut('primary', RESTING)).toBe('primary');
  });

  it('takes two presses of Delete to remove a ring, as the chips do', () => {
    expect(resolveSprayShortcut('delete', RESTING)).toBe('switchOff');
    expect(resolveSprayShortcut('delete', { ...RESTING, selectedRole: 'maybe' })).toBe('switchOff');
    expect(resolveSprayShortcut('delete', { ...RESTING, selectedRole: 'off' })).toBe('delete');
    expect(resolveSprayShortcut('delete', { ...RESTING, selectedRole: null })).toBe('none');
  });

  it('backs out one step at a time with Escape', () => {
    expect(resolveSprayShortcut('escape', { ...RESTING, popoverOpen: true, tool: 'add' })).toBe('closePopover');
    expect(resolveSprayShortcut('escape', { ...RESTING, tool: 'add' })).toBe('leaveAdd');
    expect(resolveSprayShortcut('escape', { ...RESTING, tool: 'trace' })).toBe('cancelTool');
    expect(resolveSprayShortcut('escape', { ...RESTING, tool: 'join' })).toBe('cancelTool');
    expect(resolveSprayShortcut('escape', RESTING)).toBe('deselect');
    expect(resolveSprayShortcut('escape', { ...RESTING, selectedRole: null })).toBe('none');
  });

  it('does nothing to the wall while it is locked, but still closes a popover', () => {
    const locked = { ...RESTING, canEdit: false };
    for (const { id } of SPRAY_SHORTCUTS) {
      if (id === 'escape') continue;
      expect(resolveSprayShortcut(id, locked)).toBe('none');
    }
    expect(resolveSprayShortcut('escape', locked)).toBe('none');
    expect(resolveSprayShortcut('escape', { ...locked, popoverOpen: true })).toBe('closePopover');
  });

  it('keeps the hold keys to the resting tool and a picked ring', () => {
    const adding = { ...RESTING, tool: 'add' as const };
    expect(resolveSprayShortcut('delete', adding)).toBe('none');
    expect(resolveSprayShortcut('smaller', adding)).toBe('none');
    expect(resolveSprayShortcut('next', adding)).toBe('none');
    expect(resolveSprayShortcut('bigger', { ...RESTING, selectedRole: null })).toBe('none');
    expect(resolveSprayShortcut('next', { ...RESTING, canStep: false })).toBe('none');
  });

  it('follows the buttons being disabled', () => {
    expect(resolveSprayShortcut('undo', { ...RESTING, canUndo: false })).toBe('none');
    expect(resolveSprayShortcut('redo', { ...RESTING, canRedo: false })).toBe('none');
    expect(resolveSprayShortcut('primary', { ...RESTING, primaryReady: false })).toBe('none');
  });
});

describe('resolvePencilGesture', () => {
  const ipad = { tablet: true, canEdit: true, tool: 'edit' as const };

  it('swaps between Mark and Add for the switch settings', () => {
    expect(resolvePencilGesture('switchEraser', ipad)).toBe('add');
    expect(resolvePencilGesture('switchPrevious', ipad)).toBe('add');
    expect(resolvePencilGesture('switchEraser', { ...ipad, tool: 'add' })).toBe('mark');
    expect(resolvePencilGesture('switchPrevious', { ...ipad, tool: 'trace' })).toBe('mark');
  });

  it('opens the palette for the palette settings', () => {
    expect(resolvePencilGesture('showContextualPalette', ipad)).toBe('palette');
    expect(resolvePencilGesture('showColorPalette', ipad)).toBe('palette');
    expect(resolvePencilGesture('showInkAttributes', { ...ipad, tool: 'add' })).toBe('palette');
  });

  it('leaves Ignore, a system shortcut and an unknown setting alone', () => {
    expect(resolvePencilGesture('ignore', ipad)).toBe('none');
    expect(resolvePencilGesture('runSystemShortcut', ipad)).toBe('none');
    expect(resolvePencilGesture('unknown', ipad)).toBe('none');
  });

  it('does nothing off the iPad layout or while the wall is locked', () => {
    expect(resolvePencilGesture('switchEraser', { ...ipad, tablet: false })).toBe('none');
    expect(resolvePencilGesture('showContextualPalette', { ...ipad, canEdit: false })).toBe('none');
  });
});
