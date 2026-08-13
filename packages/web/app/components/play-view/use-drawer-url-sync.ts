'use client';

import { useEffect, useRef } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import type { BoardDetails, Climb } from '@/app/lib/types';
import { constructClimbListWithSlugs, getContextAwareClimbViewUrl, tryConstructSlugListUrl } from '@/app/lib/url-utils';
import { detectLocale } from '@/app/lib/i18n/detect-locale';

type DrawerUrlSyncSource = 'list-tap' | 'direct';

type UseDrawerUrlSyncArgs = {
  isOpen: boolean;
  displayedClimb: Climb | null;
  boardDetails: BoardDetails;
  angle: number;
  /** Called when the user navigates away from the /view/ URL (e.g. browser back). */
  onClose: () => void;
  /** When false, the hook does nothing. Mirrors viewOnlyMode / disabled cases. */
  enabled?: boolean;
};

/**
 * Keeps the browser URL in sync with the PlayViewDrawer's open state.
 *
 * Two effects:
 * - The `isOpen` effect owns the popstate listener and the close-cleanup
 *   (return the URL to the list / pop the pushed entry when the drawer closes).
 * - The `displayedClimb` effect owns the actual URL mutation — pushState the
 *   first time we see a climb on a non-/view/ pathname, replaceState on every
 *   subsequent climb change. This is split out so the URL push fires when the
 *   climb arrives from the queue bridge a render after `isOpen` flipped (the
 *   bridge between the deep `GraphQLQueueProvider` and the root QueueControlBar
 *   propagates via an effect, lagging by one render in solo mode).
 *
 * The history.state payload stamps each entry so coexisting URL handlers
 * (e.g. the PlayViewClient at /play/) can distinguish their pushes from ours.
 */
export function useDrawerUrlSync({
  isOpen,
  displayedClimb,
  boardDetails,
  angle,
  onClose,
  enabled = true,
}: UseDrawerUrlSyncArgs): void {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Refs let the effects read the latest pathname / searchParams / onClose
  // without re-subscribing the popstate listener every render.
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;
  const boardDetailsRef = useRef(boardDetails);
  boardDetailsRef.current = boardDetails;
  const angleRef = useRef(angle);
  angleRef.current = angle;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Cached source for the current drawer-open lifecycle. Set by the URL
  // mutation effect on the first push/replace, cleared by the close cleanup.
  const sourceRef = useRef<DrawerUrlSyncSource | null>(null);
  // Pathname at the moment the drawer started opening — used to derive `source`
  // and to compute the right list URL on close (since pathnameRef may have
  // moved on by the time cleanup fires).
  const openStartPathnameRef = useRef<string | null>(null);

  // Effect A — open/close lifecycle: popstate listener + URL restoration.
  useEffect(() => {
    if (!enabled || !isOpen) {
      return;
    }
    openStartPathnameRef.current = pathnameRef.current;

    const handlePopState = () => {
      if (!window.location.pathname.includes('/view/')) {
        onCloseRef.current();
      }
    };
    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
      const startPathname = openStartPathnameRef.current ?? pathnameRef.current;
      openStartPathnameRef.current = null;
      sourceRef.current = null;
      if (!window.location.pathname.includes('/view/')) {
        // popstate already navigated us off /view/ — nothing left to do.
        return;
      }
      // User-initiated close (close button, swipe-down, etc.). Always
      // replaceState to the list URL — `history.back()` is async per spec, so
      // a fast close-then-reopen synchronously pushes a new /view/ entry that
      // the still-pending back() would then pop, sending the user to /list
      // while the drawer is open. Replace is synchronous and race-free.
      //
      // Trade-off: list-tap opens leave a duplicate /list entry in the stack
      // (since the original /list entry is still below the popped /view/). One
      // visible back-press still leaves the site cleanly; the extra entry is
      // invisible in normal use.
      const listUrl = withSearchParams(
        getListUrl(boardDetailsRef.current, angleRef.current, startPathname),
        searchParamsRef.current,
      );
      window.history.replaceState({ ...window.history.state }, '', listUrl);
    };
  }, [isOpen, enabled]);

  // Effect B — URL push/replace whenever the displayed climb is available.
  // Fires on isOpen flips AND on climb changes, so a solo /b/ tap (where the
  // climb arrives one render after isOpen via the queue bridge) still gets
  // its URL pushed.
  useEffect(() => {
    if (!enabled || !isOpen || !displayedClimb) return;

    const startPathname = openStartPathnameRef.current ?? pathnameRef.current;
    const viewUrl = withSearchParams(
      getContextAwareClimbViewUrl(
        startPathname,
        boardDetailsRef.current,
        angleRef.current,
        displayedClimb.uuid,
        displayedClimb.name,
      ),
      searchParamsRef.current,
    );

    // Derive source once per open lifecycle: if we direct-hit a /view/ URL
    // it's 'direct'; otherwise we'll be pushing over /list, /b/.../list, etc.
    if (!sourceRef.current) {
      sourceRef.current = startPathname.includes('/view/') ? 'direct' : 'list-tap';
    }
    const stampedState = {
      ...window.history.state,
      boardseshDrawerUrlSync: { climbUuid: displayedClimb.uuid, source: sourceRef.current },
    };

    if (window.location.pathname.includes('/view/')) {
      // Either a direct-hit refresh of the URL or a climb-change replace.
      window.history.replaceState(stampedState, '', viewUrl);
    } else {
      // First time we have a climb on a non-/view/ pathname — push.
      window.history.pushState(stampedState, '', viewUrl);
    }
  }, [isOpen, displayedClimb?.uuid, enabled]);
}

function withSearchParams(url: string, searchParams: URLSearchParams): string {
  const queryString = searchParams.toString();
  return queryString ? `${url}?${queryString}` : url;
}

function getListUrl(boardDetails: BoardDetails, angle: number, pathname: string): string {
  // Detect a locale prefix once and prepend it to every shape — without this,
  // a Spanish user closing the drawer on /es/... would briefly land on the
  // unprefixed URL until middleware corrected it.
  const { locale, needsRewrite } = detectLocale(pathname);
  const localePrefix = needsRewrite ? `/${locale}` : '';

  // Preserve the short /b/{slug}/{angle}/ route shape when the user came from there.
  // The route tree has no index page under /b/{slug}/{angle}, so we must point
  // at /list explicitly to avoid a 404.
  const boardSlugMatch = pathname.match(/^(?:\/[a-z]{2}(?:-[A-Z]{2})?)?\/b\/([^/]+)\/(\d+)/);
  if (boardSlugMatch) {
    return `${localePrefix}/b/${boardSlugMatch[1]}/${boardSlugMatch[2]}/list`;
  }
  const { board_name, layout_name, size_name, size_description, set_names } = boardDetails;
  // Id-aware first: this URL replaces the address bar when the drawer closes,
  // and the name-based form would silently rewrite a shadowed size (Kilter
  // 12x12 without kickboard) onto the other board's bare slug — corrupting any
  // bookmark, refresh, or share taken from there.
  const idAwareListUrl = tryConstructSlugListUrl(
    board_name,
    boardDetails.layout_id,
    boardDetails.size_id,
    boardDetails.set_ids,
    angle,
  );
  if (idAwareListUrl) {
    return `${localePrefix}${idAwareListUrl}`;
  }
  if (layout_name && size_name && set_names) {
    return `${localePrefix}${constructClimbListWithSlugs(board_name, layout_name, size_name, size_description, set_names, angle)}`;
  }
  return `${localePrefix}/${board_name}/${boardDetails.layout_id}/${boardDetails.size_id}/${boardDetails.set_ids.join(',')}/${angle}/list`;
}
