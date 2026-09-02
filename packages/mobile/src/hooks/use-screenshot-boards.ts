import { useQuery } from '@tanstack/react-query';
import { fetchAllMyBoards } from '../lib/graphql/hooks';
import type { UserBoard } from '@boardsesh/shared-schema';

/**
 * Every board the screenshot account has, for resolving the pinned walls.
 *
 * `useMyBoards()` would be the obvious call and is the wrong one: it takes one
 * page, and the server's default page is 20. The capture asks for walls by name,
 * so a board sitting on page two reads as "selector matched nothing" and the
 * integrity gate aborts a run that should have succeeded — the failure mode is a
 * dead capture, not a wrong shot, but it is still a capture that needed a human.
 * `fetchAllMyBoards` walks the pagination to the end.
 *
 * One shared key for both readers (the boot auto-activator and the Climbs
 * screen's second board-view shot), so the second one to mount reads the cache
 * rather than re-walking. `staleTime: Infinity` because a capture run lasts a
 * couple of minutes and nobody is adding boards during it.
 *
 * Screenshot-only: `enabled` is ANDed with the inlined build flag, so the query
 * never runs in a normal build.
 */
const NO_BOARDS: UserBoard[] = [];

export function useScreenshotBoards(enabled: boolean): UserBoard[] {
  const { data } = useQuery({
    queryKey: ['screenshotAllMyBoards'],
    queryFn: fetchAllMyBoards,
    enabled: process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' && enabled,
    staleTime: Number.POSITIVE_INFINITY,
  });
  return data ?? NO_BOARDS;
}
