import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { noteBranchSurfingOff } from './early-updates';
import { fetchQaBranches } from './qa-surf';

/**
 * The branches this binary may be served, for the preview picker.
 *
 * The query function only reads. What a `surfing-off` answer has to DO (unpin
 * this device, safely) happens in the effect below, once per answer, so a
 * refetch, a retry or a cache hit cannot repeat it or run it half way.
 */
export function useQaBranches() {
  const query = useQuery({
    queryKey: ['qaBranches'],
    queryFn: ({ signal }) => fetchQaBranches(signal),
    staleTime: 30_000,
    retry: 1,
  });

  const surfingOff = query.data?.kind === 'surfing-off';
  useEffect(() => {
    if (surfingOff) void noteBranchSurfingOff();
  }, [surfingOff]);

  return query;
}
