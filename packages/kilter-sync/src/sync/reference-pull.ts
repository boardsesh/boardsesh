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

export type KilterReferencePull = {
  products: KilterRefProduct[];
  productLayouts: KilterRefProductLayout[];
  holds: KilterRefHold[];
  difficultyGrades: KilterRefDifficultyGrade[];
};

// PowerSync raw-table columns are scalars (TEXT / INTEGER / REAL), never
// objects — coerce defensively without tripping no-base-to-string.
const num = (value: unknown): number => Number(value);
const str = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
};
const nullableStr = (value: unknown): string | null => (value == null ? null : str(value));
const bool = (value: unknown): boolean => value === 1 || value === true || value === '1';

export async function pullKilterReference(args: {
  accessToken: string;
  log?: (message: string) => void;
}): Promise<KilterReferencePull> {
  const products: KilterRefProduct[] = [];
  const productLayouts: KilterRefProductLayout[] = [];
  const holds: KilterRefHold[] = [];
  const difficultyGrades: KilterRefDifficultyGrade[] = [];

  await streamKilterPowerSync({
    accessToken: args.accessToken,
    streams: ['global', 'global_gyms'],
    onOp: (op: PowerSyncOp) => {
      if (op.op !== 'PUT' || !op.data) return;
      const data = op.data;
      switch (op.object_type) {
        case 'products':
          products.push({ id: str(data.id), productName: str(data.product_name), isListed: bool(data.is_listed) });
          break;
        case 'product_layouts':
          productLayouts.push({
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
          holds.push({ holdId: num(data.hold_id), holdSetName: nullableStr(data.hold_set_name) });
          break;
        case 'difficulty_grades':
          difficultyGrades.push({
            difficultyGradeId: num(data.difficulty_grade_id),
            boulderDifficulty: nullableStr(data.boulder_difficulty),
            routeDifficulty: nullableStr(data.route_difficulty),
            isListed: bool(data.is_listed),
          });
          break;
        default:
          // gyms / walls / hold_sets / placement_types / videos / grade_systems
          // stream too but aren't needed for catalog ingest — ignore.
          break;
      }
    },
  });

  // An empty product_layouts pull means we can't enumerate the catalog at
  // all — fail loud rather than silently sync nothing.
  if (productLayouts.length === 0) {
    throw new KilterApiError(
      'powersync',
      'Kilter reference pull returned no product_layouts — cannot enumerate the catalog',
    );
  }

  args.log?.(
    `[kilter-catalog] reference pulled: ${products.length} products, ${productLayouts.length} layouts, ${holds.length} holds, ${difficultyGrades.length} grades`,
  );
  return { products, productLayouts, holds, difficultyGrades };
}
