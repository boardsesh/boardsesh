import { Alert } from 'react-native';
import { GET_SPRAY_WALL_HOLD_USAGE } from '@boardsesh/graphql/operations/spray-walls';
import { sprayWallHoldsRemovedInUse } from '@boardsesh/analytics';
import { getHttpClient } from '../graphql/client';
import { trackSprayEvent } from './spray-telemetry';

/**
 * Asking before a hold save removes (or moves) a hold that published climbs use
 * (`docs/spray-walls.md`, "Editing holds on a live wall").
 *
 * A live wall's holds stay editable whatever has been set on them. What the
 * owner is told is the cost: a published climb that used a removed hold is
 * marked as missing a hold (`missing_hold_count`) until someone remixes it.
 */

/** The server answers at most this many holds per call. */
const HOLD_USAGE_BATCH = 500;

type HoldUsageRow = { holdId: number; publishedClimbCount: number; draftClimbCount: number };
type HoldUsageResponse = { sprayWallHoldUsage: HoldUsageRow[] };

/** How many climbs use a set of holds, summed over the holds. */
export type SprayHoldUsage = { publishedClimbCount: number; draftClimbCount: number };

/**
 * How many published and draft climbs use these holds, or `null` when it could
 * not be read (offline, an older backend, a refusal). Never rejects.
 *
 * Summed per hold, so a climb that uses two of the holds counts twice. The
 * confirm says "{{count}} published climbs" off that sum, which can overstate
 * and never understate: the error that matters here is the silent one.
 */
export async function fetchSprayHoldUsage(
  wallUuid: string,
  holdIds: readonly number[],
): Promise<SprayHoldUsage | null> {
  const ids = [...new Set(holdIds)];
  if (ids.length === 0) return { publishedClimbCount: 0, draftClimbCount: 0 };
  try {
    let publishedClimbCount = 0;
    let draftClimbCount = 0;
    for (let start = 0; start < ids.length; start += HOLD_USAGE_BATCH) {
      const response = await getHttpClient().request<HoldUsageResponse>(GET_SPRAY_WALL_HOLD_USAGE, {
        wallUuid,
        holdIds: ids.slice(start, start + HOLD_USAGE_BATCH),
      });
      for (const row of response.sprayWallHoldUsage) {
        publishedClimbCount += row.publishedClimbCount;
        draftClimbCount += row.draftClimbCount;
      }
    }
    return { publishedClimbCount, draftClimbCount };
  } catch {
    return null;
  }
}

/** Renders a `boards` catalog key. */
export type SprayHoldUsageTranslator = (key: string, values?: { count: number }) => string;

/**
 * Show "Remove a hold that climbs use?" when it applies, and resolve whether the
 * save may go on.
 *
 * - Published climbs use the holds: the confirm, with their count.
 * - The usage could not be read: the confirm anyway, in its generic wording.
 *   Failing toward asking, never toward removing a hold under climbs silently.
 * - Only drafts use them, or nothing does: no confirm. A draft is its setter's
 *   work in progress, and the editor already drops holds a draft names that the
 *   wall no longer has.
 *
 * A system alert, like the reset confirm: the hold route sits inside the Boards
 * modal, which an in-app dialog would draw behind. Dismissing it any other way
 * (Android back) keeps the holds.
 */
export function confirmRemovingUsedHolds(
  usage: SprayHoldUsage | null,
  holdCount: number,
  t: SprayHoldUsageTranslator,
): Promise<boolean> {
  if (usage && usage.publishedClimbCount === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    Alert.alert(
      t('sprayHoldUsage.title'),
      usage ? t('sprayHoldUsage.body', { count: usage.publishedClimbCount }) : t('sprayHoldUsage.bodyUnknown'),
      [
        { text: t('sprayHoldUsage.keep'), style: 'cancel', onPress: () => resolve(false) },
        {
          text: t('sprayHoldUsage.removeAnyway'),
          style: 'destructive',
          onPress: () => {
            trackSprayEvent(
              sprayWallHoldsRemovedInUse({
                holdCount,
                publishedClimbCount: usage?.publishedClimbCount ?? 0,
                usageKnown: usage != null,
              }),
            );
            resolve(true);
          },
        },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

/** Both steps, for a host to hand the hold editor as its removal gate. */
export async function askBeforeRemovingUsedHolds(
  wallUuid: string,
  holdIds: readonly number[],
  t: SprayHoldUsageTranslator,
): Promise<boolean> {
  const usage = await fetchSprayHoldUsage(wallUuid, holdIds);
  return confirmRemovingUsedHolds(usage, new Set(holdIds).size, t);
}
