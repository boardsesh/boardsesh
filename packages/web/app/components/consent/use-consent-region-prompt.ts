'use client';
import { useEffect, useState } from 'react';
import { createRegionDefaultConsent, isRegionDefaultConsent, needsPrompt } from '@boardsesh/consent';
import { getWebConsentRecord, writeWebConsent } from '@/app/lib/consent';
import { lookUpConsentRegion } from '@/app/lib/consent-region';
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
 * `enabled` is false on chrome-less pages (kiosks, embeds), which never ask and
 * must not write cookies.
 */
export function useConsentRegionPrompt(enabled: boolean): boolean {
  const { snapshot } = useConsent();
  const [promptRegion, setPromptRegion] = useState(false);
  const regionCheckNeeded = enabled && (needsPrompt(snapshot.record) || isRegionDefaultConsent(snapshot.record));

  useEffect(() => {
    if (!regionCheckNeeded) return;
    let cancelled = false;
    void lookUpConsentRegion().then((promptRequired) => {
      if (cancelled) return;
      const current = getWebConsentRecord();
      if (promptRequired === false) {
        if (needsPrompt(current)) writeWebConsent(createRegionDefaultConsent('web'));
        return;
      }
      // Only a positive "this region asks" drops a region default; an unknown
      // region keeps it (the banner stays hidden behind the cookie either way).
      if (promptRequired === true && isRegionDefaultConsent(current)) writeWebConsent(null);
      setPromptRegion(true);
    });
    return () => {
      cancelled = true;
    };
  }, [regionCheckNeeded]);

  return promptRegion;
}
