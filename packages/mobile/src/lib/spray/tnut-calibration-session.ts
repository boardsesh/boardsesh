import type { Quad, TnutGridOptions } from '@boardsesh/spray-wall-geometry';
import type { SprayLookPreviewSource } from './spray-look-preview';

export type TnutCalibrationSession = {
  viewerId: string;
  source: SprayLookPreviewSource;
  photoUri: string;
  quad: Quad;
  grid: Omit<TnutGridOptions, 'corners'>;
};

type Entry = {
  snapshot: TnutCalibrationSession;
  onChange: (quad: Quad) => void;
  onClose: () => void;
};
const sessions = new Map<string, Entry>();
const listeners = new Set<() => void>();
let nextId = 0;
const copyQuad = (quad: Quad): Quad => quad.map(([x, y]) => [x, y]);

/** An in-memory handoff to the fullscreen route; no photo URLs or drafts in route params. */
export function createTnutCalibrationSession(
  snapshot: TnutCalibrationSession,
  onChange: (quad: Quad) => void,
  onClose: () => void,
): string {
  const id = String(++nextId);
  sessions.set(id, { snapshot: { ...snapshot, quad: copyQuad(snapshot.quad) }, onChange, onClose });
  return id;
}

export function readTnutCalibrationSession(id: string): TnutCalibrationSession | null {
  return sessions.get(id)?.snapshot ?? null;
}

export function subscribeTnutCalibrationSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function updateTnutCalibrationSession(id: string, quad: Quad): void {
  const entry = sessions.get(id);
  if (!entry) return;
  entry.snapshot = { ...entry.snapshot, quad: copyQuad(quad) };
  entry.onChange(copyQuad(quad));
  for (const listener of listeners) listener();
}

export function closeTnutCalibrationSession(id: string): void {
  const entry = sessions.get(id);
  if (!entry) return;
  sessions.delete(id);
  entry.onClose();
  for (const listener of listeners) listener();
}
