import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { and, asc, eq, inArray, isNull, lt, ne } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { CreateWorkout } from '@boardsesh/public-api';
import { localSettings, logbookStates, logbookTicks, workoutDrafts } from './db/schema';
import { McpError, type Profile, type ProfileStore } from './types';

export interface WorkoutDraft {
  id: string;
  accountId: string;
  generation: string;
  body: CreateWorkout;
  idempotencyKey: string;
  expiresAt: string;
  result?: unknown;
}

export interface SyncStatus {
  complete: boolean;
  lastSyncedAt: string | null;
  syncing: boolean;
  fullSyncRequired: boolean;
}

/** All mutating operations are invoked under the cross-process profile lock. */
export class LocalStore implements ProfileStore {
  readonly database: Database.Database;
  readonly db;
  readonly owner = String(process.pid);
  readonly readOnly: boolean;

  constructor(
    readonly dataDir: string,
    readonly assertHeld: () => void = () => {},
    { readOnly = false }: { readOnly?: boolean } = {},
  ) {
    assertHeld();
    this.readOnly = readOnly;
    if (!readOnly) mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const directoryAttributes = lstatSync(dataDir, { throwIfNoEntry: false });
    if (!directoryAttributes) {
      throw new McpError(
        'history_unavailable',
        'No local history exists yet. Run boardsesh-mcp login and boardsesh-mcp sync.',
      );
    }
    if (!directoryAttributes.isDirectory() || directoryAttributes.isSymbolicLink()) {
      throw new McpError('unsafe_storage', 'The data directory must be a real, user-private directory.');
    }
    if (!readOnly && process.platform !== 'win32') chmodSync(dataDir, 0o700);
    const databasePath = join(dataDir, 'history.sqlite');
    for (const filename of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      const attributes = lstatSync(filename, { throwIfNoEntry: false });
      if (attributes && (!attributes.isFile() || attributes.isSymbolicLink())) {
        throw new McpError('unsafe_storage', 'SQLite files must be regular files, not links.');
      }
      if (readOnly && filename === databasePath && !attributes) {
        throw new McpError(
          'history_unavailable',
          'No local history exists yet. Run boardsesh-mcp login and boardsesh-mcp sync.',
        );
      }
    }
    this.database = new Database(databasePath, { readonly: readOnly, fileMustExist: readOnly });
    this.db = drizzle(this.database);
    try {
      this.database.pragma('busy_timeout = 5000');
      if (!readOnly) {
        if (process.platform !== 'win32') chmodSync(databasePath, 0o600);
        this.database.pragma('journal_mode = WAL');
        this.database.pragma('foreign_keys = ON');
        migrate(this.db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
        for (const filename of [`${databasePath}-wal`, `${databasePath}-shm`]) {
          if (process.platform !== 'win32' && existsSync(filename)) chmodSync(filename, 0o600);
        }
      }
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  getProfile(): Profile | undefined {
    return this.db.select().from(localSettings).where(eq(localSettings.key, 'profile')).get()?.profile;
  }

  setProfile(profile: Profile): void {
    this.assertWritable();
    this.db
      .insert(localSettings)
      .values({ key: 'profile', profile })
      .onConflictDoUpdate({
        target: localSettings.key,
        set: { profile },
      })
      .run();
  }

  /** Publish login and discard other accounts' local history in one transaction. */
  activateProfile(profile: Profile): void {
    this.assertWritable();
    if (profile.authStatus !== 'connected')
      throw new McpError('invalid_profile', 'Only a connected account can become the active profile.');
    this.db.transaction((transaction) => {
      transaction.delete(logbookTicks).where(ne(logbookTicks.accountId, profile.accountId)).run();
      transaction.delete(logbookStates).where(ne(logbookStates.accountId, profile.accountId)).run();
      transaction
        .insert(localSettings)
        .values({ key: 'profile', profile })
        .onConflictDoUpdate({
          target: localSettings.key,
          set: { profile },
        })
        .run();
      this.resetSync(profile);
    });
  }

  assertProfile(generation: string): Profile {
    this.assertHeld();
    const profile = this.getProfile();
    if (!profile || profile.authStatus !== 'connected') {
      throw new McpError('login_required', 'Run boardsesh-mcp login to connect Boardsesh.');
    }
    if (profile.generation !== generation) {
      throw new McpError('profile_changed', 'The connected account changed. Retry with the current profile.');
    }
    return profile;
  }

  assertAccount(profile: Profile): Profile {
    const current = this.assertProfile(profile.generation);
    if (
      current.accountId !== profile.accountId ||
      current.subject !== profile.subject ||
      current.clientId !== profile.clientId ||
      current.issuer !== profile.issuer
    ) {
      throw new McpError('profile_changed', 'The connected account changed.');
    }
    return current;
  }

  resetSync(profile: Profile): void {
    this.assertWritable();
    this.assertAccount(profile);
    this.db.transaction((transaction) => {
      const previous = transaction
        .select()
        .from(logbookStates)
        .where(eq(logbookStates.accountId, profile.accountId))
        .get();
      if (previous?.stagingVersion) {
        transaction
          .delete(logbookTicks)
          .where(and(eq(logbookTicks.accountId, profile.accountId), eq(logbookTicks.version, previous.stagingVersion)))
          .run();
      }
      transaction
        .insert(logbookStates)
        .values({ accountId: profile.accountId, fullSyncRequired: true })
        .onConflictDoUpdate({
          target: logbookStates.accountId,
          set: {
            fullSyncRequired: true,
            catchingUp: false,
            inFlight: false,
            stagingVersion: null,
            stagingOwner: null,
            cursor: null,
          },
        })
        .run();
    });
  }

  getSyncState(profile: Profile) {
    this.assertAccount(profile);
    const state = this.db.select().from(logbookStates).where(eq(logbookStates.accountId, profile.accountId)).get();
    return (
      state ?? {
        accountId: profile.accountId,
        activeVersion: null,
        stagingVersion: null,
        stagingOwner: null,
        cursor: null,
        fullSyncRequired: true,
        catchingUp: false,
        inFlight: false,
        lastSyncedAt: null,
      }
    );
  }

  getSyncStatus(profile: Profile): SyncStatus {
    const state = this.getSyncState(profile);
    return {
      complete: state.activeVersion !== null,
      lastSyncedAt: state.lastSyncedAt,
      syncing: state.stagingVersion !== null || state.catchingUp,
      fullSyncRequired: state.fullSyncRequired,
    };
  }

  /** Clean bounded yields can resume; a crashed bootstrap owner forces a fresh snapshot. */
  beginSync(profile: Profile) {
    this.assertWritable();
    let state = this.getSyncState(profile);
    if (
      state.stagingVersion &&
      state.inFlight &&
      state.stagingOwner !== this.owner &&
      !ownerIsAlive(state.stagingOwner)
    ) {
      this.resetSync(profile);
      state = this.getSyncState(profile);
    }
    if (state.fullSyncRequired && !state.stagingVersion) {
      const stagingVersion = randomUUID();
      this.db
        .insert(logbookStates)
        .values({ ...state, stagingVersion, stagingOwner: this.owner, inFlight: true })
        .onConflictDoUpdate({
          target: logbookStates.accountId,
          set: { stagingVersion, stagingOwner: this.owner, cursor: null, inFlight: true },
        })
        .run();
    } else {
      this.db
        .update(logbookStates)
        .set({ inFlight: true, ...(state.stagingVersion ? { stagingOwner: this.owner } : {}) })
        .where(eq(logbookStates.accountId, profile.accountId))
        .run();
    }
    return this.getSyncState(profile);
  }

  finishSync(profile: Profile): void {
    this.assertWritable();
    this.assertAccount(profile);
    this.db.update(logbookStates).set({ inFlight: false }).where(eq(logbookStates.accountId, profile.accountId)).run();
  }

  private assertWritable(): void {
    this.assertHeld();
    if (this.readOnly) throw new McpError('read_only_storage', 'This history connection is read-only.');
  }

  putDraft(draft: WorkoutDraft): void {
    this.assertWritable();
    const profile = this.assertProfile(draft.generation);
    if (profile.accountId !== draft.accountId)
      throw new McpError('profile_changed', 'The draft belongs to another account.');
    const expiresAt = Date.parse(draft.expiresAt);
    if (!Number.isFinite(expiresAt)) throw new McpError('invalid_input', 'Draft expiry must be an ISO timestamp.');
    this.db.transaction((transaction) => {
      // Expired requests may still need reconciliation after an ambiguous POST.
      // Keep a full seven days after expiry, and retain known remote identities.
      const expired = transaction
        .select({ id: workoutDrafts.id })
        .from(workoutDrafts)
        .where(and(lt(workoutDrafts.expiresAt, Date.now() - 7 * 86_400_000), isNull(workoutDrafts.result)))
        .orderBy(asc(workoutDrafts.expiresAt), asc(workoutDrafts.id))
        .limit(100)
        .all();
      if (expired.length > 0)
        transaction
          .delete(workoutDrafts)
          .where(
            inArray(
              workoutDrafts.id,
              expired.map(({ id }) => id),
            ),
          )
          .run();
      transaction
        .insert(workoutDrafts)
        .values({ ...draft, expiresAt })
        .run();
    });
  }

  getDraft(id: string, profile: Profile): WorkoutDraft | undefined {
    this.assertAccount(profile);
    const draft = this.db
      .select()
      .from(workoutDrafts)
      .where(
        and(
          eq(workoutDrafts.id, id),
          eq(workoutDrafts.accountId, profile.accountId),
          eq(workoutDrafts.generation, profile.generation),
        ),
      )
      .get();
    return draft
      ? { ...draft, expiresAt: new Date(draft.expiresAt).toISOString(), result: draft.result ?? undefined }
      : undefined;
  }

  saveDraftResult(id: string, profile: Profile, result: unknown): void {
    this.assertWritable();
    if (!this.getDraft(id, profile))
      throw new McpError('draft_not_found', 'This workout draft is unavailable for the connected account.');
    this.db
      .update(workoutDrafts)
      .set({ result })
      .where(
        and(
          eq(workoutDrafts.id, id),
          eq(workoutDrafts.accountId, profile.accountId),
          eq(workoutDrafts.generation, profile.generation),
        ),
      )
      .run();
  }

  discardOldVersions(profile: Profile, activeVersion: string): void {
    this.assertWritable();
    this.assertAccount(profile);
    this.db
      .delete(logbookTicks)
      .where(and(eq(logbookTicks.accountId, profile.accountId), ne(logbookTicks.version, activeVersion)))
      .run();
  }
}

function ownerIsAlive(owner: string | null): boolean {
  if (!owner || !/^\d+$/.test(owner) || Number(owner) < 1) return false;
  try {
    process.kill(Number(owner), 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}
