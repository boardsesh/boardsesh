// Pure, node-testable helpers shared by both SwitcherForm platform files (and the
// screens that build the model). No native imports, no rendering — so the
// switch-target row state machine has one home and iOS/Android can't diverge.

import type { SwitchRowState, SwitcherRow } from './SwitcherForm.types';

/**
 * Resolve the render/interaction state of one switch-target row, matching the
 * behaviour BranchSwitcherScreen previously hand-rolled inline:
 *
 * - the row currently switching → `switching` (spinner),
 * - else the live target → `active` (checkmark),
 * - else any switch in flight → `disabled` (another row is mid-switch; dimmed),
 * - else, when OTA updates are usable → `pressable` (tappable to switch),
 * - else → `inert` (dev / Expo Go: rendered so the list can be reviewed, not tappable).
 *
 * `switchingTarget` is the target identifier currently mid-switch, or null when
 * idle. `activeTarget` is the live override (or build channel) the row compares
 * against. The earlier inline code let a mid-switch row stay nominally pressable
 * (guarded by an in-flight ref); folding it into `switching` here is equivalent —
 * the ref already swallowed the tap — and reads clearer.
 */
export function deriveSwitchRowState(input: {
  target: string;
  activeTarget: string;
  switchingTarget: string | null;
  updatesUsable: boolean;
}): SwitchRowState {
  const { target, activeTarget, switchingTarget, updatesUsable } = input;
  if (switchingTarget === target) return 'switching';
  if (target === activeTarget) return 'active';
  if (switchingTarget !== null) return 'disabled';
  return updatesUsable ? 'pressable' : 'inert';
}

/** Only a `pressable` row wires an onPress; every other state is non-interactive. */
export function isSwitchRowPressable(state: SwitchRowState): boolean {
  return state === 'pressable';
}

/** Exhaustiveness guard for the row-kind switch in both platform renderers. */
export function assertNeverSwitcherRow(row: never): never {
  throw new Error(`Unhandled SwitcherRow kind: ${JSON.stringify(row as SwitcherRow)}`);
}
