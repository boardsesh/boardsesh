import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import {
  formatLocationBoardName,
  resolveAuroraWallConfig,
  resolveDefaultAuroraLocationConfig,
  toLocationSyncLogger,
  upsertPublicBoardLocations,
  type LocationSyncSummary,
  type PublicBoardLocationInput,
} from '@boardsesh/location-sync';
import type { AuroraBoardName } from '../api/types';
import { AURORA_BOARDS } from '../api/types';
import { fetchAuroraPins, type AuroraPin } from '../api/pins-api';
import type { AuroraGymUser } from '../api/gym-walls-api';
import type { Wall } from '../api/sync-api-types';

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;
export type AuroraLocationBoardName = Exclude<AuroraBoardName, 'kilter'>;

/** How often the sequential gym crawl reports progress. */
const GYM_CRAWL_PROGRESS_INTERVAL = 50;

export const AURORA_LOCATION_BOARDS = AURORA_BOARDS.filter(
  (board): board is AuroraLocationBoardName => board !== 'kilter',
);

/**
 * A pin plus whatever the authenticated `/users/{id}` lookup returned for it.
 * `user` is undefined when the gym couldn't be read — no credentials for this
 * board, a 404, or a failed request — and that gym falls back to the guessed
 * default config so it never disappears from the map.
 */
export type AuroraPinWithUser = {
  pin: AuroraPin;
  user?: AuroraGymUser;
};

function formatLocationName(gym: AuroraGymUser['gym']): string | null {
  const parts = [gym?.city, gym?.country].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(', ') : null;
}

function formatAddress(gym: AuroraGymUser['gym']): string | null {
  const parts = [gym?.address1, gym?.city, gym?.country].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(', ') : null;
}

/**
 * Deterministic wall order, so "the first wall" means the same thing on every
 * run. That matters because the first wall keeps the gym's original board
 * source key — see `wallSourceKey`.
 */
function orderedWalls(walls: readonly Wall[]): Wall[] {
  return [...walls].sort(
    (first, second) =>
      (first.created_at ?? '').localeCompare(second.created_at ?? '') || first.uuid.localeCompare(second.uuid),
  );
}

/**
 * Board source keys are hashed into deterministic board UUIDs
 * (`boardUuidForSource`), so changing one mints a NEW board row and orphans the
 * old one — along with its ticks, wall history and any printed QR code.
 *
 * The first wall therefore keeps the gym's original `{board}:{pin id}` key,
 * which is the only key this sync ever produced. Only additional walls, which
 * never had a row before, get a per-wall key.
 */
function wallSourceKey(board: AuroraLocationBoardName, pinId: number, wall: Wall, wallIndex: number): string {
  const gymKey = `${board}:${pinId}`;
  return wallIndex === 0 ? gymKey : `${gymKey}:${wall.uuid}`;
}

export function buildAuroraLocationRecords(
  board: AuroraLocationBoardName,
  pins: AuroraPinWithUser[],
): { records: PublicBoardLocationInput[]; skipped: Array<{ sourceKey: string; reason: string }> } {
  const defaultConfig = resolveDefaultAuroraLocationConfig(board);
  const records: PublicBoardLocationInput[] = [];
  const skipped: Array<{ sourceKey: string; reason: string }> = [];

  for (const { pin, user } of pins) {
    const gymSourceKey = `${board}:${pin.id}`;
    const gymName = pin.name || `${formatLocationBoardName(board)} ${pin.id}`;
    const gymProfile = user?.gym ?? null;
    // The pin's coordinates stay authoritative: they are what the map has always
    // used, and the gym profile's pair can be blank or less precise.
    const common = {
      gymSourceKey,
      slugBase: `${gymName}-${board}`,
      latitude: pin.latitude ?? Number.NaN,
      longitude: pin.longitude ?? Number.NaN,
      gymName,
      gymAddress: formatAddress(gymProfile),
    };

    const listedWalls = orderedWalls(user?.walls ?? []).filter((wall) => wall.is_listed !== false);
    if (listedWalls.length === 0) {
      // Nothing readable for this gym. Publish the historical guess rather than
      // dropping the pin — a missing gym is worse than an imprecise one — but
      // say so in the summary so the gap is visible.
      if (!defaultConfig) {
        skipped.push({ sourceKey: gymSourceKey, reason: `unsupported ${board} default config` });
        continue;
      }
      records.push({
        ...defaultConfig,
        ...common,
        sourceKey: gymSourceKey,
        name: `${gymName} - ${formatLocationBoardName(board)}`,
        locationName: formatLocationName(gymProfile),
      });
      skipped.push({ sourceKey: gymSourceKey, reason: user ? 'gym has no listed walls' : 'gym walls unavailable' });
      continue;
    }

    listedWalls.forEach((wall, wallIndex) => {
      const sourceKey = wallSourceKey(board, pin.id, wall, wallIndex);
      const config = resolveAuroraWallConfig({
        boardType: board,
        layoutId: Number(wall.layout_id),
        productSizeId: Number(wall.product_size_id),
        setIds: (wall.set_ids ?? []).map(Number),
        angle: wall.angle,
        isAngleAdjustable: wall.is_adjustable === true,
      });
      if (!config) {
        skipped.push({
          sourceKey,
          reason: `unsupported ${board} wall config layout ${wall.layout_id} size ${wall.product_size_id}`,
        });
        return;
      }

      records.push({
        ...config,
        ...common,
        sourceKey,
        // The wall's own name when it has one — gyms label their walls, and a
        // gym with two of them needs them told apart.
        name: `${gymName} - ${wall.name || formatLocationBoardName(board)}`,
        locationName: formatLocationName(gymProfile),
        serialNumber: wall.serial_number,
      });
    });
  }

  return { records, skipped };
}

export async function syncAuroraBoardLocations(args: {
  db: DrizzleDb;
  board: AuroraLocationBoardName;
  /**
   * Reads a gym's walls. Injected so the crawl's auth, rate limiting and
   * failure handling live with the caller and this stays testable without HTTP.
   * Omitted (or returning undefined) means every gym falls back to the default
   * config, which is exactly the pre-enrichment behaviour.
   */
  fetchGymUser?: (pin: AuroraPin) => Promise<AuroraGymUser | undefined>;
  log?: (message: string) => void;
}): Promise<LocationSyncSummary> {
  const pins = await fetchAuroraPins(args.board);
  const pinsWithUsers: AuroraPinWithUser[] = [];
  if (args.fetchGymUser) {
    args.log?.(`[aurora-locations] ${args.board}: reading walls for ${pins.gyms.length} gym(s)`);
  }
  for (const [pinIndex, pin] of pins.gyms.entries()) {
    // Sequential on purpose: Aurora rate-limits per board, and a fan-out over
    // several thousand gyms would trip it immediately. At ~30 requests a minute
    // that means hours for a full crawl, so log progress periodically —
    // otherwise the only production signal is a per-gym failure line, and a
    // healthy run looks identical to a stalled one.
    const user = args.fetchGymUser ? await args.fetchGymUser(pin) : undefined;
    pinsWithUsers.push({ pin, user });
    if (args.fetchGymUser && (pinIndex + 1) % GYM_CRAWL_PROGRESS_INTERVAL === 0) {
      args.log?.(`[aurora-locations] ${args.board}: read ${pinIndex + 1}/${pins.gyms.length} gym(s)`);
    }
  }

  const { records, skipped } = buildAuroraLocationRecords(args.board, pinsWithUsers);
  const summary = await upsertPublicBoardLocations(args.db, records, {
    logger: toLocationSyncLogger(args.log),
  });
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
  fetchGymUser?: (board: AuroraLocationBoardName, pin: AuroraPin) => Promise<AuroraGymUser | undefined>;
  log?: (message: string) => void;
}): Promise<Record<AuroraLocationBoardName, LocationSyncSummary>> {
  const summaries = {} as Record<AuroraLocationBoardName, LocationSyncSummary>;
  for (const board of AURORA_LOCATION_BOARDS) {
    summaries[board] = await syncAuroraBoardLocations({
      db: args.db,
      board,
      fetchGymUser: args.fetchGymUser ? (pin) => args.fetchGymUser!(board, pin) : undefined,
      log: args.log,
    });
  }
  return summaries;
}
