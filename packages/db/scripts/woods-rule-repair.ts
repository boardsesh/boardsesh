import { CLIMB_CHARACTERISTICS } from '@boardsesh/shared-schema/characteristics';
import { mapWoodsProblemToClimb, type WoodsCatalogFile } from './woods-catalog-helpers.js';

export type WoodsCatalogRules = {
  uuid: string;
  frames: string;
  sizeId: number;
  characteristics: string[];
};

export type WoodsStoredRules = {
  uuid: string;
  boardType: string;
  userId: string | null;
  frames: string | null;
  compatibleSizeIds: number[] | null;
  characteristics: string[] | null;
};

import type { WoodsRuleUpdate } from '../src/queries/climbs/woods-rule-repair.js';
export type { WoodsRuleUpdate } from '../src/queries/climbs/woods-rule-repair.js';

export function parseWoodsRuleRepairArgs(args: string[], envDirectory?: string) {
  const forwarded = args.filter((argument) => argument !== '--');
  const directories = forwarded.filter((argument) => !argument.startsWith('--'));
  const directory = directories[0] ?? envDirectory;
  if (
    !directory ||
    directories.length > 1 ||
    forwarded.some((argument) => argument.startsWith('--') && argument !== '--apply')
  ) {
    throw new Error('Usage: vp run db:repair-woods-rules -- /path/to/catalog [--apply]');
  }
  return { directory, apply: forwarded.includes('--apply') };
}

/** Resolve the same catalog identities as the importer, without minting replacements. */
export function buildWoodsRuleCatalog(catalogs: WoodsCatalogFile[]): Map<string, WoodsCatalogRules> {
  const byUuid = new Map<string, WoodsCatalogRules>();
  for (const catalog of catalogs) {
    for (const problem of catalog.problems) {
      if (problem.boardDimension !== catalog.boardDimension) {
        throw new Error(`Woods problem ${problem.id} has a conflicting board size`);
      }
      const mapped = mapWoodsProblemToClimb(problem);
      if (!mapped) continue;
      if (mapped.compatibleSizeIds.length !== 1) throw new Error(`Unknown Woods size: ${problem.boardDimension}`);
      const existing = byUuid.get(mapped.uuid);
      if (existing && JSON.stringify(existing.characteristics) !== JSON.stringify(mapped.characteristics)) {
        throw new Error(`Conflicting Woods rules for catalog UUID ${mapped.uuid}`);
      }
      byUuid.set(mapped.uuid, {
        uuid: mapped.uuid,
        frames: mapped.frames,
        sizeId: mapped.compatibleSizeIds[0],
        characteristics: mapped.characteristics,
      });
    }
  }
  return byUuid;
}

/** Updates only catalog-owned flags; other characteristics and authored climbs survive. */
export function planWoodsRuleRepair(catalog: ReadonlyMap<string, WoodsCatalogRules>, stored: WoodsStoredRules[]) {
  const updates: WoodsRuleUpdate[] = [];
  let matched = 0;
  let unmatched = 0;
  for (const climb of stored) {
    if (climb.boardType !== 'woods' || climb.userId !== null) continue;
    const source = catalog.get(climb.uuid);
    if (!source) {
      unmatched++;
      continue;
    }
    if (climb.frames !== source.frames || JSON.stringify(climb.compatibleSizeIds) !== JSON.stringify([source.sizeId])) {
      throw new Error(`Stored Woods climb ${climb.uuid} differs from its catalog holds or size`);
    }
    matched++;
    const retained = (climb.characteristics ?? []).filter(
      (token) => token !== CLIMB_CHARACTERISTICS.NO_MATCH && token !== CLIMB_CHARACTERISTICS.ANY_FEET,
    );
    const characteristics = [...retained, ...source.characteristics];
    if (JSON.stringify(climb.characteristics) === JSON.stringify(characteristics)) continue;
    updates.push({ ...source, characteristics, previousCharacteristics: climb.characteristics });
  }
  return { matched, unmatched, unchanged: matched - updates.length, updates };
}
