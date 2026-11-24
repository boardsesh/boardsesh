import { toPlayCount, type Climb } from '@boardsesh/shared-schema';

export type CatalogPlaysScope = {
  credentialScope: number;
  // A wall capability or a verified local wall can authorize more than the
  // general-purpose stats batch. Only the matching source can retire its count.
  authority: 'reference' | 'wall';
};
export type ClimbPlaysProjection = CatalogPlaysScope & { playCount: number | null };
type ClimbCatalogPayload = 'searchClimbs' | 'playlistClimbs' | 'smartPlaylist';

function isRecord(result: unknown): result is Record<string, unknown> {
  return typeof result === 'object' && result !== null;
}

/** Attach read provenance to the page, so it survives query caching and flattening without touching climbs. */
export function stampCatalogPlaysScope<Response>(
  result: Response,
  name: ClimbCatalogPayload,
  scope: CatalogPlaysScope,
): Response {
  if (!isRecord(result)) return result;
  const page = result[name];
  if (!isRecord(page)) return result;
  return { ...result, [name]: { ...page, catalogPlaysScope: scope } };
}

function readScope(page: unknown): CatalogPlaysScope | undefined {
  if (!isRecord(page) || !isRecord(page.catalogPlaysScope)) return undefined;
  const { credentialScope, authority } = page.catalogPlaysScope;
  if (typeof credentialScope !== 'number' || (authority !== 'reference' && authority !== 'wall')) return undefined;
  return page.catalogPlaysScope as CatalogPlaysScope;
}

/** An infinite view may still be retaining old pages. Trust the projections only when they agree. */
export function catalogPlaysScope(pages: readonly unknown[] | undefined): CatalogPlaysScope | undefined {
  const first = readScope(pages?.[0]);
  if (!first) return undefined;
  return pages?.every((page) => {
    const scope = readScope(page);
    return scope?.credentialScope === first.credentialScope && scope.authority === first.authority;
  })
    ? first
    : undefined;
}

/** A catalog/detail projection supplies Plays only for its own board and angle. */
export function projectClimbPlays(
  climb: Pick<Climb, 'angle' | 'boardType' | 'layoutId' | 'play_count'> | null | undefined,
  boardName: string,
  layoutId: number,
  angle: number,
  scope: CatalogPlaysScope,
): ClimbPlaysProjection | undefined {
  if (climb?.boardType !== boardName || climb.layoutId !== layoutId || climb.angle !== angle) return undefined;
  return { ...scope, playCount: toPlayCount(climb.play_count) };
}

export function selectClimbPlays(
  live: number | null | undefined,
  projection: ClimbPlaysProjection | undefined,
  credentialScope: number,
): number | null | undefined {
  // Retired credentials cannot fall back to an old page while the app is
  // tearing down its query cache. A current exact read may seed immediately.
  if (!projection || projection.credentialScope !== credentialScope) return live;
  if (projection.authority === 'wall' || live === undefined) return projection.playCount;
  return live;
}

export function climbPlayCountKey(boardName: string, layoutId: number, climbUuid: string, angle: number): string {
  return JSON.stringify([boardName, layoutId, climbUuid, angle]);
}
