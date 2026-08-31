import type { OfflineDatabase } from '@boardsesh/offline-sync';
import type { QuantumGeometryRegistration } from '../../lib/quantum-geometry-store';

type QuantumGeometryRow = {
  layout_id: number;
  size_id: number;
  revision: string;
  edge_left: number;
  edge_right: number;
  edge_bottom: number;
  edge_top: number;
  placements_json: string;
};

export async function getQuantumGeometryLocal(
  db: OfflineDatabase,
  layoutId: number,
  sizeId: number,
): Promise<QuantumGeometryRegistration | null> {
  const row = await db.getFirstAsync<QuantumGeometryRow>(
    `SELECT layout_id, size_id, revision, edge_left, edge_right, edge_bottom, edge_top, placements_json
       FROM quantum_geometry
      WHERE layout_id = ? AND size_id = ?
      LIMIT 1`,
    [layoutId, sizeId],
  );
  if (!row) return null;
  try {
    const placements: unknown = JSON.parse(row.placements_json);
    if (!Array.isArray(placements)) return null;
    return {
      layoutId: row.layout_id,
      sizeId: row.size_id,
      revision: row.revision,
      edgeLeft: row.edge_left,
      edgeRight: row.edge_right,
      edgeBottom: row.edge_bottom,
      edgeTop: row.edge_top,
      placements: placements as QuantumGeometryRegistration['placements'],
    };
  } catch {
    return null;
  }
}

export async function putQuantumGeometryLocal(
  db: OfflineDatabase,
  geometry: QuantumGeometryRegistration,
): Promise<void> {
  await db.runAsync(
    `INSERT OR REPLACE INTO quantum_geometry (
       layout_id, size_id, revision, edge_left, edge_right, edge_bottom, edge_top, placements_json, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      geometry.layoutId,
      geometry.sizeId,
      geometry.revision,
      geometry.edgeLeft,
      geometry.edgeRight,
      geometry.edgeBottom,
      geometry.edgeTop,
      JSON.stringify(geometry.placements),
      new Date().toISOString(),
    ],
  );
}

export async function deleteQuantumGeometryLocal(db: OfflineDatabase, layoutId: number, sizeId: number): Promise<void> {
  await db.runAsync('DELETE FROM quantum_geometry WHERE layout_id = ? AND size_id = ?', [layoutId, sizeId]);
}
