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
