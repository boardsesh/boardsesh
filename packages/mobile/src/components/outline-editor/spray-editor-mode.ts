/**
 * The hold editor's modes, as the climber sees them, and the one rule for
 * moving between them, as pure data and a pure function.
 *
 * Five modes sit side by side in the mode switcher (`SprayModeSwitcher` on a
 * phone, the tool rail on iPad): Select, the resting pick-and-switch; Add,
 * for the holds the scan missed; and three that work on one hold — Trace
 * (redraw its outline in one loop), Refine (brush its outline bigger or
 * smaller) and Join (merge it with a second hold).
 *
 * A mode is a `SprayEditorTool` under another name: Select is the `edit` tool,
 * the rest share their tool's name. The screen keeps the tool as its state, so
 * the tap rule (`spray-edit-tap.ts`), the shortcuts and the Pencil keep reading
 * the value they always have.
 *
 * A hold-needing mode chosen with no ON hold picked does not refuse: it opens
 * in a pick step ("Tap a hold to trace") and the next tap on an ON hold is the
 * hold it works on. With an ON hold already picked it starts on that hold
 * straight away.
 */
import type { IconName } from '../icon-map';
import type { SprayEditorTool } from './spray-edit-tap';
import type { SprayHoldRole } from './spray-hold-editor-reducer';

export type SprayEditorMode = 'select' | 'add' | 'trace' | 'refine' | 'join';

export type SprayModeSpec = {
  mode: SprayEditorMode;
  /** The screen's tool for this mode. */
  tool: SprayEditorTool;
  iconName: IconName;
};

/** The switcher's segments, in order. */
export const SPRAY_MODES: readonly SprayModeSpec[] = [
  { mode: 'select', tool: 'edit', iconName: 'hand.tap' },
  { mode: 'add', tool: 'add', iconName: 'plus' },
  { mode: 'trace', tool: 'trace', iconName: 'lasso' },
  { mode: 'refine', tool: 'refine', iconName: 'paintbrush' },
  { mode: 'join', tool: 'join', iconName: 'link' },
];

/** The mode a tool belongs to. */
export function modeForTool(tool: SprayEditorTool): SprayEditorMode {
  return tool === 'edit' ? 'select' : tool;
}

/** The tool a mode runs. */
export function toolForMode(mode: SprayEditorMode): SprayEditorTool {
  return mode === 'select' ? 'edit' : mode;
}

/** Trace, Refine and Join each work on one ON hold. Select and Add work on the wall. */
export function needsHold(mode: SprayEditorMode): boolean {
  return mode === 'trace' || mode === 'refine' || mode === 'join';
}

/**
 * What choosing `to` while in `from` does:
 *
 * - `exit` — back to Select: leave the current mode the way its own Done or
 *   Cancel would (Add closes a ready Corners outline, Refine keeps its strokes,
 *   Trace and Join drop what they had).
 * - `enter` — leave the current mode, then start `to` (on the picked hold, for
 *   a hold-needing mode).
 * - `pick` — leave the current mode, then open `to` in its pick step: there is
 *   no ON hold picked for it to work on yet.
 * - `refuse` — nothing happens: the wall is locked, or `to` is already on.
 *
 * Leaving can still be refused at run time (a Corners outline that will not
 * close, a Refine stroke that cannot be kept). The screen then stays where it
 * was and says why.
 */
export type SprayModeSwitchPlan = 'exit' | 'enter' | 'pick' | 'refuse';

export function planModeSwitch(
  from: SprayEditorMode,
  to: SprayEditorMode,
  context: {
    /** The picked hold's role, or null with nothing picked. */
    selectedHoldRole: SprayHoldRole | null;
    /** Read-only, a save in flight, or the reveal still running. */
    locked?: boolean;
  },
): SprayModeSwitchPlan {
  if (context.locked || from === to) return 'refuse';
  if (to === 'select') return 'exit';
  if (!needsHold(to)) return 'enter';
  return context.selectedHoldRole === 'on' ? 'enter' : 'pick';
}
