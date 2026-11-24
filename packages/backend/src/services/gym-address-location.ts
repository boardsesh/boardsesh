import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { suppressTracing, withIsolationScope } from '@sentry/node';
import type { gyms } from '@boardsesh/db/schema';
import { redisClientManager } from '../redis/client';

export type GymAddressLocation = { address: string; latitude: number; longitude: number };
type AddressGym = Pick<
  typeof gyms.$inferSelect,
  'address' | 'latitude' | 'longitude' | 'reportingTimeZone' | 'isPublic' | 'isListed'
>;

const DEFAULT_ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const CACHE_PREFIX = 'gym-address-location:v1:';
const REQUEST_BUDGET_KEY = 'gym-address-location:request-budget';
const RELEASE_ADDRESS_LEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;
const MATCH_TTL_SECONDS = 30 * 24 * 60 * 60;
const NO_MATCH_TTL_SECONDS = 24 * 60 * 60;
const FAILURE_TTL_SECONDS = 5 * 60;
const coordinate = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
});
const cachedCoordinates = coordinate.nullable();
const numericText = z.string().regex(/^-?\d+(?:\.\d+)?$/);
const searchResults = z.array(z.object({ lat: numericText, lon: numericText })).max(2);

function usableCoordinates(latitude: number | null, longitude: number | null): boolean {
  return (
    latitude !== null &&
    longitude !== null &&
    coordinate.safeParse({ latitude, longitude }).success &&
    !(latitude === 0 && longitude === 0)
  );
}

/** Called only after gym access is checked, before entering a reporting transaction. */
export async function resolveGymAddressLocation(gym: AddressGym): Promise<GymAddressLocation | null> {
  const address = gym.address?.trim();
  if (
    gym.reportingTimeZone !== null ||
    !gym.isPublic ||
    !gym.isListed ||
    usableCoordinates(gym.latitude, gym.longitude) ||
    !address ||
    address.length < 5 ||
    address.length > 500
  )
    return null;

  const location = await lookupAddressCoordinates(address);
  return location ? { address: gym.address!, ...location } : null;
}

/** Shared with explicit map searches so every provider request uses one budget. */
export async function lookupAddressCoordinates(addressInput: string): Promise<z.infer<typeof coordinate> | null> {
  const address = addressInput.trim();
  if (address.length < 5 || address.length > 500) return null;

  // Redis is required so all backend instances share one request budget and
  // reusable, address-keyed results. Only explicit searches may supply a private
  // address; automatic gym lookups are restricted by resolveGymAddressLocation.
  try {
    const endpoint = new URL(process.env.GYM_GEOCODING_URL || DEFAULT_ENDPOINT);
    if (!['http:', 'https:'].includes(endpoint.protocol)) return null;
    const cacheKey =
      CACHE_PREFIX +
      createHash('sha256')
        .update(endpoint.href + '\0' + address)
        .digest('hex');
    const { publisher } = redisClientManager.getClients();
    const cached = await publisher.get(cacheKey);
    if (cached !== null) {
      const parsed = cachedCoordinates.safeParse(JSON.parse(cached) as unknown);
      if (parsed.success) return parsed.data;
    }
    // One lookup for this address at a time; a slower failure must not overwrite
    // a newer successful result after the global start budget becomes available.
    const addressLeaseKey = cacheKey + ':in-flight';
    const addressLeaseOwner = randomUUID();
    const addressLease = await publisher.set(addressLeaseKey, addressLeaseOwner, 'PX', 15_000, 'NX');
    if (addressLease !== 'OK') return null;
    // Do not queue a reporting request behind another address lookup.
    const admitted = await publisher.set(REQUEST_BUDGET_KEY, '1', 'PX', 1_100, 'NX');
    if (admitted !== 'OK') {
      await publisher.eval(RELEASE_ADDRESS_LEASE, 1, addressLeaseKey, addressLeaseOwner);
      return null;
    }

    let result: z.infer<typeof coordinate> | null = null;
    let ttl = FAILURE_TTL_SECONDS;
    try {
      endpoint.searchParams.set('format', 'jsonv2');
      endpoint.searchParams.set('limit', '2');
      endpoint.searchParams.set('dedupe', '1');
      endpoint.searchParams.set('q', address);
      // The provider needs q, but diagnostics do not. Suppress automatic HTTP
      // spans and discard fetch breadcrumbs with this child isolation scope.
      const response = await withIsolationScope(() =>
        suppressTracing(() =>
          fetch(endpoint, {
            headers: { 'User-Agent': 'Boardsesh gym reporting (https://www.boardsesh.com)', 'Accept-Language': 'en' },
            signal: AbortSignal.timeout(4_000),
            redirect: 'error',
          }),
        ),
      );
      if (response.ok) {
        const parsed = searchResults.safeParse((await response.json()) as unknown);
        if (parsed.success) {
          ttl = NO_MATCH_TTL_SECONDS;
          if (parsed.data.length === 1) {
            const match = parsed.data[0];
            const candidate = coordinate.safeParse({ latitude: Number(match.lat), longitude: Number(match.lon) });
            if (candidate.success && usableCoordinates(candidate.data.latitude, candidate.data.longitude)) {
              result = candidate.data;
              ttl = MATCH_TTL_SECONDS;
            }
          }
        }
      }
    } catch {
      // Provider failures leave the existing explicit UTC/manual fallback usable.
    }
    await publisher.set(cacheKey, JSON.stringify(result), 'EX', ttl, 'NX');
    return result;
  } catch {
    // No raw address or provider URL is logged. Redis/provider outages are optional.
    return null;
  }
}
