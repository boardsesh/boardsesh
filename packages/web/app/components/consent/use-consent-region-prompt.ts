'use client';
import { useEffect, useState } from 'react';
import { createRegionDefaultConsent, isRegionDefaultConsent, needsPrompt } from '@boardsesh/consent';
import { getWebConsentRecord, setConsentRegionConfirmed, writeWebConsent } from '@/app/lib/consent';
import { expireConsentRegionLookup, isConsentRegionLookupCurrent, lookUpConsentRegion } from '@/app/lib/consent-region';
import { useConsent } from './consent-provider';

/**
 * Whether the consent banner may show on this page load: only in the prompt
 * regions (EU, EEA, UK, Switzerland and the rest of `CONSENT_PROMPT_COUNTRIES`)
 * and whenever the region is unknown. False until the region is known, so a
 * visitor outside those regions never sees the banner flash.
 *
 * Outside the prompt regions a visitor with no answer gets the region default:
 * analytics on, stored in the consent cookie with a `region` marker. This is the
 * one cookie write that does not follow a click; the account never receives it
 * and an account denial still replaces it. A region default seen again from a
 * prompt region (a traveller) is dropped so the banner asks.
 *
 * A stored region default sends nothing until this page load's lookup says the
 * region needs no prompt (`setConsentRegionConfirmed`). A failed lookup keeps
 * the cookie but sends nothing on this page.
 *
 * Global Privacy Control counts as a "no" outside the prompt regions: no
 * region default is written (an existing one is dropped), and no banner shows.
 * Privacy choices still lets the visitor allow analytics explicitly.
 *
 * `enabled` is false on chrome-less pages (kiosks, embeds), which never ask and
 * must not write cookies.
 */
export function useConsentRegionPrompt(enabled: boolean): boolean {
  const { snapshot } = useConsent();
  const [promptRegion, setPromptRegion] = useState(false);
  // A boolean, not the record, is the effect's dependency: writing the region
  // default turns "no answer" into "region default", both true, so the effect
  // does not run again. It re-runs only when an answer appears or disappears
  // (a choice, a withdrawal from another tab), and the lookup itself is cached
  // per page load and refreshed on foreground resume while a default remains.
  const regionCheckNeeded = enabled && (needsPrompt(snapshot.record) || isRegionDefaultConsent(snapshot.record));

  useEffect(() => {
    if (!regionCheckNeeded) return;
    let cancelled = false;
    const checkRegion = () => {
      const answer = lookUpConsentRegion();
      void answer
        .then(({ promptRequired, globalPrivacyControl }) => {
          if (cancelled || !isConsentRegionLookupCurrent(answer)) return;
          const current = getWebConsentRecord();
          const regionDefaultAllowed = promptRequired === false && !globalPrivacyControl;
          setConsentRegionConfirmed(regionDefaultAllowed);
          if (regionDefaultAllowed) {
            if (needsPrompt(current)) writeWebConsent(createRegionDefaultConsent('web'));
            return;
          }
          if (promptRequired === false) {
            // Global Privacy Control: the browser already said no.
            if (isRegionDefaultConsent(current)) writeWebConsent(null);
            return;
          }
          // Only a positive "this region asks" drops a region default; an unknown
          // region keeps it (the banner stays hidden behind the cookie either way).
          if (promptRequired === true && isRegionDefaultConsent(current)) writeWebConsent(null);
          setPromptRegion(true);
        })
        .catch(() => {
          // Unreachable today (the lookup never rejects), but an unknown region asks.
          if (!cancelled && isConsentRegionLookupCurrent(answer)) setPromptRegion(true);
        });
    };
    const refresh = () => {
      const current = getWebConsentRecord();
      if (document.visibilityState === 'hidden' || (!isRegionDefaultConsent(current) && !needsPrompt(current))) return;
      if (!expireConsentRegionLookup()) return;
      // Revoke capture synchronously, before the fresh request or React effects.
      setConsentRegionConfirmed(false);
      checkRegion();
    };
    checkRegion();
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [regionCheckNeeded]);

  return enabled && needsPrompt(snapshot.record) && promptRegion;
}
