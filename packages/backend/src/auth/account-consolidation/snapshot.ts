import { captureConsolidationGroupState } from './state';
import { sql } from 'drizzle-orm';
import type postgres from 'postgres';
import { z } from 'zod';
import { buildAccountEmailEvidence } from '../email-audit/evidence';
import { collectAccountEmailEvidenceWith, sqlAccountKey } from '../email-audit/evidence-snapshot';
import { ConsolidationError, type ConsolidationTick } from './planner';

const text = z.string().max(4096);
const nullableText = text.nullable();
const tickSchema = z
  .object({
    rowFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    id: text.regex(/^[1-9]\d*$/),
    uuid: text.min(1),
    userId: text.min(1),
    boardType: text.min(1),
    climbUuid: text.min(1),
    angle: z.number().int(),
    climbedAt: text.min(1),
    isMirror: z.boolean().nullable(),
    status: z.enum(['flash', 'send', 'attempt']),
    attemptCount: z.number().int().positive(),
    quality: z.number().int().nullable(),
    difficulty: z.number().int().nullable(),
    isBenchmark: z.boolean().nullable(),
    comment: z.string().max(65536).nullable(),
    climbRevision: z.number().int().nullable(),
    origin: text.min(1),
    sessionId: nullableText,
    sessionOrigin: z.enum(['explicit', 'inferred']).nullable(),
    boardId: nullableText,
    auroraId: nullableText,
    auroraType: nullableText,
    kilterId: nullableText,
    kilterType: nullableText,
    kilterDetachedAt: nullableText,
    updatedAt: text.min(1),
  })
  .strict();

/** Bounded noncredential tick facts share the existing evidence transaction. */
export async function collectAccountConsolidationSnapshot(client: postgres.Sql, allowPrimary: boolean) {
  const collected = await collectAccountEmailEvidenceWith(
    client,
    { allowPrimary },
    async (transaction, evidence, checkTime) => {
      const ticks: ConsolidationTick[] = [];
      let bytes = 0;
      for (let offset = 0; offset <= 100000; offset += 100) {
        const rows = await transaction.execute<{
          payload: unknown;
        }>(sql`SELECT CASE WHEN pg_catalog.octet_length(pg_catalog.to_jsonb(tick)::text)<=65536 THEN
       pg_catalog.jsonb_build_object('rowFingerprint',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(tick)::text,'UTF8')),'hex'),'id',tick.id::text,'uuid',tick.uuid,'userId',tick.user_id,'boardType',tick.board_type,
       'climbUuid',tick.climb_uuid,'angle',tick.angle,'climbedAt',tick.climbed_at::text,'isMirror',tick.is_mirror,
       'status',tick.status,'attemptCount',tick.attempt_count,'quality',tick.quality,'difficulty',tick.difficulty,
       'isBenchmark',tick.is_benchmark,'comment',tick.comment,'climbRevision',tick.climb_revision,'origin',tick.origin,
       'sessionId',tick.session_id,'sessionOrigin',session.origin,'boardId',tick.board_id::text,'auroraId',tick.aurora_id,'auroraType',tick.aurora_type,
       'kilterId',tick.kilter_id,'kilterType',tick.kilter_type,'kilterDetachedAt',tick.kilter_detached_at::text,
       'updatedAt',tick.updated_at::text) END AS payload
       FROM public.boardsesh_ticks AS tick LEFT JOIN public.board_sessions AS session ON session.id=tick.session_id WHERE tick.user_id IN (
         SELECT member.id FROM public.users member WHERE ${sqlAccountKey(sql`member.email`)} IN (
           SELECT ${sqlAccountKey(sql`shared.email`)} FROM public.users shared GROUP BY 1 HAVING pg_catalog.count(*)>1))
       ORDER BY tick.id OFFSET ${offset} LIMIT 100`);
        checkTime();
        for (const row of rows) {
          const parsed = tickSchema.safeParse(row.payload);
          if (!parsed.success) throw new ConsolidationError('INVALID_EVIDENCE');
          bytes += Buffer.byteLength(JSON.stringify(parsed.data));
          if (bytes > 16777216 || ticks.length >= 100000) throw new ConsolidationError('INPUT_LIMIT');
          ticks.push(parsed.data);
        }
        if (rows.length < 100) break;
      }
      const worksheet = buildAccountEmailEvidence(evidence).worksheet;
      const referenceStates = new Map<string, Awaited<ReturnType<typeof captureConsolidationGroupState>>>();
      let stateRows = 0;
      let stateBytes = 0;
      for (const group of worksheet.groups) {
        const state = await captureConsolidationGroupState(
          transaction,
          group.members.map((member) => member.userId),
          checkTime,
        );
        stateRows += state.tables.reduce((total, table) => total + table.rows, 0);
        stateBytes += state.tables.reduce((total, table) => total + table.bytes, 0);
        if (stateRows > 100000 || stateBytes > 67108864) throw new ConsolidationError('INPUT_LIMIT');
        referenceStates.set(group.address, state);
      }
      return { ticks, worksheet, referenceStates };
    },
  );
  return collected.extra;
}
