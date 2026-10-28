import { useEffect } from 'react';
import { useDeviceLayout } from '../../hooks/use-device-layout';
import { publishHingeStatus } from '../../lib/device-hinge-store';
import { HingeObserver } from './HingeObserver';

/**
 * The app's one hinge observer, mounted once at the root and only on the
 * iPhone Duo's inner display (`foldableInnerDisplay`, either way up): the phone
 * split's fold gutter reads it in landscape, the player's tabletop layout in
 * portrait. One writer means one source of truth for `device-hinge-store`;
 * closing the Duo resets the store to flat, so a fold from half open straight
 * to closed can't leave a stale "half open" behind for the next unfold. The next
 * observer's first report (SwiftUI fires on appear) sets the real status again.
 * A rotation stays on the inner display, so it keeps the same observer.
 */
export function FoldHingeObserver() {
  const { foldableInnerDisplay } = useDeviceLayout();
  useEffect(() => {
    if (!foldableInnerDisplay) return undefined;
    return () => publishHingeStatus(null);
  }, [foldableInnerDisplay]);
  return foldableInnerDisplay ? <HingeObserver /> : null;
}
