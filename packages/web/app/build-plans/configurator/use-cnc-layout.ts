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
  isLoading: boolean;
  errorKey: CncErrorKey | null;
};

/**
 * The panel layout for a configuration, debounced.
 *
 * Asks for the hole-free variant: it is the one the anonymous preview is
 * allowed to fetch (the hole list is authenticated and ~40 KB bigger, and only
 * the placement editor needs it), and every number the summary card shows comes
 * from `bom_preview` rather than from the holes themselves.
 *
 * No auth token is passed. The layout resolver is public for exactly this
 * reason — the preview is what makes someone want to buy, so it must render
 * before anyone is asked to sign in.
 */
export function useCncLayout(config: CncBoardConfigInput | null): CncLayoutResult {
  const debouncedConfig = useDebouncedConfig(config);
  const configKey = debouncedConfig ? JSON.stringify(debouncedConfig) : '';

  const query = useQuery({
    queryKey: ['cncLayout', configKey] as const,
    queryFn: async () => {
      if (!debouncedConfig) throw new Error('useCncLayout: queryFn ran without a config');
      const client = createGraphQLHttpClient();
      const response = await client.request<GetCncLayoutQueryResponse, GetCncLayoutQueryVariables>(GET_CNC_LAYOUT, {
        config: debouncedConfig,
        includeHoles: false,
      });
      return readLayoutSummary(response.cncLayout);
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
    summary: query.data ?? null,
    isLoading: query.isFetching,
    errorKey: query.error ? cncErrorKey(query.error) : null,
  };
}
