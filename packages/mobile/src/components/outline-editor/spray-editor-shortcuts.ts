/**
 * The hold editor's hardware-keyboard shortcuts and Apple Pencil gestures, as
 * pure data and two pure resolvers.
 *
 * The native half (`modules/spray-editor-input`) only turns keys into ids: it
 * registers whatever list `sprayShortcutCommands` builds (as `UIKeyCommand`s on
 * iOS, a key matcher on Android) and reports which one was pressed. Everything
 * about what a shortcut DOES lives here, so it ships by OTA and both platforms
 * share it: `resolveSprayShortcut` turns an id and the editor's state into one
 * action, and the screen runs the handler its own buttons already run. A
 * shortcut never reaches past what a button could do at that moment — Delete
 * on an ON ring switches it off first, exactly as the chip bar asks.
 */
import type {
  NativeShortcutCommand,
  PencilPreferredAction,
  SprayShortcutModifier,
} from '../../../modules/spray-editor-input/src/index';
import type { SprayEditorTool } from './spray-edit-tap';
import type { SprayHoldRole } from './spray-hold-editor-reducer';

export type SprayShortcutId =
  | 'undo'
  | 'redo'
  | 'delete'
  | 'escape'
  | 'add'
  | 'smaller'
  | 'bigger'
  | 'previous'
  | 'next'
  | 'primary';

type SprayShortcutKey = { input: string; modifiers: readonly SprayShortcutModifier[] };

/**
 * Every shortcut, with its keys. The FIRST key is the one the iPad's Cmd-hold
 * overlay lists; the others are alternates for the same action (forward Delete
 * next to Backspace, a keypad `+` next to `=`), registered without a title so
 * the overlay does not show the action twice.
 */
export const SPRAY_SHORTCUTS: readonly { id: SprayShortcutId; keys: readonly SprayShortcutKey[] }[] = [
  { id: 'undo', keys: [{ input: 'z', modifiers: ['command'] }] },
  { id: 'redo', keys: [{ input: 'z', modifiers: ['command', 'shift'] }] },
  {
    id: 'delete',
    keys: [
      { input: 'backspace', modifiers: [] },
      { input: 'delete', modifiers: [] },
    ],
  },
  { id: 'escape', keys: [{ input: 'escape', modifiers: [] }] },
  { id: 'add', keys: [{ input: 'a', modifiers: [] }] },
  { id: 'smaller', keys: [{ input: '-', modifiers: [] }] },
  {
    id: 'bigger',
    keys: [
      { input: '=', modifiers: [] },
      { input: '+', modifiers: [] },
    ],
  },
  { id: 'previous', keys: [{ input: '[', modifiers: [] }] },
  { id: 'next', keys: [{ input: ']', modifiers: [] }] },
  { id: 'primary', keys: [{ input: 'return', modifiers: ['command'] }] },
];

const SHORTCUT_IDS = new Set<string>(SPRAY_SHORTCUTS.map((shortcut) => shortcut.id));

/** An id the native view sent back, checked: a stale or foreign one is ignored. */
export function isSprayShortcutId(id: string): id is SprayShortcutId {
  return SHORTCUT_IDS.has(id);
}

/** The list the native view registers. `titles` is what the Cmd-hold overlay says for each. */
export function sprayShortcutCommands(titles: Readonly<Record<SprayShortcutId, string>>): NativeShortcutCommand[] {
  return SPRAY_SHORTCUTS.flatMap(({ id, keys }) =>
    keys.map((key, index) => ({
      id,
      input: key.input,
      modifiers: key.modifiers,
      title: index === 0 ? titles[id] : '',
    })),
  );
}

export type SprayShortcutContext = {
  /** The same lock the buttons have: read-only, a save in flight, the reveal still running. */
  canEdit: boolean;
  tool: SprayEditorTool;
  /** The picked ring's role, or null with nothing picked. */
  selectedRole: SprayHoldRole | null;
  canUndo: boolean;
  canRedo: boolean;
  /** There is more than one ring to step between. */
  canStep: boolean;
  /** The primary button would take a press: there are holds ON and no Corners outline open. */
  primaryReady: boolean;
  /** The Pencil palette or the wall-wide menu (rail or count capsule) is open. Escape closes it first. */
  popoverOpen: boolean;
};

export type SprayShortcutAction =
  | 'undo'
  | 'redo'
  | 'switchOff'
  | 'delete'
  | 'closePopover'
  | 'leaveAdd'
  | 'cancelTool'
  | 'deselect'
  | 'toggleAdd'
  | 'shrink'
  | 'grow'
  | 'previous'
  | 'next'
  | 'primary'
  | 'none';

/** What one shortcut does right now. `none` is a key the editor swallows without acting. */
export function resolveSprayShortcut(id: SprayShortcutId, context: SprayShortcutContext): SprayShortcutAction {
  const { canEdit, tool, selectedRole } = context;
  if (id === 'escape') {
    // Backing out of a popover never changes the wall, so it is allowed even
    // while the wall itself is locked.
    if (context.popoverOpen) return 'closePopover';
    if (!canEdit) return 'none';
    if (tool === 'add') return 'leaveAdd';
    if (tool === 'trace' || tool === 'join' || tool === 'refine') return 'cancelTool';
    return selectedRole != null ? 'deselect' : 'none';
  }
  if (!canEdit) return 'none';
  switch (id) {
    case 'undo':
      return context.canUndo ? 'undo' : 'none';
    case 'redo':
      return context.canRedo ? 'redo' : 'none';
    case 'delete':
      // Two presses to remove an ON ring, the same two steps the chips take:
      // the first leaves a ghost, the second deletes it.
      if (tool !== 'edit' || selectedRole == null) return 'none';
      return selectedRole === 'off' ? 'delete' : 'switchOff';
    case 'add':
      return 'toggleAdd';
    case 'smaller':
      return tool === 'edit' && selectedRole != null ? 'shrink' : 'none';
    case 'bigger':
      return tool === 'edit' && selectedRole != null ? 'grow' : 'none';
    case 'previous':
      return tool === 'edit' && context.canStep ? 'previous' : 'none';
    case 'next':
      return tool === 'edit' && context.canStep ? 'next' : 'none';
    case 'primary':
      return context.primaryReady ? 'primary' : 'none';
  }
}

export type PencilGestureAction = 'add' | 'mark' | 'refineSwitchMode' | 'palette' | 'none';

/**
 * What an Apple Pencil double tap or squeeze does, following the climber's own
 * Pencil setting in iPadOS Settings rather than overriding it.
 *
 * The switch settings ("Switch between current tool and eraser", "…and last
 * used") swap between Mark, the resting tool, and Add — the eraser of a hold
 * editor being the tool that is not marking. The palette settings open the
 * small tool palette. Inside Refine a switch setting flips the brush between
 * Add and Erase instead — there the eraser is a real eraser, and leaving the
 * tool would end the session. "Ignore" and a system shortcut are left alone: the
 * climber asked the Pencil to do nothing here, or iPadOS runs the shortcut
 * itself. iPad layout only, and never while the wall is locked.
 */
export function resolvePencilGesture(
  preferredAction: PencilPreferredAction,
  context: { tablet: boolean; canEdit: boolean; tool: SprayEditorTool },
): PencilGestureAction {
  if (!context.tablet || !context.canEdit) return 'none';
  switch (preferredAction) {
    case 'switchEraser':
    case 'switchPrevious':
      if (context.tool === 'refine') return 'refineSwitchMode';
      return context.tool === 'edit' ? 'add' : 'mark';
    case 'showColorPalette':
    case 'showInkAttributes':
    case 'showContextualPalette':
      return 'palette';
    default:
      // 'ignore', 'runSystemShortcut', and anything a later iPadOS adds.
      return 'none';
  }
}
