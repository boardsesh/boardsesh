import { useAccessoryDismissResets } from '../../hooks/use-accessory-dismiss-resets';

/**
 * Null-rendering host for {@link useAccessoryDismissResets}. Mounted near the app
 * root so the board-connect / board-switch reset wiring runs for the whole session
 * regardless of whether the accessory bar itself is currently visible.
 */
export function AccessoryDismissResets(): null {
  useAccessoryDismissResets();
  return null;
}
