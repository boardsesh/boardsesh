import { createHash } from 'node:crypto';
import type {
  BetaLinksGqlRow,
  PublicClimbRelatedContent,
  PublicClimbRelatedContentInput,
  SimilarClimb,
} from '@boardsesh/shared-schema';

export const PUBLIC_RELATED_CACHE_MAX_ENTRIES = 20_000;
export const PUBLIC_RELATED_CACHE_MAX_BYTES = 4096;
export const PUBLIC_RELATED_MAX_ACTIVE = 8;
export const PUBLIC_RELATED_MAX_MISSES = 4;
export const PUBLIC_RELATED_DEADLINE_MS = 3000;
export const PUBLIC_RELATED_CACHE_PREFIX = 'boardsesh:{public-climb-related}:v1';

export function publicRelatedCacheTtlSeconds(rawDays: string | undefined): number {
  return (rawDays === '30' ? 30 : 7) * 86_400;
}

export type PublicRelatedCandidate = Pick<
  SimilarClimb,
  'uuid' | 'similarity' | 'sharedHoldCount' | 'candidateHoldCount' | 'targetHoldCount'
>;
export type PublicRelatedSnapshot = {
  similar: PublicRelatedCandidate[];
  nearby: PublicRelatedCandidate[];
  nearbyGrade: string | null;
  nearbyUnavailable?: boolean;
};
export type PublicRelatedTarget = { revision: string; difficulty: number | null };

export type PublicRelatedDependencies = {
  readTarget(input: PublicClimbRelatedContentInput): Promise<PublicRelatedTarget | null>;
  readCache(key: string): Promise<PublicRelatedSnapshot | null>;
  writeCache(key: string, snapshot: PublicRelatedSnapshot): Promise<void>;
  buildSnapshot(input: PublicClimbRelatedContentInput, target: PublicRelatedTarget): Promise<PublicRelatedSnapshot>;
  hydrate(
    input: PublicClimbRelatedContentInput,
    candidates: PublicRelatedCandidate[],
    target: PublicRelatedTarget,
  ): Promise<SimilarClimb[]>;
  readBeta(input: PublicClimbRelatedContentInput): Promise<{ links: BetaLinksGqlRow[]; hasMore: boolean }>;
  reportFailure(): void;
};

export function publicRelatedCacheKey(input: PublicClimbRelatedContentInput, target: PublicRelatedTarget): string {
  const normalized = [
    input.boardType,
    input.layoutId,
    input.sizeId,
    [...new Set(input.setIds)].sort((left, right) => left - right),
    input.angle,
    input.climbUuid,
    input.includeNearby !== false,
    target.revision,
    target.difficulty,
  ];
  return `${PUBLIC_RELATED_CACHE_PREFIX}:${createHash('sha256').update(JSON.stringify(normalized)).digest('hex')}`;
}

export function emptyPublicRelatedContent(unavailable = false): PublicClimbRelatedContent {
  return {
    similarStatus: unavailable ? 'unavailable' : 'loaded',
    similarClimbs: [],
    nearbyStatus: null,
    nearbyClimbs: [],
    nearbyGrade: null,
    betaStatus: unavailable ? 'unavailable' : 'loaded',
    betaLinks: [],
    betaHasMore: false,
  };
}

/** Slots belong to real work, including work that outlives its caller's deadline. */
export class PublicClimbRelatedContentService {
  private active = 0;
  private readonly misses = new Map<string, Promise<PublicRelatedSnapshot>>();
  private failures = 0;
  private rejected = 0;
  private cacheHits = 0;
  private cacheMisses = 0;

  constructor(
    private readonly dependencies: PublicRelatedDependencies,
    private readonly deadlineMs = PUBLIC_RELATED_DEADLINE_MS,
  ) {}

  getStats() {
    return {
      active: this.active,
      misses: this.misses.size,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      failures: this.failures,
      rejected: this.rejected,
    };
  }

  async read(input: PublicClimbRelatedContentInput): Promise<PublicClimbRelatedContent> {
    if (this.active >= PUBLIC_RELATED_MAX_ACTIVE) {
      this.rejected++;
      return emptyPublicRelatedContent(true);
    }
    this.active++;
    const started = this.readAdmitted(input)
      .catch(() => {
        this.failures++;
        this.dependencies.reportFailure();
        return emptyPublicRelatedContent(true);
      })
      .finally(() => {
        this.active--;
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        started,
        new Promise<PublicClimbRelatedContent>((resolve) => {
          timer = setTimeout(() => resolve(emptyPublicRelatedContent(true)), this.deadlineMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async readAdmitted(input: PublicClimbRelatedContentInput): Promise<PublicClimbRelatedContent> {
    if (input.boardType === 'spray') return emptyPublicRelatedContent();
    const target = await this.dependencies.readTarget(input);
    if (!target) return emptyPublicRelatedContent();
    const response = emptyPublicRelatedContent();
    await Promise.all([
      (async () => {
        try {
          const snapshot = await this.snapshot(input, target);
          const hydrated = await this.dependencies.hydrate(input, [...snapshot.similar, ...snapshot.nearby], target);
          const byUuid = new Map(hydrated.map((climb) => [climb.uuid, climb]));
          response.similarClimbs = snapshot.similar
            .flatMap((candidate) =>
              byUuid.get(candidate.uuid) ? [{ ...byUuid.get(candidate.uuid)!, ...candidate }] : [],
            )
            .slice(0, 10);
          if (snapshot.nearbyGrade !== null && input.includeNearby !== false) {
            response.nearbyStatus = snapshot.nearbyUnavailable ? 'unavailable' : 'loaded';
            response.nearbyGrade = snapshot.nearbyGrade;
            response.nearbyClimbs = snapshot.nearby
              .flatMap((candidate) =>
                byUuid.get(candidate.uuid) ? [{ ...byUuid.get(candidate.uuid)!, ...candidate }] : [],
              )
              .slice(0, 6);
          }
        } catch {
          response.similarStatus = 'unavailable';
          this.failures++;
          this.dependencies.reportFailure();
        }
      })(),
      (async () => {
        try {
          const beta = await this.dependencies.readBeta(input);
          response.betaLinks = beta.links;
          response.betaHasMore = beta.hasMore;
        } catch {
          response.betaStatus = 'unavailable';
          this.failures++;
          this.dependencies.reportFailure();
        }
      })(),
    ]);
    return response;
  }

  private async snapshot(
    input: PublicClimbRelatedContentInput,
    target: PublicRelatedTarget,
  ): Promise<PublicRelatedSnapshot> {
    const key = publicRelatedCacheKey(input, target);
    const cached = await this.dependencies.readCache(key);
    if (cached) {
      this.cacheHits++;
      return cached;
    }
    const joined = this.misses.get(key);
    if (joined) return joined;
    if (this.misses.size >= PUBLIC_RELATED_MAX_MISSES) {
      this.rejected++;
      throw new Error('Public recommendation refresh capacity reached');
    }
    this.cacheMisses++;
    const started = this.dependencies
      .buildSnapshot(input, target)
      .then(async (snapshot) => {
        if (snapshot.nearbyUnavailable) return snapshot;
        try {
          await this.dependencies.writeCache(key, snapshot);
        } catch {
          this.dependencies.reportFailure();
        }
        return snapshot;
      })
      .finally(() => {
        this.misses.delete(key);
      });
    this.misses.set(key, started);
    return started;
  }
}
