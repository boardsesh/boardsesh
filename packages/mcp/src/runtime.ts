import { ApiClient, recoverCredentialState, assertCachedCredentials } from './auth';
import { ensurePrivateDirectory, withProfileLock } from './profile-lock';
import { LocalStore } from './storage';
import { syncLogbook } from './sync';
import { McpError, type Profile } from './types';
import { requireScope } from './workouts';

export class Runtime {
  constructor(readonly dataDir: string) {}

  async withStore<Result>(
    operation: (store: LocalStore, client: ApiClient) => Promise<Result> | Result,
  ): Promise<Result> {
    await ensurePrivateDirectory(this.dataDir);
    return withProfileLock(this.dataDir, async (guard) => {
      const store = new LocalStore(this.dataDir, () => guard.assertHeld());
      try {
        await recoverCredentialState({ dataDir: this.dataDir, store, guard });
        return await operation(store, new ApiClient({ dataDir: this.dataDir, store, guard }));
      } finally {
        store.close();
      }
    });
  }

  async withProfile<Result>(
    scope: string | undefined,
    operation: (store: LocalStore, client: ApiClient, profile: Profile) => Promise<Result> | Result,
  ): Promise<Result> {
    return this.withStore((store, client) => {
      const current = store.getProfile();
      if (!current) throw new McpError('login_required', 'Run boardsesh-mcp login in a terminal, then try again.');
      const profile = store.assertProfile(current.generation);
      if (scope) requireScope(profile, scope);
      return operation(store, client, profile);
    });
  }

  async status() {
    await ensurePrivateDirectory(this.dataDir);
    let store: LocalStore;
    try {
      store = new LocalStore(this.dataDir, undefined, { readOnly: true });
    } catch (error) {
      if (error instanceof McpError && error.code === 'history_unavailable')
        return { connected: false, authStatus: 'logged_out', nextAction: 'Run boardsesh-mcp login in a terminal.' };
      throw error;
    }
    try {
      const profile = store.getProfile();
      if (!profile)
        return { connected: false, authStatus: 'logged_out', nextAction: 'Run boardsesh-mcp login in a terminal.' };
      if (profile.authStatus === 'connected') {
        try {
          await assertCachedCredentials({ dataDir: this.dataDir, store });
        } catch (error) {
          if (error instanceof McpError && error.code === 'reconnect_required')
            return {
              connected: false,
              authStatus: 'reconnect_required',
              nextAction: 'Run boardsesh-mcp login in a terminal.',
            };
          throw error;
        }
      }
      return store.db.transaction(() => {
        const current = store.getProfile();
        if (!current || current.generation !== profile.generation)
          throw new McpError('profile_changed', 'The connected account changed. Retry the status check.');
        return {
          connected: current.authStatus === 'connected',
          authStatus: current.authStatus,
          scopes: current.scopes,
          subject: current.subject,
          ...(current.authStatus === 'connected'
            ? { history: store.getSyncStatus(current) }
            : { nextAction: 'Run boardsesh-mcp login in a terminal.' }),
          offlinePolicy:
            'Cached history remains readable offline. Remote revocation is detected on the next online check.',
        };
      });
    } finally {
      store.close();
    }
  }

  /** WAL readers do not wait for a writer doing network I/O. A single SQLite
   * snapshot binds the authorized profile to all returned history rows. */
  async withCachedProfile<Result>(
    scope: string,
    operation: (store: LocalStore, profile: Profile) => Result,
  ): Promise<Result> {
    await ensurePrivateDirectory(this.dataDir);
    const store = new LocalStore(this.dataDir, undefined, { readOnly: true });
    try {
      const profile = await assertCachedCredentials({ dataDir: this.dataDir, store });
      return store.db.transaction(() => {
        const current = store.assertAccount(profile);
        requireScope(current, scope);
        return operation(store, current);
      });
    } finally {
      store.close();
    }
  }

  async sync() {
    return this.withProfile('logbook:read', (store, client, profile) => syncLogbook(store, client, profile));
  }
}
