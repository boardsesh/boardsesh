import type { useRouter } from 'expo-router';
import type { BoardReturnTo } from '../../lib/boards/board-return-to';

type ExitRouter = Pick<ReturnType<typeof useRouter>, 'canGoBack' | 'back' | 'dismissTo'>;

/**
 * Leave the spray flow the way its header X does: back through the history when
 * there is one, so the screen's `usePreventRemove` leave guard still asks
 * before work is thrown away, and straight to `returnTo` on a cold deep link
 * that created no history. The layout's X (`SprayWizardExitButton`) and the
 * wizard's own header X both call this.
 */
export function exitSprayWizard(router: ExitRouter, returnTo: BoardReturnTo): void {
  if (router.canGoBack()) router.back();
  else router.dismissTo(returnTo);
}
