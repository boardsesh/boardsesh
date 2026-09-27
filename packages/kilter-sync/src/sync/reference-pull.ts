import { streamKilterPowerSync, type PowerSyncOp } from '../api/powersync-client';
import { KilterApiError } from '../api/errors';

/**
 * The Kilter Grips reference catalog, pulled over PowerSync. Confirmed live
 * (2026-06-02): `products`, `product_layouts`, `holds`, `difficulty_grades`
 * stream in the `global` / `global_gyms` buckets (the public climb catalog
 * itself does NOT — it's REST, see api/kilter-rest.ts). Rows are snake_case;
 * we coerce PowerSync's 0/1 ints to booleans here.
 *
 * The primary job for Flow A is enumerating `product_layouts` — that's the
 * list of `productLayoutUuid`s the catalog REST pull iterates. The other
 * tables drive a reconcile/verify pass (insert genuinely-new reference rows,
 * never clobber existing ones).
 */

export type KilterRefProduct = {
  /** Grips uses the product name as its id (e.g. "Kilter Board Original"). */
  id: string;
  productName: string;
  isListed: boolean;
};

export type KilterRefProductLayout = {
  /** Small integer-as-string, e.g. "27". Matches the climb's productLayoutUuid. */
  productLayoutUuid: string;
  productName: string;
  isListed: boolean;
  edgeLeft: number;
  edgeRight: number;
  edgeBottom: number;
  edgeTop: number;
};

export type KilterRefHold = {
  holdId: number;
  holdSetName: string | null;
};

export type KilterRefDifficultyGrade = {
  difficultyGradeId: number;
  boulderDifficulty: string | null;
  routeDifficulty: string | null;
  isListed: boolean;
};

export type KilterRefGym = {
  id: string;
  gymUuid: string;
  name: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  countryCode: string | null;
  postalCode: string | null;
  latitude: number | null;
  longitude: number | null;
  instagramUsername: string | null;
  gymLogo: string | null;
  bannerLogo: string | null;
  isListed: boolean | null;
};

export type KilterRefWall = {
  id: string;
  wallUuid: string;
  gymUuid: string | null;
  name: string | null;
  productName: string | null;
  productLayoutUuid: string | null;
  isAdjustable: boolean | null;
  minAngle: number | null;
  maxAngle: number | null;
  angleIncrements: number | null;
  angle: number | null;
  serialNumber: string | null;
  accumulatedHoldSetValue: number | null;
  isListed: boolean | null;
  createdAt: string | null;
};

export type KilterReferencePull = {
  products: KilterRefProduct[];
  productLayouts: KilterRefProductLayout[];
  holds: KilterRefHold[];
  difficultyGrades: KilterRefDifficultyGrade[];
  gyms: KilterRefGym[];
  walls: KilterRefWall[];
};

// PowerSync raw-table columns are scalars (TEXT / INTEGER / REAL), never
// objects — coerce defensively without tripping no-base-to-string.
const num = (value: unknown): number => Number(value);
const nullableNum = (value: unknown): number | null => {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
};
const str = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
};
const nullableStr = (value: unknown): string | null => (value == null ? null : str(value));
const bool = (value: unknown): boolean => value === 1 || value === true || value === '1';
const nullableBool = (value: unknown): boolean | null => (value == null ? null : bool(value));

export async function pullKilterReference(args: {
  accessToken: string;
  log?: (message: string) => void;
  /** Cancels the reference stream (a background job's shutdown or lost lease). */
  signal?: AbortSignal;
}): Promise<KilterReferencePull> {
  // A PowerSync stream can emit multiple PUT ops for the same row (initial
  // snapshot then updates, or the same row surfaced by both the `global` and
  // `global_gyms` buckets). Key each entity by its natural id so the latest op
  // wins and we never enumerate — or skip-log — the same wall/gym twice. Before
  // this, flat push() arrays let one duplicated `wall_uuid` inflate boardsSeen
  // and stack identical entries in the locations skip report.
  const products = new Map<string, KilterRefProduct>();
  const productLayouts = new Map<string, KilterRefProductLayout>();
  const holds = new Map<number, KilterRefHold>();
  const difficultyGrades = new Map<number, KilterRefDifficultyGrade>();
  const gyms = new Map<string, KilterRefGym>();
  const walls = new Map<string, KilterRefWall>();

  await streamKilterPowerSync({
    accessToken: args.accessToken,
    signal: args.signal,
    streams: ['global', 'global_gyms'],
    onOp: (op: PowerSyncOp) => {
      if (op.op !== 'PUT' || !op.data) return;
      const data = op.data;
      switch (op.object_type) {
        case 'products':
          products.set(str(data.id), {
            id: str(data.id),
            productName: str(data.product_name),
            isListed: bool(data.is_listed),
          });
          break;
        case 'product_layouts':
          productLayouts.set(str(data.product_layout_uuid), {
            productLayoutUuid: str(data.product_layout_uuid),
            productName: str(data.product_name),
            isListed: bool(data.is_listed),
            edgeLeft: num(data.edge_left),
            edgeRight: num(data.edge_right),
            edgeBottom: num(data.edge_bottom),
            edgeTop: num(data.edge_top),
          });
          break;
        case 'holds':
          holds.set(num(data.hold_id), { holdId: num(data.hold_id), holdSetName: nullableStr(data.hold_set_name) });
          break;
        case 'difficulty_grades':
          difficultyGrades.set(num(data.difficulty_grade_id), {
            difficultyGradeId: num(data.difficulty_grade_id),
            boulderDifficulty: nullableStr(data.boulder_difficulty),
            routeDifficulty: nullableStr(data.route_difficulty),
            isListed: bool(data.is_listed),
          });
          break;
        case 'gyms': {
          const id = str(data.id ?? op.object_id);
          const gymUuid = str(data.gym_uuid);
          gyms.set(gymUuid || id, {
            id,
            gymUuid,
            name: nullableStr(data.name),
            address: nullableStr(data.address),
            city: nullableStr(data.city),
            country: nullableStr(data.country),
            countryCode: nullableStr(data.countryCode ?? data.country_code),
            postalCode: nullableStr(data.postal_code),
            latitude: nullableNum(data.latitude),
            longitude: nullableNum(data.longitude),
            instagramUsername: nullableStr(data.instagramUsername ?? data.instagram_username),
            gymLogo: nullableStr(data.gymLogo ?? data.gym_logo),
            bannerLogo: nullableStr(data.bannerLogo ?? data.banner_logo),
            isListed: nullableBool(data.isListed ?? data.is_listed),
          });
          break;
        }
        case 'walls': {
          const id = str(data.id ?? op.object_id);
          const wallUuid = str(data.wall_uuid);
          walls.set(wallUuid || id, {
            id,
            wallUuid,
            gymUuid: nullableStr(data.gym_uuid),
            name: nullableStr(data.name),
            productName: nullableStr(data.product_name),
            productLayoutUuid: nullableStr(data.product_layout_uuid),
            isAdjustable: nullableBool(data.is_adjustable),
            minAngle: nullableNum(data.min_angle),
            maxAngle: nullableNum(data.max_angle),
            angleIncrements: nullableNum(data.angle_increments),
            angle: nullableNum(data.angle),
            serialNumber: nullableStr(data.serial_number),
            accumulatedHoldSetValue: nullableNum(data.accumulated_hold_set_value),
            isListed: nullableBool(data.is_listed),
            createdAt: nullableStr(data.created_at),
          });
          break;
        }
        default:
          // hold_sets / placement_types / videos / grade_systems stream too but
          // aren't needed for catalog ingest — ignore.
          break;
      }
    },
  });

  // An empty product_layouts pull means we can't enumerate the catalog at
  // all — fail loud rather than silently sync nothing.
  if (productLayouts.size === 0) {
    throw new KilterApiError(
      'powersync',
      'Kilter reference pull returned no product_layouts — cannot enumerate the catalog',
    );
  }

  const result: KilterReferencePull = {
    products: [...products.values()],
    productLayouts: [...productLayouts.values()],
    holds: [...holds.values()],
    difficultyGrades: [...difficultyGrades.values()],
    gyms: [...gyms.values()],
    walls: [...walls.values()],
  };
  args.log?.(
    `[kilter-catalog] reference pulled: ${result.products.length} products, ${result.productLayouts.length} layouts, ${result.holds.length} holds, ${result.difficultyGrades.length} grades, ${result.gyms.length} gyms, ${result.walls.length} walls`,
  );
  return result;
}
