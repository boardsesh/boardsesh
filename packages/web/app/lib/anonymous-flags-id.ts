import { getPreference, setPreference } from './user-preferences-db';

/**
 * A random id for this browser, kept in IndexedDB (`boardsesh-user-preferences`),
 * used ONLY as the distinct id of a signed-out visitor's feature-flag request
 * (analytics.ts). Never on a captured event, never in PostHog's own storage,
 * never next to an account id, and not a device fingerprint.
 *
 * A percentage rollout buckets on the flag request's distinct id. Before this,
 * a visitor who had not said Allow got a fresh in-memory id on every hard load,
 * so the rollout re-rolled every page load, and Allow switched to the SDK's
 * persisted anonymous id and re-rolled it once more. One id per browser keeps
 * the bucket across loads and across Allow / No thanks. Signed in, flags use
 * the account id instead. docs/feature-flags.md, "Anonymous bucketing".
 */

const ANONYMOUS_FLAGS_ID_KEY = 'anonymousFlagsId';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let knownId: string | null = null;
let pending: Promise<string> | null = null;

function randomId(): string {
  return crypto.randomUUID();
}

async function loadOrCreate(): Promise<string> {
  // getPreference/setPreference swallow IndexedDB failures (private windows,
  // blocked storage); the id then lasts for this page load only.
  const stored = await getPreference<unknown>(ANONYMOUS_FLAGS_ID_KEY);
  if (typeof stored === 'string' && UUID_PATTERN.test(stored)) return stored;
  const created = randomId();
  await setPreference(ANONYMOUS_FLAGS_ID_KEY, created);
  return created;
}

/** This browser's flags-only id. Never rejects. */
export function getAnonymousFlagsId(): Promise<string> {
  if (knownId) return Promise.resolve(knownId);
  pending ??= loadOrCreate()
    .catch(() => randomId())
    .then((id) => {
      knownId = id;
      return id;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

/** The distinct id a signed-out flag request uses. */
export async function getFlagsBrowserDistinctId(): Promise<string> {
  return `flags-browser:${await getAnonymousFlagsId()}`;
}

/**
 * Rewrite a signed-out `/flags` request body to bucket on this browser's id.
 * Without consent the SDK's in-memory anonymous and device ids are dropped too:
 * they identify nothing durable, and flags do not need them. Returns the body
 * untouched when it is not a JSON object.
 */
export function withAnonymousFlagsIdentity(body: string, distinctId: string, granted: boolean): string {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return body;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return body;
  const rewritten: Record<string, unknown> = { ...payload, distinct_id: distinctId };
  if (!granted) {
    delete rewritten.$anon_distinct_id;
    delete rewritten.$device_id;
  }
  return JSON.stringify(rewritten);
}

/** Test-only: forget the cached id. */
export function resetAnonymousFlagsIdForTests(): void {
  knownId = null;
  pending = null;
}
