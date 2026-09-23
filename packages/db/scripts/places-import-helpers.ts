import { normalizePlaceSearch } from '../src/queries/places/normalize.js';
import type { places } from '../src/schema/app/places.js';

export function parsePlacesSource(
  cities: string,
  countries: string,
  regions: string,
): Array<typeof places.$inferInsert> {
  const countryNames = new Map(
    countries
      .split('\n')
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const fields = line.split('\t');
        return [fields[0], fields[4]];
      }),
  );
  const regionNames = new Map(
    regions
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const fields = line.split('\t');
        return [fields[0], fields[1]];
      }),
  );
  if (!countryNames.get('AU') || !regionNames.get('AU.02'))
    throw new Error('Incomplete GeoNames country or region source');
  const rows = new Map<number, typeof places.$inferInsert>();
  for (const line of cities.split('\n')) {
    if (!line.trim()) continue;
    const fields = line.split('\t');
    const [rawId, name, asciiName, aliases, rawLatitude, rawLongitude] = fields;
    const id = Number(rawId);
    const latitude = Number(rawLatitude);
    const longitude = Number(rawLongitude);
    const population = Number(fields[14]);
    const countryCode = fields[8];
    const country = countryNames.get(countryCode);
    if (
      fields.length !== 19 ||
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      !name ||
      !country ||
      !rawLatitude ||
      !rawLongitude ||
      !Number.isFinite(latitude) ||
      Math.abs(latitude) > 90 ||
      !Number.isFinite(longitude) ||
      Math.abs(longitude) > 180 ||
      !Number.isSafeInteger(population) ||
      population < 0
    ) {
      throw new Error(`Invalid GeoNames city row: ${rawId}`);
    }
    const region = regionNames.get(`${countryCode}.${fields[10]}`) ?? '';
    rows.set(id, {
      id,
      name,
      normalizedName: normalizePlaceSearch(name),
      countryCode,
      country,
      region,
      latitude,
      longitude,
      population,
      searchText: normalizePlaceSearch([name, asciiName, aliases, region, country, countryCode].join(' ')),
    });
  }
  if (rows.size === 0) throw new Error('Empty GeoNames city source');
  return [...rows.values()];
}
