import { eq, isNull, or } from 'drizzle-orm';
import { oauthClient } from '@boardsesh/db/schema/auth';
import { logger } from '../../utils/logger';
import type { PartnerDatabase } from './tables';

/** Long enough that preflights never reach Postgres, short enough that a suspended app stops quickly. */
const ORIGIN_CACHE_TTL_MS = 60_000;

interface RegisteredOriginSnapshot {
  originsByClient: Map<string, Set<string>>;
  allOrigins: Set<string>;
}

/** The registered, live browser origins partner CORS may answer. */
export interface PartnerRegisteredOrigins {
  isRegisteredOrigin(origin: string): Promise<boolean>;
  clientOwnsOrigin(clientId: string, origin: string): Promise<boolean>;
  /** Drop the cache after a client edit; other instances catch up within the TTL. */
  invalidate(): void;
}

function httpsOrigin(redirectUri: string): string | null {
  if (!URL.canParse(redirectUri)) return null;
  const parsed = new URL(redirectUri);
  return parsed.protocol === 'https:' ? parsed.origin : null;
}

async function readRegisteredOrigins(database: PartnerDatabase): Promise<RegisteredOriginSnapshot> {
  const clients = await database
    .select({ clientId: oauthClient.clientId, redirectUris: oauthClient.redirectUris })
    .from(oauthClient)
    .where(or(isNull(oauthClient.disabled), eq(oauthClient.disabled, false)));
  const originsByClient = new Map<string, Set<string>>();
  const allOrigins = new Set<string>();
  for (const client of clients) {
    const clientOrigins = new Set<string>();
    for (const redirectUri of client.redirectUris) {
      const origin = httpsOrigin(redirectUri);
      if (!origin) continue;
      clientOrigins.add(origin);
      allOrigins.add(origin);
    }
    originsByClient.set(client.clientId, clientOrigins);
  }
  return { originsByClient, allOrigins };
}

/**
 * A cached snapshot with one refresh at a time, so anonymous preflights cannot
 * queue on the pool. A failed refresh keeps the last snapshot until it ages out,
 * then treats every origin as unregistered, so CORS fails closed.
 */
export function createPartnerOriginDirectory(database: PartnerDatabase): PartnerRegisteredOrigins {
  const emptySnapshot: RegisteredOriginSnapshot = { originsByClient: new Map(), allOrigins: new Set() };
  let snapshot: RegisteredOriginSnapshot = emptySnapshot;
  let loadedAt = 0;
  let refreshing: Promise<void> | null = null;
  let cacheEpoch = 0;

  function refresh(): Promise<void> {
    refreshing ??= (async () => {
      const refreshEpoch = cacheEpoch;
      try {
        const fresh = await readRegisteredOrigins(database);
        if (refreshEpoch === cacheEpoch) {
          snapshot = fresh;
          loadedAt = Date.now();
        }
      } catch (error) {
        logger.error('Partner OAuth could not read registered origins', {
          errorName: error instanceof Error ? error.name : 'unknown',
        });
        if (Date.now() - loadedAt > ORIGIN_CACHE_TTL_MS * 5) snapshot = emptySnapshot;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  async function currentSnapshot(): Promise<RegisteredOriginSnapshot> {
    if (loadedAt === 0) await refresh();
    else if (Date.now() - loadedAt > ORIGIN_CACHE_TTL_MS) void refresh();
    return snapshot;
  }

  return {
    async isRegisteredOrigin(origin) {
      return (await currentSnapshot()).allOrigins.has(origin);
    },
    async clientOwnsOrigin(clientId, origin) {
      return (await currentSnapshot()).originsByClient.get(clientId)?.has(origin) ?? false;
    },
    invalidate() {
      cacheEpoch += 1;
      loadedAt = 0;
    },
  };
}
