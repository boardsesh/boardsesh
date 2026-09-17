import { z } from 'zod';

const cursorSchema = z.object({
  version: z.literal(1),
  viewerId: z.string().min(1),
  snapshotAt: z.string().datetime(),
  occurredAt: z.string().datetime(),
  id: z.string().min(1).max(512),
});

export type CrewCursor = z.infer<typeof cursorSchema>;
export type CrewCandidate = { id: string; occurredAt: string; kind: 'session' | 'climb'; sourceId: string };

export function decodeCrewCursor(cursor: string | null | undefined, viewerId: string): CrewCursor | null {
  if (!cursor) return null;
  try {
    const parsed = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    if (parsed.viewerId !== viewerId || Date.parse(parsed.snapshotAt) > Date.now()) throw new Error('Invalid cursor');
    return parsed;
  } catch {
    throw new Error('Invalid Crew feed cursor');
  }
}

export function encodeCrewCursor(cursor: CrewCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

/** Each source contributes at most limit + 1 candidates; paginate their union. */
export function selectCrewCandidates(candidates: CrewCandidate[], limit: number) {
  const sorted = [...candidates].sort((left, right) => {
    if (left.occurredAt !== right.occurredAt) return left.occurredAt < right.occurredAt ? 1 : -1;
    return left.id === right.id ? 0 : left.id < right.id ? 1 : -1;
  });
  return { selected: sorted.slice(0, limit), hasMore: sorted.length > limit };
}
