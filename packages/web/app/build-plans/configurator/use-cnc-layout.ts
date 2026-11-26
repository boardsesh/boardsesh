'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CncBoardConfigInput } from '@boardsesh/shared-schema';
import { useCncRequestScope } from '../use-cnc-request-scope';
import { computeCnc } from './cnc-computation-client';
import { cncErrorKey, type CncErrorKey } from '../cnc-error';
import { readLayoutModel, type CncLayoutModel } from './layout-model';
import { readLayoutSummary, type CncLayoutSummary } from './layout-summary';

/**
 * How long the configuration has to sit still before we ask the generator.
 *
 * Every select in the configurator changes the layout, and the resolver is
 * rate-limited per caller, so a buyer flipping through five options must not
 * spend five of their allowance. 400 ms is below the point where the summary
 * feels detached from the control that changed it and well above the interval
 * between two clicks on the same select.
 */
const LAYOUT_DEBOUNCE_MS = 400;

/**
 * Debounce a value by identity of its JSON form.
 *
 * Keyed on the serialised config rather than the object, because the
 * configurator rebuilds the input object on every render — an identity-based
 * debounce would restart its timer forever and never settle.
 */
function useDebouncedConfig(config: CncBoardConfigInput | null): CncBoardConfigInput | null {
  const configKey = config ? JSON.stringify(config) : '';
  const [settled, setSettled] = useState(configKey);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(configKey), LAYOUT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [configKey]);

  if (!settled) return null;
  // Reparse rather than keep a second copy in a ref: the settled key IS the
  // value, and handing back the live object would return the un-debounced
  // config whenever a change landed between the timer firing and this render.
  return JSON.parse(settled) as CncBoardConfigInput;
}

export type CncLayoutResult = {
  summary: CncLayoutSummary | null;
  /** The geometry the placement editor draws. Its hole list is empty unless holes were asked for. */
  model: CncLayoutModel | null;
  isLoading: boolean;
  errorKey: CncErrorKey | null;
};

export type CncLayoutOptions = {
  /**
   * Ask for the drill pattern too.
   *
   * Off by default, and for two reasons: the hole list adds about 40 KB to
   * every response, and the resolver that returns it is authenticated and
   * capped at 10 calls a minute rather than 30. Turn it on only while the
   * placement editor is open and only for a signed-in builder. Query keys
   * keep the two response shapes separate within each account/login scope.
   */
  includeHoles?: boolean;
  /** Send an available credential for rollout targeting, even without holes. */
  authToken?: string | null;
  cacheScope?: string;
  /** The caller is signed in, so an anonymous rollout answer must not be used. */
  authRequired?: boolean;
  authLoading?: boolean;
};

/**
 * The panel layout for a configuration, debounced.
 *
 * Asks for the hole-free variant by default: it is the one the anonymous
 * preview is allowed to fetch, and every number the summary card shows comes
 * from `bom_preview` rather than from the holes themselves.
 *
 * Anonymous visitors can fetch hole-free layouts when their rollout is on.
 * Signed-in requests use their account's credential and cache scope, so account
 * targeting works before the artwork editor requests any private hole data.
 */
export function useCncLayout(
  config: CncBoardConfigInput | null,
  {
    includeHoles = false,
    authToken = null,
    cacheScope = 'anonymous',
    authRequired = false,
    authLoading = false,
  }: CncLayoutOptions = {},
): CncLayoutResult {
  const beginRequest = useCncRequestScope();
  const debouncedConfig = useDebouncedConfig(config);
  const configKey = debouncedConfig ? JSON.stringify(debouncedConfig) : '';
  // Holes are only ever asked for on behalf of somebody signed in, so a signed
  // out caller silently falls back to the public shape rather than spending a
  // round trip on a request the resolver will refuse.
  const wantsHoles = includeHoles && authToken !== null;
  const missingAuth = authRequired && authToken === null;

  const query = useQuery({
    queryKey: ['cncLayout', configKey, wantsHoles, cacheScope, authToken !== null] as const,
    queryFn: async ({ signal }) => {
      if (!debouncedConfig) throw new Error('useCncLayout: queryFn ran without a config');
      const isCurrent = beginRequest();
      const layout = await computeCnc('layout', debouncedConfig, {
        includeHoles: wantsHoles,
        authToken: authToken ?? undefined,
        signal,
        isCurrent,
      });
      if (!isCurrent()) throw new Error('STALE_CNC_REQUEST');
      return { summary: readLayoutSummary(layout), model: readLayoutModel(layout) };
    },
    enabled: debouncedConfig !== null && !missingAuth,
    // The generator caches layouts for a minute of its own; match it here so
    // stepping back to a configuration already seen costs nothing at all.
    staleTime: 60_000,
    // A rejected layout is a verdict, not a hiccup: retrying an invalid config
    // gives the same answer three times and delays the message that tells the
    // buyer what to change.
    retry: false,
  });

  return {
    summary: query.data?.summary ?? null,
    model: query.data?.model ?? null,
    isLoading: query.isFetching || (debouncedConfig !== null && missingAuth && authLoading),
    errorKey:
      debouncedConfig !== null && missingAuth && !authLoading
        ? 'generic'
        : query.error
          ? cncErrorKey(query.error)
          : null,
  };
}
