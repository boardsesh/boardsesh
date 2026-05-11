'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import {
  CONSENT_COOKIE,
  CONSENT_POLICY_VERSION,
  UNKNOWN_CONSENT,
  parseConsentCookie,
  serializeConsentCookie,
  type ConsentDecision,
  type ConsentValue,
} from '@/app/lib/consent';
import { useUserPreference } from '@/app/lib/user-preferences-hooks';

/**
 * Public shape exposed to consumers. State always returns a sane default
 * (`UNKNOWN_CONSENT`) so callers can render against it without null checks.
 */
export type UseConsentResult = {
  state: ConsentValue;
  isDecided: boolean;
  isLoading: boolean;
  acceptAll: () => Promise<void>;
  rejectAll: () => Promise<void>;
  setCategory: (category: ConsentCategory, decision: ConsentDecision) => Promise<void>;
  saveCategories: (categories: { analytics: ConsentDecision; errorMonitoring: ConsentDecision }) => Promise<void>;
};

export type ConsentCategory = 'analytics' | 'errorMonitoring';

const CONSENT_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365; // 1 year

const isDecisionFinal = (decision: ConsentDecision | 'unknown'): decision is ConsentDecision =>
  decision === 'granted' || decision === 'denied';

const computeIsDecided = (value: ConsentValue): boolean =>
  isDecisionFinal(value.analytics) && isDecisionFinal(value.errorMonitoring);

/**
 * Write the mirror cookie that server code reads on first render. Guarded
 * so importing this module under SSR doesn't blow up.
 */
const writeMirrorCookie = (value: ConsentValue): void => {
  if (typeof document === 'undefined') return;
  const serialized = serializeConsentCookie(value);
  document.cookie = `${CONSENT_COOKIE}=${serialized}; path=/; SameSite=Lax; max-age=${CONSENT_COOKIE_MAX_AGE_SECONDS}`;
};

const ConsentContext = createContext<UseConsentResult | null>(null);

/**
 * Wraps the consent preference for the app. Seeds initial state from the
 * SSR-parsed cookie so the banner doesn't flash before the IDB read resolves,
 * then defers to the IDB-backed value once `useUserPreference` settles.
 */
export function ConsentProvider({
  initialCookieValue,
  children,
}: {
  /** Raw cookie string from the request — `null` when no cookie is set. */
  initialCookieValue: string | null;
  children: ReactNode;
}) {
  const seeded = useMemo<ConsentValue>(() => parseConsentCookie(initialCookieValue), [initialCookieValue]);
  const seededIsDecided = useMemo(() => computeIsDecided(seeded), [seeded]);

  const { value, isLoading, setValue } = useUserPreference('consent');

  // Optimistic local mirror. `useUserPreference` updates via a BroadcastChannel,
  // which by spec does not deliver to the tab that posted — so the hook does
  // not see its own writes. We mirror writes here so the local UI reflects
  // them immediately. Cross-tab updates still flow through `value`.
  const [localOverride, setLocalOverride] = useState<ConsentValue | null>(null);

  // Whichever is more recent wins. We prefer the local mirror until the
  // hook's value catches up (deep-equals the mirror), then drop it.
  const state: ConsentValue = localOverride ?? value ?? seeded;

  // Only treat us as "still loading" when the cookie also doesn't have a
  // decision and we don't have an optimistic mirror.
  const effectiveIsLoading = isLoading && !seededIsDecided && localOverride === null;

  const isDecided = computeIsDecided(state);

  // Once `value` from the hook converges with our mirror (e.g., a different
  // tab confirmed the same write), drop the local override so cross-tab
  // updates take over again.
  useEffect(() => {
    if (localOverride === null || !value) return;
    if (
      value.analytics === localOverride.analytics &&
      value.errorMonitoring === localOverride.errorMonitoring &&
      value.decidedAt === localOverride.decidedAt &&
      value.version === localOverride.version
    ) {
      setLocalOverride(null);
    }
  }, [value, localOverride]);

  const persist = useCallback(
    async (next: ConsentValue) => {
      setLocalOverride(next);
      writeMirrorCookie(next);
      await setValue(next);
    },
    [setValue],
  );

  const acceptAll = useCallback(async () => {
    await persist({
      analytics: 'granted',
      errorMonitoring: 'granted',
      decidedAt: Date.now(),
      version: CONSENT_POLICY_VERSION,
    });
  }, [persist]);

  const rejectAll = useCallback(async () => {
    await persist({
      analytics: 'denied',
      errorMonitoring: 'denied',
      decidedAt: Date.now(),
      version: CONSENT_POLICY_VERSION,
    });
  }, [persist]);

  const setCategory = useCallback(
    async (category: ConsentCategory, decision: ConsentDecision) => {
      const baseline: ConsentValue = localOverride ?? value ?? UNKNOWN_CONSENT;
      const next: ConsentValue = {
        analytics: category === 'analytics' ? decision : baseline.analytics,
        errorMonitoring: category === 'errorMonitoring' ? decision : baseline.errorMonitoring,
        decidedAt: Date.now(),
        version: CONSENT_POLICY_VERSION,
      };
      await persist(next);
    },
    [persist, value, localOverride],
  );

  const saveCategories = useCallback(
    async (categories: { analytics: ConsentDecision; errorMonitoring: ConsentDecision }) => {
      await persist({
        analytics: categories.analytics,
        errorMonitoring: categories.errorMonitoring,
        decidedAt: Date.now(),
        version: CONSENT_POLICY_VERSION,
      });
    },
    [persist],
  );

  // Keep the mirror cookie in sync when state changes via a cross-tab
  // broadcast (e.g., the user accepted in another tab). We don't want to
  // re-write on every render, so we only fire when the parsed-cookie state
  // diverges from the IDB-backed state.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (!value) return;
    const cookieState = parseConsentCookie(
      document.cookie
        .split(';')
        .map((entry) => entry.trim())
        .find((entry) => entry.startsWith(`${CONSENT_COOKIE}=`))
        ?.slice(CONSENT_COOKIE.length + 1) ?? null,
    );
    if (cookieState.analytics !== value.analytics || cookieState.errorMonitoring !== value.errorMonitoring) {
      writeMirrorCookie(value);
    }
  }, [value]);

  const result = useMemo<UseConsentResult>(
    () => ({
      state,
      isDecided,
      isLoading: effectiveIsLoading,
      acceptAll,
      rejectAll,
      setCategory,
      saveCategories,
    }),
    [state, isDecided, effectiveIsLoading, acceptAll, rejectAll, setCategory, saveCategories],
  );

  return <ConsentContext.Provider value={result}>{children}</ConsentContext.Provider>;
}

/**
 * Access the consent state and writers. Falls back to {@link UNKNOWN_CONSENT}
 * with `isLoading: true` when called outside a {@link ConsentProvider} so
 * consumers can render defensively (e.g., the banner just hides itself).
 */
export function useConsent(): UseConsentResult {
  const ctx = useContext(ConsentContext);
  if (ctx) return ctx;
  const noop = async () => {};
  return {
    state: UNKNOWN_CONSENT,
    isDecided: false,
    isLoading: true,
    acceptAll: noop,
    rejectAll: noop,
    setCategory: noop,
    saveCategories: noop,
  };
}
