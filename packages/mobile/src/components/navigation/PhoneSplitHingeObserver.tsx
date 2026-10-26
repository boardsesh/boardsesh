import { useEffect } from 'react';
import { usePhoneSplit } from '../../hooks/use-phone-split';
import { publishHingeStatus } from '../../lib/device-hinge-store';
import { HingeObserver } from './HingeObserver';

/**
 * The app's one hinge observer, mounted once at the root and only while the
 * phone split is up (the fold gutter is the only thing that reads it). One
 * writer means one source of truth for `device-hinge-store`; leaving the split
 * resets the store to flat, so a fold from half open straight to closed can't
 * leave a stale "half open" behind for the next unfold. The next observer's
 * first report (SwiftUI fires on appear) sets the real status again.
 */
export function PhoneSplitHingeObserver() {
  const phoneSplit = usePhoneSplit();
  useEffect(() => {
    if (!phoneSplit) return undefined;
    return () => publishHingeStatus(null);
  }, [phoneSplit]);
  return phoneSplit ? <HingeObserver /> : null;
}
