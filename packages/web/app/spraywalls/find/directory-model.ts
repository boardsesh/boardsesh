import { ANGLES } from '@boardsesh/board-config';
import type { SearchBoardsInput } from '@boardsesh/shared-schema';
import type { SprayWallDirectoryEntry } from '@boardsesh/graphql/operations';
import { parseDirectoryQuery, type DirectoryQuery, type DirectorySearchParams } from '@/app/gyms/directory-facets';
import type { MapPin } from '@/app/gyms/near-me-model';

export const SPRAY_DIRECTORY_PATH = '/spraywalls/find';
export const SPRAY_DIRECTORY_PAGE_SIZE = 24;
export const SPRAY_DIRECTORY_MAX_PAGE = 40;

export function parseSprayDirectoryQuery(searchParams: DirectorySearchParams): DirectoryQuery {
  const parsed = parseDirectoryQuery('all', searchParams);
  const rawAngles = searchParams.angle;
  const angles = [
    ...new Set(
      (Array.isArray(rawAngles) ? rawAngles : [rawAngles])
        .filter((angle): angle is string => typeof angle === 'string' && angle.trim() !== '')
        .map(Number)
        .filter((angle) => ANGLES.spray.some((allowed) => allowed === angle)),
    ),
  ].sort((left, right) => left - right);
  return {
    query: parsed.query,
    place: parsed.place,
    latitude: parsed.latitude,
    longitude: parsed.longitude,
    radiusKm: parsed.latitude !== null ? (parsed.radiusKm ?? 25) : null,
    page: parsed.page,
    boardTypes: ['spray'],
    angles,
  };
}

export function buildSprayDirectoryHref(query: DirectoryQuery, page = 1): string {
  const params = new URLSearchParams();
  if (query.query) params.set('q', query.query);
  for (const angle of query.angles ?? []) params.append('angle', String(angle));
  if (query.latitude !== null && query.longitude !== null) {
    if (query.place) params.set('place', query.place);
    params.set('lat', String(query.latitude));
    params.set('lng', String(query.longitude));
    if (query.radiusKm !== null) params.set('radius', String(query.radiusKm));
  }
  if (page > 1) params.set('page', String(page));
  return params.size ? `${SPRAY_DIRECTORY_PATH}?${params}` : SPRAY_DIRECTORY_PATH;
}

export function sprayDirectoryInput(query: DirectoryQuery, limit = SPRAY_DIRECTORY_PAGE_SIZE): SearchBoardsInput {
  return {
    boardType: 'spray',
    ...(query.query ? { query: query.query } : {}),
    ...(query.angles?.length ? { angles: query.angles } : {}),
    ...(query.latitude !== null && query.longitude !== null
      ? { latitude: query.latitude, longitude: query.longitude, radiusKm: query.radiusKm ?? 25 }
      : {}),
    limit,
    offset: (query.page - 1) * limit,
  };
}

/** Coordinates have already been projected for an anonymous viewer by the backend. */
export function sprayDirectoryPins(walls: readonly SprayWallDirectoryEntry[]): MapPin[] {
  return walls.flatMap((wall) => {
    if (
      wall.latitude == null ||
      wall.longitude == null ||
      !Number.isFinite(wall.latitude) ||
      !Number.isFinite(wall.longitude)
    )
      return [];
    return [
      {
        uuid: wall.uuid,
        slug: wall.slug,
        name: wall.name,
        latitude: wall.latitude,
        longitude: wall.longitude,
        boardSummaries: [],
        href: `/b/${encodeURIComponent(wall.slug)}`,
        description: wall.locationName ?? wall.gymName ?? undefined,
      },
    ];
  });
}
