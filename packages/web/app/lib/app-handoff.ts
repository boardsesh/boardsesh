import { APP_URL } from '@/app/lib/app-origin';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@/app/lib/i18n/config';
import { stripLocalePrefix } from '@/app/lib/i18n/locale-href';

/**
 * The app.boardsesh.com twin of a www pathname: `APP_URL` plus the same path,
 * with any locale prefix stripped.
 *
 * The Expo app has no `/es`, `/fr` or `/de` routing, so a Spanish reader
 * following the "Climb this" CTA lands on the English app — an accepted
 * regression recorded in the reposition epic, not an oversight here.
 *
 * Takes no locale argument on purpose. Every supported prefix is stripped, the
 * way `applyLocale` in `i18n/locale-href.ts` — the other half of this round
 * trip — already strips them; a caller that had to remember to thread the
 * active locale would silently hand out `app.boardsesh.com/es/…`, a route the
 * app does not have, on the day it forgot.
 *
 * `pathname` means pathname: a query string or fragment is dropped, because the
 * CTA contract is "the same pathname on the app origin" and a www filter or
 * sort param means nothing to the SPA route it opens.
 */
export function buildAppHandoffUrl(pathname: string): string {
  const [pathOnly] = pathname.split(/[?#]/);
  let withoutLocale = pathOnly;
  for (const locale of SUPPORTED_LOCALES) {
    if (locale === DEFAULT_LOCALE) continue;
    withoutLocale = stripLocalePrefix(withoutLocale, locale);
  }
  const path = withoutLocale.startsWith('/') ? withoutLocale : `/${withoutLocale}`;
  return `${APP_URL.replace(/\/+$/, '')}${path}`;
}

/** The board a new climb gets painted on, in the shape the app's route reads. */
export type AppCreateClimbBoard = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: number[];
  angle: number;
};

/** Seed values for a remix or a draft edit. */
export type AppCreateClimbSeed = {
  frames?: string;
  name?: string;
  description?: string;
  /**
   * The source climb's `characteristics`, so a remix started on www inherits its
   * climb rules instead of opening with them reset (#4832). Null/undefined means
   * the source carried none and the param is left off entirely — the app reads an
   * ABSENT param as "fall back to the legacy `No match` description prefix", and
   * an explicitly empty array as "all rules at their defaults", which are
   * different answers.
   */
  characteristics?: string[] | null;
  editClimbUuid?: string;
};

/**
 * The app's climb editor, with the board and any remix seed attached.
 *
 * Unlike `buildAppHandoffUrl` this one carries a query string, because the
 * app's create route is the one handoff target that reads params:
 * `packages/mobile/app/(tabs)/climbs/create.tsx` takes `boardName`, `layoutId`,
 * `sizeId`, `setIds` and `angle`, validates the board name against
 * `SUPPORTED_BOARDS`, and falls back to the signed-in user's active board for
 * anything missing. Call it with no board when there is nothing to say — a bare
 * `/climbs/create` opens on the active board, which is the right answer for a
 * reader who has never opened one.
 *
 * W-17 (#4433) deleted www's own `…/[angle]/create` routes. Everything that
 * used to link there links here instead, so there is no redirect hop and no
 * board context quietly dropped on the way.
 */
export function buildAppCreateClimbUrl(board?: AppCreateClimbBoard | null, seed?: AppCreateClimbSeed): string {
  const base = `${APP_URL.replace(/\/+$/, '')}/climbs/create`;
  const params = new URLSearchParams();

  if (board) {
    params.set('boardName', board.boardName);
    params.set('layoutId', String(board.layoutId));
    params.set('sizeId', String(board.sizeId));
    params.set('setIds', board.setIds.join(','));
    params.set('angle', String(board.angle));
  }
  if (seed?.frames) params.set('forkFrames', seed.frames);
  if (seed?.name) params.set('forkName', seed.name);
  if (seed?.description) params.set('forkDescription', seed.description);
  // Not `if (seed?.characteristics?.length)`: an empty array is a real value here
  // (a climb whose rules are all at their defaults) and must still be sent.
  if (seed?.characteristics) params.set('forkCharacteristics', JSON.stringify(seed.characteristics));
  if (seed?.editClimbUuid) params.set('editClimbUuid', seed.editClimbUuid);

  const query = params.toString();
  return query ? `${base}?${query}` : base;
}
