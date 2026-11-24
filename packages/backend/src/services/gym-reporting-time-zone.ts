import { find } from 'geo-tz/dist/find-all';
import type { gyms } from '@boardsesh/db/schema';
import type { GymAddressLocation } from './gym-address-location';
import { validatedReportingTimeZone, type ReportingTimeZoneExecutor } from './reporting-time';

type GymReportingLocation = Pick<
  typeof gyms.$inferSelect,
  'reportingTimeZone' | 'latitude' | 'longitude' | 'address' | 'isPublic' | 'isListed'
>;

export function hasMappedGymCoordinates(
  location: Pick<GymReportingLocation, 'latitude' | 'longitude'>,
): location is { latitude: number; longitude: number } {
  const { latitude, longitude } = location;
  return (
    latitude !== null &&
    longitude !== null &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180 &&
    (latitude !== 0 || longitude !== 0)
  );
}

/** A saved staff override wins; otherwise use the gym's current mapped location. */
export async function resolveGymReportingTimeZone(
  gym: GymReportingLocation,
  executor?: ReportingTimeZoneExecutor,
  addressLocation?: GymAddressLocation | null,
): Promise<string | null> {
  if (gym.reportingTimeZone !== null) return gym.reportingTimeZone;
  const location = hasMappedGymCoordinates(gym)
    ? gym
    : gym.isPublic && gym.isListed && addressLocation && gym.address === addressLocation.address
      ? addressLocation
      : null;
  if (!location || !hasMappedGymCoordinates(location)) return null;
  const candidates = find(location.latitude, location.longitude);
  // Border/disputed locations and at-sea defaults need a staff choice.
  if (candidates.length !== 1 || candidates[0].startsWith('Etc/')) return null;
  return validatedReportingTimeZone(candidates[0], executor);
}
