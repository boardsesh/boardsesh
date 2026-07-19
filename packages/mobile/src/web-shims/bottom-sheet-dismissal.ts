export type SheetDismissalState = 'dismissed' | 'presented';

export type SheetDismissalTransition = {
  state: SheetDismissalState;
  shouldNotify: boolean;
};

export const initialSheetDismissalState: SheetDismissalState = 'dismissed';

export function transitionSheetDismissal(
  state: SheetDismissalState,
  event: 'present' | 'dismiss',
): SheetDismissalTransition {
  if (event === 'present') return { state: 'presented', shouldNotify: false };
  if (state === 'presented') return { state: 'dismissed', shouldNotify: true };
  return { state: 'dismissed', shouldNotify: false };
}
