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

/**
 * Order two candidate ids exactly as Postgres `COLLATE "C"` does.
 *
 * Both sides of the page boundary have to agree on the tie-break: SQL applies
 * the cursor, JS picks which candidates make the page. `COLLATE "C"` compares
 * UTF-8 BYTES, while JS `<` compares UTF-16 code units — and the two disagree
 * above the BMP, where a surrogate pair sorts below U+E000–U+FFFF in UTF-16 but
 * above it in UTF-8. A climb group's id carries the setter's username, so an
 * emoji in one is all it takes; disagreeing here would skip or duplicate a card
 * across a page boundary.
 */
function compareIdsLikePostgres(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

/** Each source contributes at most limit + 1 candidates; paginate their union. */
export function selectCrewCandidates(candidates: CrewCandidate[], limit: number) {
  const sorted = [...candidates].sort((left, right) => {
    // Timestamps are ASCII ISO-8601, so a plain compare already matches SQL.
    if (left.occurredAt !== right.occurredAt) return left.occurredAt < right.occurredAt ? 1 : -1;
    return -compareIdsLikePostgres(left.id, right.id);
  });
  return { selected: sorted.slice(0, limit), hasMore: sorted.length > limit };
}
