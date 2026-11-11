/**
 * BA-02 evidence report, database half. Every read shares one
 * `REPEATABLE READ READ ONLY` transaction. It never selects password hashes,
 * provider subjects or token values.
 *
 * No user ID or address is ever sent as a bind parameter. A server that logs
 * slow or all statements writes their parameters to its log, so each
 * statement derives the shared-address members itself from `MEMBER_IDS`, and
 * every parameter is a number from the code.
 */
import { createHash } from 'node:crypto';
import { and, count, eq, gt, isNull, notExists, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import {
  accounts,
  authEmailVerificationTokens,
  authPasswordRecoveryTokens,
  mobileRefreshTokens,
  userCredentials,
  userProfiles,
  users,
} from '@boardsesh/db/schema/auth';
import { boardseshTicks, communityRoles, gymMembers, gyms, userActivityDays } from '@boardsesh/db/schema/app';
import {
  ACCOUNT_EMAIL_EVIDENCE_LIMITS,
  AccountEmailEvidenceError,
  assertEvidenceSession,
  causedByOthersRowRule,
  FIXED_SYSTEM_ACCOUNT_IDS,
  groupUsersByNormalizedEmail,
  referencingColumnKey,
  type CollectedEvidence,
  type EvidenceMemberFacts,
  type EvidenceUserRow,
  type PendingLinks,
  type ReferencingColumn,
  type VerifiedStamp,
} from './evidence';

/** A code constant as an SQL string literal. Refuses anything that could need escaping. */
function constantLiteral(value: string): SQL {
  if (!/^[A-Za-z0-9_.":-]+$/.test(value)) throw new Error('Unsafe evidence SQL constant.');
  return sql.raw(`'${value}'`);
}

/** Tables read by name. A missing one means the schema is not the one this report understands. */
const NAMED_TABLES = [
  'public.users',
  'public.user_credentials',
  'public.accounts',
  'public.user_profiles',
  'public.mobile_refresh_tokens',
  'public."verificationTokens"',
  'public.auth_email_verification_tokens',
  'public.auth_password_recovery_tokens',
  'public.community_roles',
  'public.gyms',
  'public.gym_members',
  'public.user_activity_days',
  'public.boardsesh_ticks',
] as const;
const NAMED_TABLE_ARRAY = sql`ARRAY[${sql.join(NAMED_TABLES.map(constantLiteral), sql`, `)}]::text[]`;
const FIXED_SYSTEM_ID_LIST = sql`(${sql.join(FIXED_SYSTEM_ACCOUNT_IDS.map(constantLiteral), sql`, `)})`;

/** JS `String.prototype.trim`'s whitespace set as a regex class, so SQL groups like `trim().toLowerCase()`. */
const JS_TRIM_CLASS = String.raw`[\t\n\v\f\r    -     　﻿]`;
const JS_TRIM_PATTERN = sql.raw(`'^${JS_TRIM_CLASS}+|${JS_TRIM_CLASS}+$'`);

function sqlAccountKey(email: SQL): SQL {
  return sql`pg_catalog.lower(pg_catalog.regexp_replace(${email}, ${JS_TRIM_PATTERN}, '', 'g'))`;
}

/**
 * Every user whose address another user shares, derived inside the statement
 * that uses it. It carries no data, so the statement text and parameters say
 * nothing about who is in a group. JS grouping stays the authority: the
 * snapshot fails with GROUPING_MISMATCH if the two sets differ.
 */
const MEMBER_IDS = sql`(SELECT grouped_user.id FROM "public"."users" AS grouped_user
  WHERE ${sqlAccountKey(sql`grouped_user.email`)} IN (
    SELECT ${sqlAccountKey(sql`shared_user.email`)} FROM "public"."users" AS shared_user
    GROUP BY 1 HAVING pg_catalog.count(*) > 1))`;

export interface AccountEmailEvidenceSnapshotOptions {
  /** A primary is refused unless the owner passes `--allow-primary`. */
  readonly allowPrimary: boolean;
  readonly maximumMs?: number;
}

function sqlErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function requireSafeCount(total: unknown): number {
  const parsed = typeof total === 'string' ? Number(total) : total;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 0)
    throw new AccountEmailEvidenceError('INVALID_ROW');
  return parsed;
}

/** Collects every fact the worksheet needs from one read-only snapshot. */
export async function collectAccountEmailEvidence(
  client: postgres.Sql,
  options: AccountEmailEvidenceSnapshotOptions,
): Promise<CollectedEvidence> {
  const limits = ACCOUNT_EMAIL_EVIDENCE_LIMITS;
  const maximumMs = options.maximumMs ?? limits.maximumMs;
  if (!Number.isSafeInteger(maximumMs) || maximumMs < 1 || maximumMs > limits.maximumMs)
    throw new AccountEmailEvidenceError('CONFIGURATION');
  const started = performance.now();
  const checkTime = () => {
    if (performance.now() - started >= maximumMs) throw new AccountEmailEvidenceError('TIME_LIMIT');
  };
  try {
    return await drizzle(client).transaction(
      async (transaction) => {
        await transaction.execute(sql`SELECT pg_catalog.set_config('statement_timeout', '60000ms', true),
        pg_catalog.set_config('lock_timeout', '5000ms', true),
        pg_catalog.set_config('idle_in_transaction_session_timeout', '120000ms', true),
        pg_catalog.set_config('row_security', 'off', true),
        pg_catalog.set_config('standard_conforming_strings', 'on', true),
        pg_catalog.set_config('TimeZone', 'UTC', true),
        pg_catalog.set_config('search_path', 'pg_catalog', true)`);
        const [observed] = await transaction.execute<{
          isolation: string;
          readOnly: string;
          startedAt: string;
          databaseName: string;
          serverAddress: string | null;
          serverPort: number | null;
          serverVersion: string;
          inRecovery: boolean;
          replayAgeSeconds: number | null;
        }>(sql`SELECT pg_catalog.current_setting('transaction_isolation') AS isolation,
        pg_catalog.current_setting('transaction_read_only') AS "readOnly",
        pg_catalog.to_char(pg_catalog.transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startedAt",
        pg_catalog.current_database() AS "databaseName",
        pg_catalog.inet_server_addr()::text AS "serverAddress",
        pg_catalog.inet_server_port() AS "serverPort",
        pg_catalog.current_setting('server_version_num') AS "serverVersion",
        pg_catalog.pg_is_in_recovery() AS "inRecovery",
        CASE WHEN pg_catalog.pg_is_in_recovery()
          THEN EXTRACT(EPOCH FROM pg_catalog.now() - pg_catalog.pg_last_xact_replay_timestamp())::float8 END AS "replayAgeSeconds"`);
        if (!observed) throw new AccountEmailEvidenceError('SNAPSHOT_UNAVAILABLE');
        // Refuse before any user row is read.
        assertEvidenceSession(observed, options.allowPrimary);
        checkTime();

        const [presence] = await transaction.execute<{ missing: number }>(sql`SELECT
          pg_catalog.count(*) FILTER (WHERE pg_catalog.to_regclass(required.name) IS NULL)::integer AS missing
          FROM pg_catalog.unnest(${NAMED_TABLE_ARRAY}) AS required(name)`);
        if (presence?.missing !== 0) throw new AccountEmailEvidenceError('CATALOG_MISMATCH');

        // Every foreign key to users(id), read from the live catalog so a new
        // table counts without a code change. Partition clones are skipped;
        // counting the partitioned parent already covers them.
        const [unsupported] = await transaction.execute<{
          total: number;
        }>(sql`SELECT pg_catalog.count(*)::integer AS total
          FROM pg_catalog.pg_constraint AS constraint_row
          WHERE constraint_row.contype = 'f'
            AND constraint_row.confrelid = 'public.users'::pg_catalog.regclass
            AND constraint_row.conparentid = 0
            AND NOT EXISTS (
              SELECT 1 FROM pg_catalog.unnest(constraint_row.confkey) AS referenced(attnum)
              JOIN pg_catalog.pg_attribute AS referenced_column
                ON referenced_column.attrelid = constraint_row.confrelid AND referenced_column.attnum = referenced.attnum
              WHERE referenced_column.attname = 'id')`);
        if (unsupported?.total !== 0) throw new AccountEmailEvidenceError('CATALOG_MISMATCH');
        const catalogRows = await transaction.execute<{
          schema: string;
          table: string;
          column: string;
          indexed: boolean;
        }>(sql`SELECT namespace.nspname AS "schema", relation.relname AS "table", referencing_column.attname AS "column",
            EXISTS (SELECT 1 FROM pg_catalog.pg_index AS index_row
              WHERE index_row.indrelid = relation.oid AND index_row.indkey[0] = referencing_column.attnum
                AND index_row.indisvalid) AS indexed
          FROM pg_catalog.pg_constraint AS constraint_row
          JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_row.conrelid
          JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          CROSS JOIN LATERAL ROWS FROM (pg_catalog.unnest(constraint_row.conkey), pg_catalog.unnest(constraint_row.confkey))
            AS pair(attnum, referenced_attnum)
          JOIN pg_catalog.pg_attribute AS referencing_column
            ON referencing_column.attrelid = constraint_row.conrelid AND referencing_column.attnum = pair.attnum
          JOIN pg_catalog.pg_attribute AS referenced_column
            ON referenced_column.attrelid = constraint_row.confrelid AND referenced_column.attnum = pair.referenced_attnum
          WHERE constraint_row.contype = 'f'
            AND constraint_row.confrelid = 'public.users'::pg_catalog.regclass
            AND constraint_row.conparentid = 0
            AND referenced_column.attname = 'id'
          GROUP BY relation.oid, referencing_column.attnum, namespace.nspname, relation.relname, referencing_column.attname
          ORDER BY 1, 2, 3
          LIMIT ${limits.maxReferencingColumns + 1}`);
        if (catalogRows.length === 0 || catalogRows.length > limits.maxReferencingColumns)
          throw new AccountEmailEvidenceError('CATALOG_MISMATCH');
        const referencingColumns: ReferencingColumn[] = catalogRows.map((row) => ({
          schema: row.schema,
          table: row.table,
          column: row.column,
          indexed: row.indexed === true,
        }));
        checkTime();

        const [initial] = await transaction.select({ total: count() }).from(sql`"public".${users}`);
        const totalUsers = requireSafeCount(initial?.total);
        if (totalUsers > limits.maxUsers) throw new AccountEmailEvidenceError('INPUT_LIMIT');
        // TEXT has no length limit. CASE caps a field before the driver allocates it.
        const capped = (value: SQL) =>
          sql<
            string | null
          >`CASE WHEN pg_catalog.octet_length(${users.email}) <= ${limits.maxFieldBytes} THEN ${value} END`;
        const userRows = await transaction
          .select({
            userId: sql<
              string | null
            >`CASE WHEN pg_catalog.octet_length(${users.id}) <= ${limits.maxFieldBytes} THEN ${users.id} END`,
            email: capped(sql`${users.email}`),
            sqlLower: capped(sql`pg_catalog.lower(${users.email})`),
            sqlLowerTwice: capped(sql`pg_catalog.lower(pg_catalog.lower(${users.email}))`),
          })
          .from(sql`"public".${users}`)
          .limit(limits.maxUsers + 1);
        if (userRows.length !== totalUsers) throw new AccountEmailEvidenceError('COUNT_MISMATCH');
        const evidenceUsers: EvidenceUserRow[] = userRows.map((row) => {
          if (row.userId === null || row.email === null || row.sqlLower === null || row.sqlLowerTwice === null)
            throw new AccountEmailEvidenceError('INPUT_LIMIT');
          return { userId: row.userId, email: row.email, sqlLower: row.sqlLower, sqlLowerTwice: row.sqlLowerTwice };
        });
        if (new Set(evidenceUsers.map((user) => user.userId)).size !== evidenceUsers.length)
          throw new AccountEmailEvidenceError('INVALID_ROW');
        checkTime();

        const [loginless] = await transaction
          .select({
            total: count(),
            fixed: sql<number>`pg_catalog.count(*) FILTER (WHERE ${users.id} IN ${FIXED_SYSTEM_ID_LIST})::integer`,
          })
          .from(sql`"public".${users}`)
          .where(
            and(
              notExists(
                transaction
                  .select({ present: sql`1` })
                  .from(sql`"public".${userCredentials}`)
                  .where(eq(userCredentials.userId, users.id)),
              ),
              // Facebook sign-in is off, so a Facebook-only link is no login method.
              notExists(
                transaction
                  .select({ present: sql`1` })
                  .from(sql`"public".${accounts}`)
                  .where(and(eq(accounts.userId, users.id), sql`${accounts.provider} <> 'facebook'`)),
              ),
            ),
          );
        checkTime();

        // JS grouping is the authority; MEMBER_IDS must find the same users.
        const memberIds = groupUsersByNormalizedEmail(evidenceUsers).flatMap((group) =>
          group.users.map((user) => user.userId),
        );
        if (memberIds.length > limits.maxMembers) throw new AccountEmailEvidenceError('INPUT_LIMIT');
        const memberSet = new Set(memberIds);
        const requireMember = (userId: string) => {
          if (!memberSet.has(userId)) throw new AccountEmailEvidenceError('GROUPING_MISMATCH');
          return userId;
        };
        const isMember = (column: SQLWrapper) => sql`${column} IN ${MEMBER_IDS}`;

        const basics = await transaction
          .select({
            userId: sql<string>`${users.id}`,
            name: sql<string | null>`pg_catalog.left(${users.name}, 256)`,
            joinedAt: sql<string>`(${users.createdAt})::text`,
            emailVerifiedAt: sql<string | null>`(${users.emailVerified})::text`,
            verifiedStamp: sql<VerifiedStamp>`CASE WHEN ${users.emailVerified} IS NULL THEN 'none'
              WHEN ${users.emailVerified} <= ${users.createdAt} + interval '60 seconds' THEN 'at_signup'
              ELSE 'later' END`,
            // Password signup required verification from 2026-01-05 00:49 to 2026-01-12 05:32 UTC (#581, #588).
            stampedLaterWhileVerificationRequired: sql<boolean>`COALESCE(
              ${users.emailVerified} > ${users.createdAt} + interval '60 seconds'
              AND ${users.emailVerified} >= timestamp '2026-01-05 00:49:00'
              AND ${users.emailVerified} < timestamp '2026-01-12 05:33:00', false)`,
          })
          .from(sql`"public".${users}`)
          .where(isMember(users.id));
        const profiles = await transaction
          .select({
            userId: sql<string>`${userProfiles.userId}`,
            displayName: sql<string | null>`pg_catalog.left(${userProfiles.displayName}, 256)`,
          })
          .from(sql`"public".${userProfiles}`)
          .where(isMember(userProfiles.userId));
        const passwords = await transaction
          .selectDistinct({ userId: sql<string>`${userCredentials.userId}` })
          .from(sql`"public".${userCredentials}`)
          .where(isMember(userCredentials.userId));
        const providers = await transaction
          .selectDistinct({
            userId: sql<string>`${accounts.userId}`,
            provider: sql<string>`pg_catalog.left(${accounts.provider}, 64)`,
          })
          .from(sql`"public".${accounts}`)
          .where(isMember(accounts.userId));
        const liveTokens = await transaction
          .select({ userId: sql<string>`${mobileRefreshTokens.userId}`, live: count() })
          .from(sql`"public".${mobileRefreshTokens}`)
          .where(
            and(
              isMember(mobileRefreshTokens.userId),
              isNull(mobileRefreshTokens.revokedAt),
              gt(mobileRefreshTokens.expiresAt, sql`pg_catalog.now()`),
            ),
          )
          .groupBy(mobileRefreshTokens.userId);
        checkTime();
        // Legacy links are keyed by the address text at issue time, so join on the stored string.
        const legacyLinks = await transaction.execute<{ userId: string; reset: number; verify: number }>(sql`SELECT
            member.id AS "userId",
            pg_catalog.count(*) FILTER (WHERE link.identifier = 'password-reset:' || member.email)::integer AS reset,
            pg_catalog.count(*) FILTER (WHERE link.identifier = member.email)::integer AS verify
          FROM "public"."users" AS member
          JOIN "public"."verificationTokens" AS link
            ON link.identifier IN (member.email, 'password-reset:' || member.email)
          WHERE member.id IN ${MEMBER_IDS} AND link.expires > pg_catalog.now()
          GROUP BY member.id`);
        const stagedRecovery = await transaction
          .select({
            userId: sql<string>`${authPasswordRecoveryTokens.userId}`,
            live: sql<number>`pg_catalog.count(*) FILTER (WHERE ${authPasswordRecoveryTokens.consumedAt} IS NULL
              AND ${authPasswordRecoveryTokens.supersededAt} IS NULL
              AND ${authPasswordRecoveryTokens.expiresAt} > pg_catalog.now())::integer`,
          })
          .from(sql`"public".${authPasswordRecoveryTokens}`)
          .where(isMember(authPasswordRecoveryTokens.userId))
          .groupBy(authPasswordRecoveryTokens.userId);
        const stagedVerification = await transaction
          .select({
            userId: sql<string>`${authEmailVerificationTokens.userId}`,
            live: sql<number>`pg_catalog.count(*) FILTER (WHERE ${authEmailVerificationTokens.consumedAt} IS NULL
              AND ${authEmailVerificationTokens.supersededAt} IS NULL
              AND ${authEmailVerificationTokens.expiresAt} > pg_catalog.now())::integer`,
            consumed: sql<number>`pg_catalog.count(*) FILTER (WHERE ${authEmailVerificationTokens.consumedAt} IS NOT NULL)::integer`,
          })
          .from(sql`"public".${authEmailVerificationTokens}`)
          .where(isMember(authEmailVerificationTokens.userId))
          .groupBy(authEmailVerificationTokens.userId);
        const roles = await transaction
          .select({
            userId: sql<string>`${communityRoles.userId}`,
            role: sql<string>`(${communityRoles.role})::text`,
            boardType: sql<string | null>`pg_catalog.left(${communityRoles.boardType}, 64)`,
          })
          .from(sql`"public".${communityRoles}`)
          .where(isMember(communityRoles.userId));
        const ownedGyms = await transaction
          .select({ userId: sql<string>`${gyms.ownerId}`, owned: count() })
          .from(sql`"public".${gyms}`)
          .where(and(isMember(gyms.ownerId), isNull(gyms.deletedAt)))
          .groupBy(gyms.ownerId);
        const gymAdmins = await transaction
          .select({ userId: sql<string>`${gymMembers.userId}`, admins: count() })
          .from(sql`"public".${gymMembers}`)
          .where(and(isMember(gymMembers.userId), sql`(${gymMembers.role})::text = 'admin'`))
          .groupBy(gymMembers.userId);
        const activity = await transaction
          .select({
            userId: sql<string>`${userActivityDays.userId}`,
            lastDay: sql<string | null>`pg_catalog.max(${userActivityDays.day})::text`,
          })
          .from(sql`"public".${userActivityDays}`)
          .where(isMember(userActivityDays.userId))
          .groupBy(userActivityDays.userId);
        const ticks = await transaction
          .select({
            userId: sql<string>`${boardseshTicks.userId}`,
            lastTick: sql<string | null>`pg_catalog.max(${boardseshTicks.climbedAt})::text`,
          })
          .from(sql`"public".${boardseshTicks}`)
          .where(isMember(boardseshTicks.userId))
          .groupBy(boardseshTicks.userId);
        checkTime();

        // One statement per referencing column keeps each under the 60 s
        // statement timeout and lets the planner hash the member set.
        const rowsByMember = new Map<string, Record<string, number>>();
        for (const column of referencingColumns) {
          const key = referencingColumnKey(column);
          const referencingColumn = sql`referencing.${sql.identifier(column.column)}`;
          // A row-level exclusion (a pending invite from someone else) is counted under its own key.
          const split = causedByOthersRowRule(column);
          const splitCondition = split ? sql`COALESCE((${sql.raw(split.condition)}), false)` : undefined;
          const counted = await transaction.execute<{ userId: string; total: number; split: number }>(sql`SELECT
              ${referencingColumn}::text AS "userId",
              ${splitCondition ? sql`pg_catalog.count(*) FILTER (WHERE NOT ${splitCondition})` : sql`pg_catalog.count(*)`}::integer AS total,
              ${splitCondition ? sql`pg_catalog.count(*) FILTER (WHERE ${splitCondition})` : sql`0`}::integer AS split
            FROM ${sql.identifier(column.schema)}.${sql.identifier(column.table)} AS referencing
            WHERE ${referencingColumn} IN ${MEMBER_IDS}
            GROUP BY 1`);
          for (const row of counted) {
            const rows = rowsByMember.get(requireMember(row.userId)) ?? {};
            const own = requireSafeCount(row.total);
            const others = requireSafeCount(row.split);
            if (own > 0) rows[key] = own;
            if (split && others > 0) rows[`${key}:${split.label}`] = others;
            rowsByMember.set(row.userId, rows);
          }
          checkTime();
        }

        const byMember = <Row extends { userId: string }>(rows: readonly Row[]) => {
          const grouped = new Map<string, Row[]>();
          for (const row of rows) grouped.set(requireMember(row.userId), [...(grouped.get(row.userId) ?? []), row]);
          return grouped;
        };
        const profileByMember = byMember(profiles);
        const passwordByMember = byMember(passwords);
        const providersByMember = byMember(providers);
        const tokensByMember = byMember(liveTokens);
        const legacyByMember = byMember([...legacyLinks]);
        const recoveryByMember = byMember(stagedRecovery);
        const verificationByMember = byMember(stagedVerification);
        const rolesByMember = byMember(roles);
        const gymsByMember = byMember(ownedGyms);
        const gymAdminsByMember = byMember(gymAdmins);
        const activityByMember = byMember(activity);
        const ticksByMember = byMember(ticks);
        const sum = <Row extends { userId: string }>(
          grouped: Map<string, Row[]>,
          userId: string,
          pick: (row: Row) => unknown,
        ) => (grouped.get(userId) ?? []).reduce((total, row) => total + requireSafeCount(pick(row)), 0);

        const members = new Map<string, EvidenceMemberFacts>();
        for (const basic of basics) {
          const userId = requireMember(basic.userId);
          if (members.has(userId) || !['none', 'at_signup', 'later'].includes(basic.verifiedStamp))
            throw new AccountEmailEvidenceError('INVALID_ROW');
          const pendingLinks: PendingLinks = {
            legacyReset: sum(legacyByMember, userId, (row) => row.reset),
            legacyVerify: sum(legacyByMember, userId, (row) => row.verify),
            stagedRecovery: sum(recoveryByMember, userId, (row) => row.live),
            stagedVerification: sum(verificationByMember, userId, (row) => row.live),
          };
          members.set(userId, {
            userId,
            name: basic.name,
            profileDisplayName: profileByMember.get(userId)?.[0]?.displayName ?? null,
            joinedAt: basic.joinedAt,
            emailVerifiedAt: basic.emailVerifiedAt,
            verifiedStamp: basic.verifiedStamp,
            stampedLaterWhileVerificationRequired: basic.stampedLaterWhileVerificationRequired === true,
            hasPassword: passwordByMember.has(userId),
            providers: (providersByMember.get(userId) ?? []).map((row) => row.provider),
            liveRefreshTokens: sum(tokensByMember, userId, (row) => row.live),
            lastActiveDay: activityByMember.get(userId)?.[0]?.lastDay ?? null,
            lastTickAt: ticksByMember.get(userId)?.[0]?.lastTick ?? null,
            communityRoles: (rolesByMember.get(userId) ?? []).map((row) => `${row.role}:${row.boardType ?? 'global'}`),
            gymsOwned: sum(gymsByMember, userId, (row) => row.owned),
            gymAdminMemberships: sum(gymAdminsByMember, userId, (row) => row.admins),
            pendingLinks,
            stagedVerificationCompleted: sum(verificationByMember, userId, (row) => row.consumed) > 0,
            rowsByColumn: rowsByMember.get(userId) ?? {},
          });
        }
        if (members.size !== memberSet.size) throw new AccountEmailEvidenceError('GROUPING_MISMATCH');

        const [final] = await transaction.select({ total: count() }).from(sql`"public".${users}`);
        if (requireSafeCount(final?.total) !== totalUsers) throw new AccountEmailEvidenceError('COUNT_MISMATCH');
        checkTime();
        return {
          snapshot: {
            startedAt: observed.startedAt,
            target: observed.inRecovery ? 'standby' : 'primary',
            isolation: 'repeatable read',
            readOnly: true,
            replayAgeSeconds:
              typeof observed.replayAgeSeconds === 'number' ? Math.round(observed.replayAgeSeconds * 10) / 10 : null,
            serverVersion: observed.serverVersion,
            targetFingerprint: createHash('sha256')
              .update(
                JSON.stringify({
                  database: observed.databaseName,
                  address: observed.serverAddress,
                  port: observed.serverPort,
                }),
              )
              .digest('hex'),
          },
          referencingColumns,
          users: evidenceUsers,
          members,
          usersWithoutLoginMethod: requireSafeCount(loginless?.total),
          fixedSystemAccountsWithoutLogin: requireSafeCount(loginless?.fixed),
        } satisfies CollectedEvidence;
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  } catch (error) {
    if (error instanceof AccountEmailEvidenceError) throw error;
    // 57014: a statement hit its 60 s timeout. 40001 on a standby: replay cancelled the snapshot; rerun.
    const code = sqlErrorCode(error);
    if (code === '57014') throw new AccountEmailEvidenceError('TIME_LIMIT');
    // 55P03: another session held a lock for 5 s (a deploy's ALTER, or replay on a standby).
    if (code === '55P03') throw new AccountEmailEvidenceError('LOCK_TIMEOUT');
    if (code === '40001') throw new AccountEmailEvidenceError('STANDBY_CONFLICT');
    // Database exceptions can contain row content, connection strings or SQL.
    throw new AccountEmailEvidenceError('SNAPSHOT_UNAVAILABLE');
  }
}
