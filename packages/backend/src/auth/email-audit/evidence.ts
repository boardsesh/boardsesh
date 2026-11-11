/**
 * BA-02 evidence report, pure half: what counts as a member's own data, how a
 * shared-address group is classified, and what the private worksheet and the
 * counts-only summary contain. The database half is `evidence-snapshot.ts`.
 */
import {
  HOLD_CLASSIFIER_USER_ID,
  RECOMMENDATIONS_USER_ID,
  SYSTEM_BOARD_OWNER_ID,
} from '@boardsesh/db/queries/constants';
import { normalizeAccountEmail } from '../normalize-email';

export const ACCOUNT_EMAIL_EVIDENCE_FORMAT_VERSION = 1;

export const ACCOUNT_EMAIL_EVIDENCE_LIMITS = Object.freeze({
  maxUsers: 100000,
  maxFieldBytes: 4096,
  maxMembers: 2000,
  maxReferencingColumns: 1000,
  maxWorksheetBytes: 16777216,
  statementTimeoutMs: 60000,
  /** Whole run, including every per-table count. One statement is capped at 60 s. */
  maximumMs: 900000,
});

export type AccountEmailEvidenceErrorCode =
  | 'CONFIGURATION'
  | 'OUTPUT_EXISTS'
  | 'OUTPUT_INSIDE_REPOSITORY'
  | 'OUTPUT_FOLDER_NOT_PRIVATE'
  | 'OUTPUT_UNAVAILABLE'
  | 'NOT_READ_ONLY'
  | 'PRIMARY_NOT_ALLOWED'
  | 'CATALOG_MISMATCH'
  | 'INPUT_LIMIT'
  | 'INVALID_ROW'
  | 'COUNT_MISMATCH'
  | 'GROUPING_MISMATCH'
  | 'TIME_LIMIT'
  | 'LOCK_TIMEOUT'
  | 'STANDBY_CONFLICT'
  | 'SNAPSHOT_UNAVAILABLE';

/** The message is fixed: database errors can carry row content, SQL or a URL. */
export class AccountEmailEvidenceError extends Error {
  constructor(readonly code: AccountEmailEvidenceErrorCode) {
    super('Account email evidence could not complete.');
    this.name = 'AccountEmailEvidenceError';
  }
}

/**
 * The worksheet is written only from a REPEATABLE READ READ ONLY snapshot.
 * A primary also needs the owner's explicit `--allow-primary`: the plan runs
 * this on the DR standby so the per-table counts put no load on production.
 */
export function assertEvidenceSession(
  observed: { readonly isolation: string; readonly readOnly: string; readonly inRecovery: boolean },
  allowPrimary: boolean,
): void {
  if (observed.isolation !== 'repeatable read' || observed.readOnly !== 'on')
    throw new AccountEmailEvidenceError('NOT_READ_ONLY');
  if (observed.inRecovery !== true && !allowPrimary) throw new AccountEmailEvidenceError('PRIMARY_NOT_ALLOWED');
}

/** Any code point above U+007F. Only these can lowercase differently in SQL and JS. */
export function hasNonAscii(text: string): boolean {
  return /\P{ASCII}/u.test(text);
}

/** The three fixed system identities. None has a password or provider link. */
export const FIXED_SYSTEM_ACCOUNT_IDS: readonly string[] = Object.freeze([
  SYSTEM_BOARD_OWNER_ID,
  RECOMMENDATIONS_USER_ID,
  HOLD_CLASSIFIER_USER_ID,
]);

export interface ReferencingColumn {
  readonly schema: string;
  readonly table: string;
  readonly column: string;
  readonly indexed: boolean;
}

export interface OwnDataRules {
  /** Identity housekeeping: profile, credentials, provider links, tokens, sessions, devices. */
  readonly housekeepingTables: readonly string[];
  readonly housekeepingTablePrefixes: readonly string[];
  /** Computed for every user, so a row says nothing about use of the account. */
  readonly derivedTables: readonly string[];
  /** Columns whose every row another person caused: things received rather than done. */
  readonly causedByOthers: readonly { readonly table: string; readonly column: string }[];
  /**
   * Rows of an otherwise own-data column that another person caused, split out
   * by a fixed SQL condition and counted under `<schema.table.column>:<label>`.
   */
  readonly causedByOthersRows: readonly CausedByOthersRowRule[];
}

export interface CausedByOthersRowRule {
  readonly table: string;
  readonly column: string;
  readonly label: string;
  /** Code constant over the referencing table's own columns. Never user input. */
  readonly condition: string;
}

/**
 * Owner decision of 2026-11-11: "real data" means OWN data. That is the plan's
 * rule (any row referencing users, minus identity housekeeping) minus
 * `user_climb_percentiles` and minus rows other people caused. It is the
 * audit's q2 "own_data" definition plus three received-row exclusions q2 did
 * not have: follow requests received, community roles granted, and pending
 * invites from someone else. Analytics activity days stay own data.
 */
export const OWN_DATA_RULES: OwnDataRules = Object.freeze({
  housekeepingTables: Object.freeze([
    'users',
    'user_profiles',
    'user_credentials',
    'accounts',
    'mobile_refresh_tokens',
    'sessions',
    'notification_devices',
    'activity_push_tokens',
    'notification_deliveries',
    'user_analytics_consent_events',
  ]),
  housekeepingTablePrefixes: Object.freeze(['auth_', 'oauth_']),
  derivedTables: Object.freeze(['user_climb_percentiles']),
  causedByOthers: Object.freeze([
    Object.freeze({ table: 'feed_items', column: 'recipient_id' }),
    Object.freeze({ table: 'notifications', column: 'recipient_id' }),
    Object.freeze({ table: 'user_follows', column: 'following_id' }),
    Object.freeze({ table: 'user_follow_requests', column: 'recipient_id' }),
    // An admin grants the role; the grantor's `granted_by` stays own data.
    Object.freeze({ table: 'community_roles', column: 'user_id' }),
  ]),
  causedByOthersRows: Object.freeze([
    Object.freeze({
      table: 'resource_grants',
      column: 'user_id',
      label: 'pending-invite',
      condition: "status = 'pending' AND invited_by IS NOT NULL AND invited_by <> user_id",
    }),
  ]),
});

export type ReferencingColumnRole = 'own-data' | 'housekeeping' | 'derived' | 'caused-by-others';

export function referencingColumnRole(
  column: Pick<ReferencingColumn, 'table' | 'column'>,
  rules: OwnDataRules = OWN_DATA_RULES,
): ReferencingColumnRole {
  if (
    rules.housekeepingTables.includes(column.table) ||
    rules.housekeepingTablePrefixes.some((prefix) => column.table.startsWith(prefix))
  )
    return 'housekeeping';
  if (rules.derivedTables.includes(column.table)) return 'derived';
  if (rules.causedByOthers.some((rule) => rule.table === column.table && rule.column === column.column))
    return 'caused-by-others';
  return 'own-data';
}

export function referencingColumnKey(column: Pick<ReferencingColumn, 'schema' | 'table' | 'column'>): string {
  return `${column.schema}.${column.table}.${column.column}`;
}

/** The row-split rules the snapshot applies to a column: at most one. */
export function causedByOthersRowRule(
  column: Pick<ReferencingColumn, 'table' | 'column'>,
  rules: OwnDataRules = OWN_DATA_RULES,
): CausedByOthersRowRule | undefined {
  const matching = rules.causedByOthersRows.filter(
    (rule) => rule.table === column.table && rule.column === column.column,
  );
  if (matching.length > 1) throw new AccountEmailEvidenceError('CATALOG_MISMATCH');
  return matching[0];
}

/**
 * Every row key a snapshot may report, with its role under `rules`. A split
 * key the rules no longer exclude falls back to its column's role, so a
 * mutated rule set still reads a snapshot taken under the default rules.
 */
export function referencingRowKeyRoles(
  columns: readonly ReferencingColumn[],
  rules: OwnDataRules = OWN_DATA_RULES,
): Map<string, { readonly column: ReferencingColumn; readonly role: ReferencingColumnRole }> {
  const roles = new Map<string, { readonly column: ReferencingColumn; readonly role: ReferencingColumnRole }>();
  for (const column of columns) {
    const key = referencingColumnKey(column);
    const role = referencingColumnRole(column, rules);
    roles.set(key, { column, role });
    const split = causedByOthersRowRule(column, OWN_DATA_RULES);
    if (split)
      roles.set(`${key}:${split.label}`, {
        column,
        role: causedByOthersRowRule(column, rules)?.label === split.label ? 'caused-by-others' : role,
      });
  }
  return roles;
}

export type GroupKind = 'A' | 'B' | 'C' | 'D' | 'E';
export const GROUP_KINDS: readonly GroupKind[] = Object.freeze(['A', 'B', 'C', 'D', 'E']);

export const GROUP_KIND_MEANINGS: Readonly<Record<GroupKind, string>> = Object.freeze({
  A: 'Two or more members have their own data. Email the address; the mailbox holder picks the keeper. No merge.',
  B: 'One member has data and no verified stamp; an empty member has a stamp. A bare stamp is not proof, so this follows the C/D rule with no email.',
  C: 'One member has data. The rest have no data, no live provider link and no live refresh token.',
  D: 'One member has data. An empty member still has a live provider link or refresh token, which keeps working after its address is retired.',
  E: 'No member has data. Keep one with a login method.',
});

export interface ClassifiableMember {
  readonly hasOwnData: boolean;
  readonly stamped: boolean;
  readonly hasLiveProvider: boolean;
  readonly hasLiveRefreshToken: boolean;
}

/** Same order and tests as the audit's q2 kind query. */
export function classifyGroup(members: readonly ClassifiableMember[]): GroupKind {
  const dataHolders = members.filter((member) => member.hasOwnData);
  if (dataHolders.length >= 2) return 'A';
  const [dataHolder] = dataHolders;
  if (!dataHolder) return 'E';
  const emptyMembers = members.filter((member) => !member.hasOwnData);
  if (!dataHolder.stamped && emptyMembers.some((member) => member.stamped)) return 'B';
  if (emptyMembers.some((member) => member.hasLiveProvider || member.hasLiveRefreshToken)) return 'D';
  return 'C';
}

export interface EvidenceSnapshotMetadata {
  readonly startedAt: string;
  readonly target: 'standby' | 'primary';
  readonly isolation: 'repeatable read';
  readonly readOnly: true;
  readonly replayAgeSeconds: number | null;
  readonly serverVersion: string;
  /** SHA-256 of database name, server address and port. Never a DSN or role. */
  readonly targetFingerprint: string;
}

export interface EvidenceUserRow {
  readonly userId: string;
  readonly email: string;
  /** SQL `lower(email)` from the same snapshot. */
  readonly sqlLower: string;
  /** SQL `lower(lower(email))`: shows whether SQL lowercasing is stable on this row. */
  readonly sqlLowerTwice: string;
}

export interface PendingLinks {
  readonly legacyReset: number;
  readonly legacyVerify: number;
  readonly stagedRecovery: number;
  readonly stagedVerification: number;
}

export type VerifiedStamp = 'none' | 'at_signup' | 'later';

export interface EvidenceMemberFacts {
  readonly userId: string;
  readonly name: string | null;
  readonly profileDisplayName: string | null;
  /** Stored `timestamp` text, UTC. */
  readonly joinedAt: string;
  readonly emailVerifiedAt: string | null;
  readonly verifiedStamp: VerifiedStamp;
  /** Stamped more than 60 s after signup while password signup required verification (2026-01-05 to 01-12). */
  readonly stampedLaterWhileVerificationRequired: boolean;
  readonly hasPassword: boolean;
  /** Distinct provider names only. Never subjects or tokens. */
  readonly providers: readonly string[];
  readonly liveRefreshTokens: number;
  readonly lastActiveDay: string | null;
  readonly lastTickAt: string | null;
  /** `role:scope` pairs, for example `admin:global`. */
  readonly communityRoles: readonly string[];
  readonly gymsOwned: number;
  readonly gymAdminMemberships: number;
  readonly pendingLinks: PendingLinks;
  readonly stagedVerificationCompleted: boolean;
  /** Non-zero row counts keyed by `schema.table.column` (plus `:label` for a split), for every referencing column. */
  readonly rowsByColumn: Readonly<Record<string, number>>;
}

export interface CollectedEvidence {
  readonly snapshot: EvidenceSnapshotMetadata;
  readonly referencingColumns: readonly ReferencingColumn[];
  readonly users: readonly EvidenceUserRow[];
  readonly members: ReadonlyMap<string, EvidenceMemberFacts>;
  readonly usersWithoutLoginMethod: number;
  readonly fixedSystemAccountsWithoutLogin: number;
}

export interface SharedAddressGroup {
  readonly address: string;
  readonly users: readonly EvidenceUserRow[];
}

/** Groups by the JS rule, `trim().toLowerCase()`, in address order. */
export function groupUsersByNormalizedEmail(users: readonly EvidenceUserRow[]): SharedAddressGroup[] {
  const byAddress = new Map<string, EvidenceUserRow[]>();
  for (const user of users) {
    const address = normalizeAccountEmail(user.email);
    const existing = byAddress.get(address);
    if (existing) existing.push(user);
    else byAddress.set(address, [user]);
  }
  return [...byAddress]
    .filter(([, members]) => members.length > 1)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([address, members]) => ({ address, users: members }));
}

const DATA_SUMMARY_CATEGORIES: Readonly<Record<string, keyof Omit<DataSummary, 'other'>>> = Object.freeze({
  boardsesh_ticks: 'ticks',
  playlists: 'playlists',
  playlist_ownership: 'playlists',
  playlist_climbs: 'playlists',
  board_climbs: 'climbsSet',
  user_boards: 'wallsAndBoards',
  spray_walls: 'wallsAndBoards',
  user_follows: 'followsGiven',
  setter_follows: 'followsGiven',
  board_follows: 'followsGiven',
  gym_follows: 'followsGiven',
  playlist_follows: 'followsGiven',
  board_sessions: 'sessions',
  board_session_participants: 'sessions',
  session_workouts: 'sessions',
});

export interface DataSummary {
  readonly ticks: number;
  readonly playlists: number;
  readonly climbsSet: number;
  readonly wallsAndBoards: number;
  readonly followsGiven: number;
  readonly sessions: number;
  readonly other: number;
}

export type MailboxProof = 'google-or-apple' | 'staged-verification' | 'verified-while-required';

export interface WorksheetMember {
  readonly member: string;
  readonly userId: string;
  readonly storedEmail: string;
  readonly storedEmailIsNormalized: boolean;
  readonly name: string | null;
  readonly profileDisplayName: string | null;
  readonly joinedAt: string;
  readonly emailVerifiedAt: string | null;
  readonly verifiedStamp: VerifiedStamp;
  readonly mailboxProof: MailboxProof | null;
  readonly hasPassword: boolean;
  readonly providers: readonly string[];
  readonly hasLoginMethod: boolean;
  readonly liveRefreshTokens: number;
  readonly lastActiveDay: string | null;
  readonly lastTickAt: string | null;
  readonly roles: {
    readonly community: readonly string[];
    readonly gymsOwned: number;
    readonly gymAdminMemberships: number;
  };
  readonly pendingLinks: PendingLinks;
  readonly hasOwnData: boolean;
  readonly ownData: { readonly summary: DataSummary; readonly rows: Readonly<Record<string, number>> };
  /** Housekeeping, derived and caused-by-others rows: shown, never counted as data. */
  readonly excludedRows: Readonly<Record<string, number>>;
}

export interface GroupProposal {
  readonly contact: boolean;
  /** A suggestion only. The owner records the keeper in the decision file. */
  readonly keep: string | null;
  readonly retireAddress: readonly string[];
  readonly reason: string;
}

export interface WorksheetGroup {
  readonly group: string;
  readonly address: string;
  readonly size: number;
  readonly kind: GroupKind;
  readonly exactDuplicateString: boolean;
  readonly proposal: GroupProposal;
  /** Latest activity day or tick; null when tied or unknown. */
  readonly mostRecentlyActive: string | null;
  readonly members: readonly WorksheetMember[];
}

export interface ContactEntry {
  readonly group: string;
  readonly address: string;
  readonly members: readonly {
    readonly member: string;
    readonly displayName: string | null;
    readonly joined: string;
  }[];
}

export interface EvidenceSummary {
  readonly users: number;
  readonly normalizedAddresses: number;
  readonly groups: number;
  readonly usersInGroups: number;
  readonly groupsBySize: Readonly<Record<string, number>>;
  readonly exactDuplicateStrings: number;
  readonly groupsWithExactDuplicateString: number;
  readonly groupsByKind: Readonly<Record<GroupKind, number>>;
  readonly contactEmails: number;
  readonly groupsWithProposedKeeper: number;
  readonly groupsWithoutProposedKeeper: number;
  readonly members: {
    readonly total: number;
    readonly withOwnData: number;
    readonly withPassword: number;
    readonly withGoogleOrApple: number;
    readonly withoutLoginMethod: number;
    readonly withLiveRefreshToken: number;
    readonly withPendingLink: number;
    readonly withMailboxProof: number;
  };
  readonly addresses: {
    readonly nonNormalized: number;
    readonly nonNormalizedInGroups: number;
    readonly nonNormalizedStandalone: number;
    readonly edgeWhitespace: number;
    readonly empty: number;
    readonly nonAscii: number;
    readonly sqlLowerDiffersFromJs: number;
    /**
     * Rows whose JS-normalized form is not proven to pass PR 5's
     * `email = lower(email)` check: SQL and JS lowercase it differently, or
     * SQL lowercasing is not stable on it. Only non-ASCII rows can count.
     */
    readonly normalizedFormsAtRiskInSqlCheck: number;
  };
  readonly login: {
    readonly usersWithoutLoginMethod: number;
    readonly fixedSystemAccountsWithoutLogin: number;
  };
  readonly catalog: {
    readonly referencingColumns: number;
    readonly referencingTables: number;
    readonly ownDataColumns: number;
    readonly excludedColumns: number;
    readonly unindexedColumns: number;
  };
  readonly checks: {
    readonly kindsSumToGroups: boolean;
    readonly sqlLowerMatchesJs: boolean;
    readonly noLoginRowsAreFixedSystemAccounts: boolean;
  };
}

export interface EvidenceWorksheet {
  readonly formatVersion: number;
  readonly document: 'boardsesh-account-email-evidence';
  readonly privacy: string;
  readonly snapshot: EvidenceSnapshotMetadata;
  readonly rules: {
    readonly ownData: string;
    readonly housekeepingTables: readonly string[];
    readonly housekeepingTablePrefixes: readonly string[];
    readonly derivedTables: readonly string[];
    readonly causedByOthers: readonly string[];
    readonly causedByOthersRows: readonly string[];
    readonly kinds: Readonly<Record<GroupKind, string>>;
  };
  readonly summary: EvidenceSummary;
  readonly contactList: readonly ContactEntry[];
  readonly groups: readonly WorksheetGroup[];
}

const GOOGLE_OR_APPLE = new Set(['google', 'apple']);

function memberLabel(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : `M${index + 1}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function emptyDataSummary(): { -readonly [Key in keyof DataSummary]: number } {
  return { ticks: 0, playlists: 0, climbsSet: 0, wallsAndBoards: 0, followsGiven: 0, sessions: 0, other: 0 };
}

interface LabelledMember extends ClassifiableMember {
  readonly label: string;
  readonly hasPassword: boolean;
  readonly hasLoginMethod: boolean;
}

function proposeFor(kind: GroupKind, members: readonly LabelledMember[]): GroupProposal {
  const retireAllBut = (keeper: LabelledMember) =>
    members.filter((member) => member !== keeper).map((member) => member.label);
  if (kind === 'A')
    return {
      contact: true,
      keep: null,
      retireAddress: [],
      reason: 'Two or more members have their own data. Email the address; the mailbox holder picks the keeper.',
    };
  if (kind === 'E') {
    const keeper =
      members.find((member) => member.hasPassword) ?? members.find((member) => member.hasLoginMethod) ?? null;
    if (!keeper)
      return {
        contact: false,
        keep: null,
        retireAddress: [],
        reason: 'No member has data or a login method. The owner decides.',
      };
    return {
      contact: false,
      keep: keeper.label,
      retireAddress: retireAllBut(keeper),
      reason: keeper.hasPassword
        ? 'No member has data. Keep the earliest member with a password.'
        : 'No member has data or a password. Keep the earliest member with a provider link.',
    };
  }
  const dataHolder = members.find((member) => member.hasOwnData);
  if (!dataHolder) throw new AccountEmailEvidenceError('INVALID_ROW');
  const reasons: Record<'B' | 'C' | 'D', string> = {
    B: 'Only this member has data. The empty member only has a verified stamp, which is not proof, so no email.',
    C: 'Only this member has data. The rest have no data, no live provider link and no live token.',
    D: 'Only this member has data. The empty member keeps its provider sign-in or signed-in device after retirement.',
  };
  return { contact: false, keep: dataHolder.label, retireAddress: retireAllBut(dataHolder), reason: reasons[kind] };
}

function latestActivity(facts: EvidenceMemberFacts): string | null {
  const days = [facts.lastActiveDay, facts.lastTickAt?.slice(0, 10) ?? null].filter(
    (day): day is string => day !== null,
  );
  return days.length ? days.reduce((latest, day) => (day > latest ? day : latest)) : null;
}

function addCount(target: Record<string, number>, key: string, amount: number) {
  target[key] = (target[key] ?? 0) + amount;
}

/** Builds the private worksheet and the counts-only summary from one snapshot's facts. */
export function buildAccountEmailEvidence(
  collected: CollectedEvidence,
  rules: OwnDataRules = OWN_DATA_RULES,
): { readonly worksheet: EvidenceWorksheet; readonly summary: EvidenceSummary } {
  const rowKeys = referencingRowKeyRoles(collected.referencingColumns, rules);
  const rawEmailCounts = new Map<string, number>();
  const normalizedAddresses = new Set<string>();
  for (const user of collected.users) {
    rawEmailCounts.set(user.email, (rawEmailCounts.get(user.email) ?? 0) + 1);
    normalizedAddresses.add(normalizeAccountEmail(user.email));
  }
  const sharedGroups = groupUsersByNormalizedEmail(collected.users);
  const groupLabelWidth = Math.max(2, String(sharedGroups.length).length);
  const groupedAddresses = new Set(sharedGroups.map((group) => group.address));

  const groups: WorksheetGroup[] = sharedGroups.map((sharedGroup, groupIndex) => {
    const exactDuplicateString = new Set(sharedGroup.users.map((user) => user.email)).size < sharedGroup.users.length;
    const ordered = sharedGroup.users
      .map((user) => {
        const facts = collected.members.get(user.userId);
        if (!facts) throw new AccountEmailEvidenceError('INVALID_ROW');
        return { user, facts };
      })
      .sort(
        (left, right) =>
          compareText(left.facts.joinedAt, right.facts.joinedAt) || compareText(left.user.userId, right.user.userId),
      );
    const built = ordered.map(({ user, facts }, memberIndex): { member: WorksheetMember; flags: LabelledMember } => {
      const summary = emptyDataSummary();
      const ownRows: Record<string, number> = {};
      const excludedRows: Record<string, number> = {};
      for (const [key, rows] of Object.entries(facts.rowsByColumn)) {
        const rowKey = rowKeys.get(key);
        if (!rowKey || !Number.isSafeInteger(rows) || rows < 0) throw new AccountEmailEvidenceError('INVALID_ROW');
        const { column, role } = rowKey;
        if (rows === 0) continue;
        if (role !== 'own-data') {
          addCount(excludedRows, key, rows);
          continue;
        }
        addCount(ownRows, key, rows);
        summary[DATA_SUMMARY_CATEGORIES[column.table] ?? 'other'] += rows;
      }
      const hasOwnData = Object.keys(ownRows).length > 0;
      const providers = [...new Set(facts.providers)].sort(compareText);
      const hasGoogleOrApple = providers.some((provider) => GOOGLE_OR_APPLE.has(provider));
      // Facebook sign-in is off, so a Facebook-only link is no login method.
      const hasLiveProvider = providers.some((provider) => provider !== 'facebook');
      const hasLoginMethod = facts.hasPassword || hasLiveProvider;
      // Verify stamps every row with the same string, so a shared string's stamp proves nothing.
      const mailboxProof: MailboxProof | null = hasGoogleOrApple
        ? 'google-or-apple'
        : facts.stagedVerificationCompleted
          ? 'staged-verification'
          : facts.stampedLaterWhileVerificationRequired && !exactDuplicateString
            ? 'verified-while-required'
            : null;
      const label = memberLabel(memberIndex);
      const member: WorksheetMember = {
        member: label,
        userId: user.userId,
        storedEmail: user.email,
        storedEmailIsNormalized: user.email === sharedGroup.address,
        name: facts.name,
        profileDisplayName: facts.profileDisplayName,
        joinedAt: facts.joinedAt,
        emailVerifiedAt: facts.emailVerifiedAt,
        verifiedStamp: facts.verifiedStamp,
        mailboxProof,
        hasPassword: facts.hasPassword,
        providers,
        hasLoginMethod,
        liveRefreshTokens: facts.liveRefreshTokens,
        lastActiveDay: facts.lastActiveDay,
        lastTickAt: facts.lastTickAt,
        roles: {
          community: [...facts.communityRoles].sort(compareText),
          gymsOwned: facts.gymsOwned,
          gymAdminMemberships: facts.gymAdminMemberships,
        },
        pendingLinks: facts.pendingLinks,
        hasOwnData,
        ownData: { summary, rows: ownRows },
        excludedRows,
      };
      const flags: LabelledMember = {
        label,
        hasOwnData,
        stamped: facts.emailVerifiedAt !== null,
        hasLiveProvider,
        hasLiveRefreshToken: facts.liveRefreshTokens > 0,
        hasPassword: facts.hasPassword,
        hasLoginMethod,
      };
      return { member, flags };
    });
    const members = built.map((entry) => entry.member);
    const flags = built.map((entry) => entry.flags);
    const kind = classifyGroup(flags);
    const activity = ordered.map(({ facts }, index) => ({ label: memberLabel(index), day: latestActivity(facts) }));
    const latestDay = activity.reduce<string | null>(
      (latest, { day }) => (day !== null && (latest === null || day > latest) ? day : latest),
      null,
    );
    const latestMembers = activity.filter(({ day }) => latestDay !== null && day === latestDay);
    return {
      group: `G${String(groupIndex + 1).padStart(groupLabelWidth, '0')}`,
      address: sharedGroup.address,
      size: members.length,
      kind,
      exactDuplicateString,
      proposal: proposeFor(kind, flags),
      mostRecentlyActive: latestMembers.length === 1 ? (latestMembers[0]?.label ?? null) : null,
      members,
    };
  });

  const groupMembers = groups.flatMap((group) => group.members);
  const groupsByKind: Record<GroupKind, number> = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  const groupsBySize: Record<string, number> = {};
  for (const group of groups) {
    groupsByKind[group.kind] += 1;
    addCount(groupsBySize, String(group.size), 1);
  }
  let nonNormalized = 0;
  let nonNormalizedInGroups = 0;
  let edgeWhitespace = 0;
  let empty = 0;
  let nonAscii = 0;
  let sqlLowerDiffersFromJs = 0;
  let normalizedFormsAtRiskInSqlCheck = 0;
  for (const user of collected.users) {
    const normalized = normalizeAccountEmail(user.email);
    if (user.email !== normalized) {
      nonNormalized += 1;
      if (groupedAddresses.has(normalized)) nonNormalizedInGroups += 1;
    }
    if (user.email !== user.email.trim()) edgeWhitespace += 1;
    if (normalized === '') empty += 1;
    if (hasNonAscii(user.email)) nonAscii += 1;
    // Lowercasing never adds or removes whitespace, so this isolates case folding.
    if (user.sqlLower !== user.email.toLowerCase()) sqlLowerDiffersFromJs += 1;
    // When SQL and JS agree and SQL lowercasing is stable, lower(normalized) = normalized
    // (trimming never meets case), so the stored-form check passes.
    if (user.sqlLower !== user.email.toLowerCase() || user.sqlLowerTwice !== user.sqlLower)
      normalizedFormsAtRiskInSqlCheck += 1;
  }
  const kindTotal = GROUP_KINDS.reduce((total, kind) => total + groupsByKind[kind], 0);
  const ownDataColumns = collected.referencingColumns.filter(
    (column) => referencingColumnRole(column, rules) === 'own-data',
  ).length;
  const summary: EvidenceSummary = {
    users: collected.users.length,
    normalizedAddresses: normalizedAddresses.size,
    groups: groups.length,
    usersInGroups: groupMembers.length,
    groupsBySize,
    exactDuplicateStrings: [...rawEmailCounts.values()].filter((total) => total > 1).length,
    groupsWithExactDuplicateString: groups.filter((group) => group.exactDuplicateString).length,
    groupsByKind,
    contactEmails: groups.filter((group) => group.proposal.contact).length,
    groupsWithProposedKeeper: groups.filter((group) => group.proposal.keep !== null).length,
    groupsWithoutProposedKeeper: groups.filter((group) => group.proposal.keep === null).length,
    members: {
      total: groupMembers.length,
      withOwnData: groupMembers.filter((member) => member.hasOwnData).length,
      withPassword: groupMembers.filter((member) => member.hasPassword).length,
      withGoogleOrApple: groupMembers.filter((member) =>
        member.providers.some((provider) => GOOGLE_OR_APPLE.has(provider)),
      ).length,
      withoutLoginMethod: groupMembers.filter((member) => !member.hasLoginMethod).length,
      withLiveRefreshToken: groupMembers.filter((member) => member.liveRefreshTokens > 0).length,
      withPendingLink: groupMembers.filter((member) => Object.values(member.pendingLinks).some((total) => total > 0))
        .length,
      withMailboxProof: groupMembers.filter((member) => member.mailboxProof !== null).length,
    },
    addresses: {
      nonNormalized,
      nonNormalizedInGroups,
      nonNormalizedStandalone: nonNormalized - nonNormalizedInGroups,
      edgeWhitespace,
      empty,
      nonAscii,
      sqlLowerDiffersFromJs,
      normalizedFormsAtRiskInSqlCheck,
    },
    login: {
      usersWithoutLoginMethod: collected.usersWithoutLoginMethod,
      fixedSystemAccountsWithoutLogin: collected.fixedSystemAccountsWithoutLogin,
    },
    catalog: {
      referencingColumns: collected.referencingColumns.length,
      referencingTables: new Set(collected.referencingColumns.map((column) => `${column.schema}.${column.table}`)).size,
      ownDataColumns,
      excludedColumns: collected.referencingColumns.length - ownDataColumns,
      unindexedColumns: collected.referencingColumns.filter((column) => !column.indexed).length,
    },
    checks: {
      kindsSumToGroups: kindTotal === groups.length,
      sqlLowerMatchesJs: sqlLowerDiffersFromJs === 0 && normalizedFormsAtRiskInSqlCheck === 0,
      noLoginRowsAreFixedSystemAccounts:
        collected.usersWithoutLoginMethod === FIXED_SYSTEM_ACCOUNT_IDS.length &&
        collected.fixedSystemAccountsWithoutLogin === FIXED_SYSTEM_ACCOUNT_IDS.length,
    },
  };

  const contactList: ContactEntry[] = groups
    .filter((group) => group.proposal.contact)
    .map((group) => ({
      group: group.group,
      address: group.address,
      members: group.members.map((member) => ({
        member: member.member,
        displayName: member.profileDisplayName ?? member.name,
        joined: member.joinedAt.slice(0, 7),
      })),
    }));

  const worksheet: EvidenceWorksheet = {
    formatVersion: ACCOUNT_EMAIL_EVIDENCE_FORMAT_VERSION,
    document: 'boardsesh-account-email-evidence',
    privacy:
      'Holds email addresses, names and user IDs. Keep it in ~/Private/boardsesh-ba02. Never paste it into GitHub, Discord, Sentry, chat or a PR.',
    snapshot: collected.snapshot,
    rules: {
      ownData:
        'Any row in a table that references users, except identity housekeeping, user_climb_percentiles, and rows other people caused.',
      housekeepingTables: rules.housekeepingTables,
      housekeepingTablePrefixes: rules.housekeepingTablePrefixes,
      derivedTables: rules.derivedTables,
      causedByOthers: rules.causedByOthers.map((rule) => `${rule.table}.${rule.column}`),
      causedByOthersRows: rules.causedByOthersRows.map(
        (rule) => `${rule.table}.${rule.column}:${rule.label} (${rule.condition})`,
      ),
      kinds: GROUP_KIND_MEANINGS,
    },
    summary,
    contactList,
    groups,
  };
  return { worksheet, summary };
}
