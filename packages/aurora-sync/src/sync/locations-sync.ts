import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import {
  formatLocationBoardName,
  resolveDefaultAuroraLocationConfig,
  upsertPublicBoardLocations,
  type LocationSyncSummary,
  type PublicBoardLocationInput,
} from '@boardsesh/location-sync';
import type { AuroraBoardName } from '../api/types';
import { AURORA_BOARDS } from '../api/types';
import { fetchAuroraPins, type AuroraPin } from '../api/pins-api';

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;
export type AuroraLocationBoardName = Exclude<AuroraBoardName, 'kilter'>;

export const AURORA_LOCATION_BOARDS = AURORA_BOARDS.filter(
  (board): board is AuroraLocationBoardName => board !== 'kilter',
);

export function buildAuroraLocationRecords(
  board: AuroraLocationBoardName,
  pins: AuroraPin[],
): { records: PublicBoardLocationInput[]; skipped: Array<{ sourceKey: string; reason: string }> } {
  const config = resolveDefaultAuroraLocationConfig(board);
  const records: PublicBoardLocationInput[] = [];
  const skipped: Array<{ sourceKey: string; reason: string }> = [];

  if (!config) {
    return {
      records,
      skipped: pins.map((pin) => ({ sourceKey: `${board}:${pin.id}`, reason: `unsupported ${board} default config` })),
    };
  }

  for (const pin of pins) {
    const sourceKey = `${board}:${pin.id}`;
    const gymName = pin.name || `${formatLocationBoardName(board)} ${pin.id}`;
    records.push({
      ...config,
      sourceKey,
      gymSourceKey: sourceKey,
      name: `${gymName} - ${formatLocationBoardName(board)}`,
      slugBase: `${gymName}-${board}`,
      locationName: null,
      latitude: pin.latitude ?? Number.NaN,
      longitude: pin.longitude ?? Number.NaN,
      gymName,
      gymAddress: null,
    });
  }

  return { records, skipped };
}

export async function syncAuroraBoardLocations(args: {
  db: DrizzleDb;
  board: AuroraLocationBoardName;
  log?: (message: string) => void;
}): Promise<LocationSyncSummary> {
  const pins = await fetchAuroraPins(args.board);
  const { records, skipped } = buildAuroraLocationRecords(args.board, pins.gyms);
  const summary = await upsertPublicBoardLocations(args.db, records);
  const mergedSummary = {
    ...summary,
    boardsSkipped: summary.boardsSkipped + skipped.length,
    skipped: [...summary.skipped, ...skipped],
  };
  args.log?.(
    `[aurora-locations] ${args.board}: upserted ${mergedSummary.boardsUpserted}/${mergedSummary.boardsSeen} board(s), ${mergedSummary.gymsUpserted} gym(s), skipped ${mergedSummary.boardsSkipped}`,
  );
  return mergedSummary;
}

export async function syncAllAuroraBoardLocations(args: {
  db: DrizzleDb;
  log?: (message: string) => void;
}): Promise<Record<AuroraLocationBoardName, LocationSyncSummary>> {
  const summaries = {} as Record<AuroraLocationBoardName, LocationSyncSummary>;
  for (const board of AURORA_LOCATION_BOARDS) {
    summaries[board] = await syncAuroraBoardLocations({ db: args.db, board, log: args.log });
  }
  return summaries;
}
