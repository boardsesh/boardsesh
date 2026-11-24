import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { resolveGymReportingTimeZone } from '../services/gym-reporting-time-zone';
import { validatedReportingTimeZone, type ReportingTimeZoneExecutor } from '../services/reporting-time';

vi.mock('../services/reporting-time', () => ({ validatedReportingTimeZone: vi.fn() }));

const validateZone = vi.mocked(validatedReportingTimeZone);
const mappedGym = (latitude: number | null, longitude: number | null, reportingTimeZone: string | null = null) => ({
  latitude,
  longitude,
  reportingTimeZone,
  address: null as string | null,
  isPublic: true,
  isListed: true,
});

beforeEach(() => {
  validateZone.mockReset().mockImplementation(async (timeZone) => timeZone);
});

describe('gym reporting time zone from location', () => {
  it.each([
    [52.3676, 4.9041, 'Europe/Amsterdam'],
    [40.7128, -74.006, 'America/New_York'],
    [-33.8688, 151.2093, 'Australia/Sydney'],
  ])('uses the complete land-zone lookup for %s, %s', async (latitude, longitude, expected) => {
    expect(await resolveGymReportingTimeZone(mappedGym(latitude, longitude))).toBe(expected);
    expect(validateZone).toHaveBeenCalledWith(expected, undefined);
  });

  it('preserves a staff override across location changes, including explicit UTC', async () => {
    expect(await resolveGymReportingTimeZone(mappedGym(52.3676, 4.9041, 'UTC'))).toBe('UTC');
    expect(await resolveGymReportingTimeZone(mappedGym(-33.8688, 151.2093, 'America/New_York'))).toBe(
      'America/New_York',
    );
    expect(validateZone).not.toHaveBeenCalled();
  });

  it('recomputes from changed coordinates and resumes inference after clearing an override', async () => {
    const gym = mappedGym(52.3676, 4.9041, 'UTC');
    expect(await resolveGymReportingTimeZone(gym)).toBe('UTC');
    gym.reportingTimeZone = null;
    expect(await resolveGymReportingTimeZone(gym)).toBe('Europe/Amsterdam');
    gym.latitude = -33.8688;
    gym.longitude = 151.2093;
    expect(await resolveGymReportingTimeZone(gym)).toBe('Australia/Sydney');
  });

  it.each([
    [null, 4.9041],
    [52.3676, null],
    [Number.NaN, 4.9041],
    [52.3676, Number.POSITIVE_INFINITY],
    [91, 4.9041],
    [52.3676, -181],
    [0, 0],
    [0, -30],
    [43.839319, 87.526148],
  ])('keeps missing, invalid, at-sea or ambiguous location %s, %s unconfigured', async (latitude, longitude) => {
    expect(await resolveGymReportingTimeZone(mappedGym(latitude, longitude))).toBeNull();
    expect(validateZone).not.toHaveBeenCalled();
  });

  it('requires the inferred zone to be supported by the reporting database', async () => {
    validateZone.mockResolvedValueOnce(null);
    expect(await resolveGymReportingTimeZone(mappedGym(52.3676, 4.9041))).toBeNull();
  });

  it('uses address evidence only while it matches the current public listed gym', async () => {
    const gym = { ...mappedGym(null, null), address: 'Damrak 1, Amsterdam, Netherlands' };
    const evidence = { address: gym.address, latitude: 52.3676, longitude: 4.9041 };
    expect(await resolveGymReportingTimeZone(gym, undefined, evidence)).toBe('Europe/Amsterdam');
    expect(await resolveGymReportingTimeZone({ ...gym, address: 'Changed address' }, undefined, evidence)).toBeNull();
    expect(await resolveGymReportingTimeZone({ ...gym, isPublic: false }, undefined, evidence)).toBeNull();
    expect(await resolveGymReportingTimeZone({ ...gym, isListed: false }, undefined, evidence)).toBeNull();
    expect(await resolveGymReportingTimeZone({ ...gym, ...mappedGym(40.7128, -74.006) }, undefined, evidence)).toBe(
      'America/New_York',
    );
  });

  it('validates with the caller transaction instead of borrowing another pooled connection', async () => {
    const executor = { execute: vi.fn() } as unknown as ReportingTimeZoneExecutor;
    expect(await resolveGymReportingTimeZone(mappedGym(52.3676, 4.9041), executor)).toBe('Europe/Amsterdam');
    expect(validateZone).toHaveBeenCalledWith('Europe/Amsterdam', executor);
  });

  it('propagates validation infrastructure failures instead of inventing a configured zone', async () => {
    const failure = new Error('database unavailable');
    validateZone.mockRejectedValueOnce(failure);
    await expect(resolveGymReportingTimeZone(mappedGym(52.3676, 4.9041))).rejects.toBe(failure);
  });
});
