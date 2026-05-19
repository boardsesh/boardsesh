'use client';

import { useParams } from 'next/navigation';
import { useMyBoards } from '@/app/hooks/use-my-boards';

/**
 * Resolves a board serial from the current Next.js route's `board_slug`
 * parameter — the fallback path when no BLE controller is connected.
 *
 * The flow:
 * 1. Read the `board_slug` route param (set by the `/b/[board_slug]/...`
 *    route family).
 * 2. Look the slug up in the authenticated user's `userBoards` list and
 *    return its `serialNumber` if present.
 *
 * Returns `null` when:
 * - There is no `board_slug` segment in the active route
 * - The user has no matching board in `useMyBoards`
 * - The matching board does not carry a serial (unregistered controller)
 *
 * This is intentionally narrow: it does NOT attempt to derive a serial from
 * the canonical `[board_name]/[layout_id]/...` route shape, because that
 * route is by definition a generic board config, not a specific physical
 * controller.
 */
export function useResolvedBoardSerialForRoute(): string | null {
  const params = useParams<{ board_slug?: string }>();
  const boardSlug = params?.board_slug ?? null;

  // Only fire the boards query when we actually have a slug to resolve.
  // Off-board routes (and the generic `[board_name]/...` routes) skip the
  // query entirely so signed-out browsing stays free of /myBoards traffic.
  const { boards } = useMyBoards(!!boardSlug);

  if (!boardSlug) return null;
  const match = boards.find((board) => board.slug === boardSlug);
  return match?.serialNumber ?? null;
}
