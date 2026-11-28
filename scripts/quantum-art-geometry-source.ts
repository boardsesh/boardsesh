import path from 'node:path';
import {
  getQuantumBundledGeometry,
  QUANTUM_MODELS,
  QUANTUM_RELEASED_MODELS,
} from '../packages/board-constants/src/quantum';
import { getQuantumBoardDetails, projectQuantumBoardArtwork } from '../packages/shared/board-config/src/index';
import {
  listCatalogueEntries,
  type CatalogueEntry,
} from '../packages/shared/board-render/src/render-version-projection';
import { getBoardDetailsForBoard } from '../packages/shared/board-render/src/board-details';
import type { BoardRenderDetails } from '../packages/shared/board-render/src/types';

/** Offline tracing/census catalogue includes flagged Quantum without opening server routes. */
export function listArtGeometryEntries(): CatalogueEntry[] {
  return [
    ...listCatalogueEntries(),
    ...QUANTUM_RELEASED_MODELS.map((model) => ({
      boardName: 'quantum' as const,
      layoutId: QUANTUM_MODELS[model].layoutId,
      sizeId: QUANTUM_MODELS[model].sizeId,
      setIds: [1],
    })),
  ];
}

export function getQuantumArtDetails(layoutId: number, sizeId: number, scaleCanvas = false): BoardRenderDetails {
  const geometry = getQuantumBundledGeometry(layoutId, sizeId);
  if (!geometry) throw new Error(`Missing Quantum geometry ${layoutId}-${sizeId}`);
  const details = getQuantumBoardDetails({
    ...geometry,
    placements: geometry.placements.map((hold) => ({ id: hold.placementId, x: hold.x, y: hold.y })),
  });
  if (!details || details.neutralGrid.model === 'belay') throw new Error('Quantum art is unavailable for this model');
  const model = details.neutralGrid.model === 's' ? 's-fitness' : details.neutralGrid.model;
  const projected = projectQuantumBoardArtwork(details, { scaleCanvas });
  return { ...projected, set_ids: [1], set_names: ['Default'], images_to_holds: { [`quantum/${model}`]: [] } };
}

export function getArtGeometryDetails(
  params: { board_name: string; layout_id: number; size_id: number; set_ids: number[] },
  scaleCanvas = false,
): BoardRenderDetails {
  return params.board_name === 'quantum'
    ? getQuantumArtDetails(params.layout_id, params.size_id, scaleCanvas)
    : getBoardDetailsForBoard(params);
}

export function resolveArtPath(relativePath: string): string {
  const root = path.resolve(import.meta.dirname, '..');
  return relativePath.startsWith('quantum/')
    ? path.join(
        root,
        'packages/mobile/src/components/quantum/board-art',
        `quantum-${relativePath.slice('quantum/'.length)}.webp`,
      )
    : path.join(root, 'packages/web/public', relativePath);
}
