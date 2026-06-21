import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import {
  getMoonBoardLocationConfigs,
  upsertPublicBoardLocations,
  type LocationSyncSummary,
  type PublicBoardLocationInput,
} from '@boardsesh/location-sync';
import { MoonBoardClient, type MoonBoardMarker } from '../api/moonboard-client';

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

type MarkerCoordinates = {
  latitude: number;
  longitude: number;
};

function finiteNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function markerCoordinates(marker: MoonBoardMarker): MarkerCoordinates {
  const latitude = finiteNumber(marker.Latitude) ? marker.Latitude : (marker.LatLng?.[0] ?? Number.NaN);
  const longitude = finiteNumber(marker.Longitude) ? marker.Longitude : (marker.LatLng?.[1] ?? Number.NaN);
  return { latitude, longitude };
}

function baseSourceKey(marker: MoonBoardMarker): string {
  const coordinates = markerCoordinates(marker);
  return `moonboard:${marker.Name}:${coordinates.latitude}:${coordinates.longitude}`;
}

function sourceKeyForConfig(marker: MoonBoardMarker, layoutId: number, angle: number): string {
  const base = baseSourceKey(marker);
  // Preserve the old seed UUID for the previous single default MoonBoard
  // install: MoonBoard 2016, all 2016 sets, 40 degrees.
  return layoutId === 2 && angle === 40 ? base : `${base}:${layoutId}:${angle}`;
}

export function buildMoonBoardLocationRecords(markers: MoonBoardMarker[]): PublicBoardLocationInput[] {
  const records: PublicBoardLocationInput[] = [];
  const configs = getMoonBoardLocationConfigs();

  for (const marker of markers) {
    const gymName = marker.Name || 'MoonBoard Gym';
    const gymSourceKey = baseSourceKey(marker);
    const coordinates = markerCoordinates(marker);
    for (const config of configs) {
      records.push({
        ...config,
        sourceKey: sourceKeyForConfig(marker, config.layoutId, config.angle),
        gymSourceKey,
        name: `${gymName} - ${config.layoutName} ${config.angle}deg`,
        slugBase:
          config.layoutId === 2 && config.angle === 40
            ? `${gymName}-moonboard`
            : `${gymName}-moonboard-${config.layoutId}-${config.angle}`,
        locationName: null,
        latitude: coordinates.latitude,
        longitude: coordinates.longitude,
        gymName,
        gymAddress: null,
      });
    }
  }

  return records;
}

export async function syncMoonBoardLocations(args: {
  db: DrizzleDb;
  username: string;
  password: string;
  log?: (message: string) => void;
}): Promise<LocationSyncSummary> {
  const client = new MoonBoardClient();
  await client.authenticate(args.username, args.password);
  const markers = await client.getMapMarkers();
  const records = buildMoonBoardLocationRecords(markers);
  const summary = await upsertPublicBoardLocations(args.db, records);
  args.log?.(
    `[moonboard-locations] upserted ${summary.boardsUpserted}/${summary.boardsSeen} board(s), ${summary.gymsUpserted} gym(s), skipped ${summary.boardsSkipped}`,
  );
  return summary;
}
