export const PHYSICAL_GYM_MATCH_DISTANCE_METERS = 20;

const EARTH_RADIUS_METERS = 6_371_000;
const MISSING_CREATED_AT = Number.POSITIVE_INFINITY;

export type CanonicalGymCandidate = {
  id: number;
  uuid: string;
  name: string;
  address: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  description: string | null;
  imageUrl: string | null;
  latitude: number;
  longitude: number;
  createdAt: Date | string | null;
  boardCount: number;
  memberCount: number;
  followerCount: number;
  commentCount: number;
};

export type PhysicalGymCluster<T extends CanonicalGymCandidate> = {
  normalizedName: string;
  gyms: T[];
};

export function normalizeGymName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Normalized gym names too generic to be a reliable physical identity. These are
 * prod's biggest name-collision classes — home-wall / garage pins and bare board
 * brands the location sync mints at residential coordinates. A first board named
 * one of these must NOT auto-attach to a stranger's nearby gym (a claimable SYSTEM
 * pin), since a false attach ultimately hands board-edit control to whoever claims
 * that gym. The suggest surface is unaffected (suggest-never-block).
 *
 * Compare with `isGenericGymName` (normalized) rather than raw membership.
 */
export const GENERIC_GYM_NAMES: ReadonlySet<string> = new Set([
  'home wall',
  'homewall',
  'home',
  'garage',
  'cellar',
  'basement',
  'kilter',
  'kilter board',
  'tension',
  'tension board',
  'moonboard',
  'moon',
  'moon board',
]);

/** Whether a gym name is too generic to anchor an auto-attach (normalized comparison). */
export function isGenericGymName(name: string): boolean {
  return GENERIC_GYM_NAMES.has(normalizeGymName(name));
}

export function hasText(value: string | null): boolean {
  return value !== null && value.trim().length > 0;
}

function createdAtMillis(value: Date | string | null): number {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : MISSING_CREATED_AT;
  }
  return MISSING_CREATED_AT;
}

export function distanceMeters(
  first: { latitude: number; longitude: number },
  second: { latitude: number; longitude: number },
): number {
  const firstLatitudeRadians = (first.latitude * Math.PI) / 180;
  const secondLatitudeRadians = (second.latitude * Math.PI) / 180;
  const latitudeDeltaRadians = ((second.latitude - first.latitude) * Math.PI) / 180;
  const longitudeDeltaRadians = ((second.longitude - first.longitude) * Math.PI) / 180;

  const haversine =
    Math.sin(latitudeDeltaRadians / 2) ** 2 +
    Math.cos(firstLatitudeRadians) * Math.cos(secondLatitudeRadians) * Math.sin(longitudeDeltaRadians / 2) ** 2;

  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

export function gymCompletenessScore(candidate: CanonicalGymCandidate): number {
  let score = 0;
  if (hasText(candidate.address)) {
    score += 100;
  }
  if (hasText(candidate.imageUrl)) {
    score += 40;
  }
  if (hasText(candidate.description)) {
    score += 25;
  }
  if (hasText(candidate.contactEmail)) {
    score += 15;
  }
  if (hasText(candidate.contactPhone)) {
    score += 15;
  }
  score += candidate.boardCount * 2;
  score += candidate.memberCount;
  score += candidate.followerCount;
  score += candidate.commentCount;
  return score;
}

export function compareCanonicalGymCandidates(
  firstCandidate: CanonicalGymCandidate,
  secondCandidate: CanonicalGymCandidate,
): number {
  const scoreDifference = gymCompletenessScore(secondCandidate) - gymCompletenessScore(firstCandidate);
  if (scoreDifference !== 0) {
    return scoreDifference;
  }

  const createdAtDifference = createdAtMillis(firstCandidate.createdAt) - createdAtMillis(secondCandidate.createdAt);
  if (createdAtDifference !== 0) {
    return createdAtDifference;
  }

  return firstCandidate.id - secondCandidate.id;
}

export function chooseCanonicalGymCandidate<T extends CanonicalGymCandidate>(candidates: T[]): T | null {
  return [...candidates].sort(compareCanonicalGymCandidates)[0] ?? null;
}

export function groupPhysicalGymCandidates<T extends CanonicalGymCandidate>(
  candidates: T[],
  maxDistanceMeters = PHYSICAL_GYM_MATCH_DISTANCE_METERS,
): Array<PhysicalGymCluster<T>> {
  const candidatesByName = new Map<string, T[]>();

  for (const candidate of candidates) {
    const normalizedName = normalizeGymName(candidate.name);
    const matchingNameCandidates = candidatesByName.get(normalizedName) ?? [];
    matchingNameCandidates.push(candidate);
    candidatesByName.set(normalizedName, matchingNameCandidates);
  }

  const clusters: Array<PhysicalGymCluster<T>> = [];
  for (const [normalizedName, matchingNameCandidates] of candidatesByName) {
    const nameClusters: Array<PhysicalGymCluster<T>> = [];
    const sortedCandidates = [...matchingNameCandidates].sort((firstCandidate, secondCandidate) => {
      const latitudeDifference = firstCandidate.latitude - secondCandidate.latitude;
      if (latitudeDifference !== 0) return latitudeDifference;
      const longitudeDifference = firstCandidate.longitude - secondCandidate.longitude;
      if (longitudeDifference !== 0) return longitudeDifference;
      return firstCandidate.id - secondCandidate.id;
    });

    for (const candidate of sortedCandidates) {
      const existingCluster = nameClusters.find((cluster) =>
        cluster.gyms.every((clusterCandidate) => distanceMeters(candidate, clusterCandidate) <= maxDistanceMeters),
      );

      if (existingCluster) {
        existingCluster.gyms.push(candidate);
      } else {
        nameClusters.push({ normalizedName, gyms: [candidate] });
      }
    }

    clusters.push(...nameClusters.filter((cluster) => cluster.gyms.length > 1));
  }

  return clusters.sort((firstCluster, secondCluster) =>
    firstCluster.normalizedName.localeCompare(secondCluster.normalizedName),
  );
}

/**
 * Guarded second match tier for the location-sync importer.
 *
 * The unconditional tier (`PHYSICAL_GYM_MATCH_DISTANCE_METERS`, 20 m) only
 * catches cross-provider pins that land almost on top of each other. Prod data
 * shows the same physical gym drifts 40–90 m between providers, so a wider tier
 * is needed to stop every new provider minting a twin. To avoid false merges in
 * dense urban areas, the wider tier only fires for a specific, non-generic
 * normalized name — generic names (`home wall`, `garage`, bare board brands, …)
 * are far too likely to collide across genuinely distinct walls, so they only
 * ever match at the 20 m tier.
 */
export const GYM_MATCH_GUARDED_DISTANCE_METERS = 150;

/**
 * Normalized names that are too generic to safely match at the guarded (150 m)
 * tier. Built from prod reality: home walls, garages, cellars, and bare board
 * brand names show up on unrelated gyms all over a city. Compared
 * case-insensitively against the already-normalized gym name (see
 * `isGenericGymName`), so entries here are lowercase and single-spaced.
 *
 * Kept as an append-only exported constant so it can be shared with the gym
 * dedup admin tooling without a rebase conflict.
 *
 * Matching is exact on the whole normalized name, never a substring — so
 * `Kilter Kingpin` or `Tension Climbing Co` are NOT generic and still dedupe at
 * 150 m. The trade-off is that a commercial gym named exactly `Tension` or
 * `Moon` won't auto-merge across providers at the guarded tier; it still merges
 * at the 20 m tier, and the admin dedup queue catches the rest. Board-brand
 * names used as a standalone gym name collide across unrelated home setups far
 * more often than they name a real gym, so this is the safe default.
 */
export const GENERIC_GYM_NAMES: readonly string[] = [
  'home wall',
  'homewall',
  'home',
  'garage',
  'cellar',
  'basement',
  'kilter',
  'kilter board',
  'tension',
  'moonboard',
  'moon',
];

const GENERIC_GYM_NAME_SET = new Set<string>(GENERIC_GYM_NAMES);

/**
 * True when a gym name is too generic to match at the guarded (150 m) tier.
 * Normalizes first, so casing and repeated whitespace never matter.
 */
export function isGenericGymName(name: string): boolean {
  return GENERIC_GYM_NAME_SET.has(normalizeGymName(name));
}
