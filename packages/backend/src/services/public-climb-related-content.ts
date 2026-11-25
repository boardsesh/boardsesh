import { createHash } from 'node:crypto';
import { getBoulderGradesForBoard } from '@boardsesh/board-constants/boulder-grade-mapping';
import type {
  BetaLinksGqlRow,
  BoardName,
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
export const PUBLIC_RELATED_RATE_LIMIT = 2400;

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
export type PublicRelatedNearbyInput = Pick<
  PublicClimbRelatedContentInput,
  'boardType' | 'layoutId' | 'sizeId' | 'setIds' | 'angle'
> & { minGrade: number; maxGrade: number };

export type PublicRelatedDependencies = {
  readTarget(this: void, input: PublicClimbRelatedContentInput): Promise<PublicRelatedTarget | null>;
  readCache(this: void, key: string): Promise<PublicRelatedSnapshot | null>;
  writeCache(this: void, key: string, snapshot: PublicRelatedSnapshot): Promise<void>;
  buildSnapshot(
    this: void,
    input: PublicClimbRelatedContentInput,
    target: PublicRelatedTarget,
  ): Promise<PublicRelatedSnapshot>;
  buildNearby(this: void, input: PublicRelatedNearbyInput): Promise<PublicRelatedSnapshot>;
  hydrate(
    this: void,
    input: PublicClimbRelatedContentInput,
    candidates: PublicRelatedCandidate[],
    target: PublicRelatedTarget,
  ): Promise<SimilarClimb[]>;
  readBeta(this: void, input: PublicClimbRelatedContentInput): Promise<{ links: BetaLinksGqlRow[]; hasMore: boolean }>;
  reportFailure(this: void): void;
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

export function publicRelatedNearbyCacheKey(input: PublicRelatedNearbyInput): string {
  const normalized = [
    input.boardType,
    input.layoutId,
    input.sizeId,
    [...new Set(input.setIds)].sort((left, right) => left - right),
    input.angle,
    input.minGrade,
    input.maxGrade,
  ];
  return `${PUBLIC_RELATED_CACHE_PREFIX}:nearby:${createHash('sha256').update(JSON.stringify(normalized)).digest('hex')}`;
}

function nearbyBand(input: PublicClimbRelatedContentInput, target: PublicRelatedTarget) {
  if (input.includeNearby === false || target.difficulty == null) return null;
  const grades = getBoulderGradesForBoard(input.boardType as BoardName);
  const targetGrade = grades.find((grade) => grade.difficulty_id === target.difficulty);
  if (!targetGrade) return null;
  const targetVGrade = Number(targetGrade.v_grade.slice(1));
  const band = grades.filter((grade) => Math.abs(Number(grade.v_grade.slice(1)) - targetVGrade) <= 1);
  const minGrade = band[0]?.difficulty_id;
  const maxGrade = band.at(-1)?.difficulty_id;
  if (minGrade == null || maxGrade == null) return null;
  return {
    grade: targetGrade.difficulty_name,
    input: {
      boardType: input.boardType,
      layoutId: input.layoutId,
      sizeId: input.sizeId,
      setIds: [...new Set(input.setIds)].sort((left, right) => left - right),
      angle: input.angle,
      minGrade,
      maxGrade,
    },
  };
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
          const snapshot = await this.cachedSnapshot(publicRelatedCacheKey(input, target), () =>
            this.dependencies.buildSnapshot(input, target),
          );
          const similar = await this.dependencies.hydrate(input, snapshot.similar, target);
          const similarByUuid = new Map(similar.map((climb) => [climb.uuid, climb]));
          response.similarClimbs = snapshot.similar
            .flatMap((candidate) =>
              similarByUuid.get(candidate.uuid) ? [{ ...similarByUuid.get(candidate.uuid)!, ...candidate }] : [],
            )
            .slice(0, 10);
          let nearby: PublicRelatedCandidate[] = [];
          const band = response.similarClimbs.length === 0 ? nearbyBand(input, target) : null;
          if (band) {
            response.nearbyGrade = band.grade;
            try {
              // The first miss is settled before acquiring a pool miss slot. Pool
              // IDs never enter the per-climb cache, so composition cannot extend
              // their TTL or retain a target-specific exclusion for another climb.
              const pool = await this.cachedSnapshot(publicRelatedNearbyCacheKey(band.input), () =>
                this.dependencies.buildNearby(band.input),
              );
              nearby = pool.nearby;
              response.nearbyStatus = 'loaded';
            } catch {
              response.nearbyStatus = 'unavailable';
              this.failures++;
              this.dependencies.reportFailure();
            }
          }
          if (band) {
            const hydrated = await this.dependencies.hydrate(input, nearby, target);
            const byUuid = new Map(hydrated.map((climb) => [climb.uuid, climb]));
            response.nearbyClimbs = nearby
              .flatMap((candidate) =>
                byUuid.get(candidate.uuid) ? [{ ...byUuid.get(candidate.uuid)!, ...candidate }] : [],
              )
              .slice(0, 6);
          }
        } catch {
          response.similarStatus = 'unavailable';
          if (response.nearbyStatus !== null) response.nearbyStatus = 'unavailable';
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

  private async cachedSnapshot(
    key: string,
    build: () => Promise<PublicRelatedSnapshot>,
  ): Promise<PublicRelatedSnapshot> {
    const cached = await this.dependencies.readCache(key);
    if (cached && !cached.nearbyUnavailable) {
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
    const started = build()
      .then(async (snapshot) => {
        if (snapshot.nearbyUnavailable) throw new Error('Incomplete nearby recommendation snapshot');
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
