'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CncBoardConfigInput } from '@boardsesh/shared-schema';
import {
  GET_CNC_LAYOUT,
  type GetCncLayoutQueryResponse,
  type GetCncLayoutQueryVariables,
} from '@boardsesh/graphql/operations/cnc-packs';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
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
   * placement editor is open and only for a signed-in buyer — the query key
   * carries the flag, so the cheap public answer stays cached either way and
   * flipping back to it costs nothing.
   */
  includeHoles?: boolean;
  /** Required when `includeHoles` is set; the holes are not public. */
  authToken?: string | null;
};

/**
 * The panel layout for a configuration, debounced.
 *
 * Asks for the hole-free variant by default: it is the one the anonymous
 * preview is allowed to fetch, and every number the summary card shows comes
 * from `bom_preview` rather than from the holes themselves.
 *
 * With no token, no token is sent. The layout resolver is public for exactly
 * this reason — the preview is what makes someone want to buy, so it must
 * render before anyone is asked to sign in.
 */
export function useCncLayout(
  config: CncBoardConfigInput | null,
  { includeHoles = false, authToken = null }: CncLayoutOptions = {},
): CncLayoutResult {
  const debouncedConfig = useDebouncedConfig(config);
  const configKey = debouncedConfig ? JSON.stringify(debouncedConfig) : '';
  // Holes are only ever asked for on behalf of somebody signed in, so a signed
  // out caller silently falls back to the public shape rather than spending a
  // round trip on a request the resolver will refuse.
  const wantsHoles = includeHoles && authToken !== null;

  const query = useQuery({
    queryKey: ['cncLayout', configKey, wantsHoles] as const,
    queryFn: async () => {
      if (!debouncedConfig) throw new Error('useCncLayout: queryFn ran without a config');
      const client = createGraphQLHttpClient(wantsHoles ? authToken : undefined);
      const response = await client.request<GetCncLayoutQueryResponse, GetCncLayoutQueryVariables>(GET_CNC_LAYOUT, {
        config: debouncedConfig,
        includeHoles: wantsHoles,
      });
      return { summary: readLayoutSummary(response.cncLayout), model: readLayoutModel(response.cncLayout) };
    },
    enabled: debouncedConfig !== null,
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
    isLoading: query.isFetching,
    errorKey: query.error ? cncErrorKey(query.error) : null,
  };
}
