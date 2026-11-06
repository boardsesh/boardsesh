import type { ReactNode } from 'react';
import type { SprayPhotoCanvasProps } from '../../components/spray-wall/SprayPhotoCanvas';
export type SprayPhotoSession = {
  viewerId: string;
  canvas: Omit<SprayPhotoCanvasProps, 'maxWidth' | 'maxHeight'>;
  tools: ReactNode;
  fullScreenRail?: ReactNode;
  overlayTools?: ReactNode;
  accessoryTools?: ReactNode;
};
const entries = new Map<string, { snapshot: SprayPhotoSession; onClose: () => void }>();
const listeners = new Set<() => void>();
let nextId = 0;
const notify = () => {
  for (const listener of listeners) listener();
};
export function createSprayPhotoSession(snapshot: SprayPhotoSession, onClose: () => void): string {
  const id = String(++nextId);
  entries.set(id, { snapshot, onClose });
  return id;
}
export const readSprayPhotoSession = (id: string): SprayPhotoSession | null => entries.get(id)?.snapshot ?? null;
export function updateSprayPhotoSession(id: string, snapshot: SprayPhotoSession): void {
  const entry = entries.get(id);
  if (entry) {
    entry.snapshot = snapshot;
    notify();
  }
}
export function closeSprayPhotoSession(id: string): void {
  const entry = entries.get(id);
  if (entry) {
    entries.delete(id);
    entry.onClose();
    notify();
  }
}
export function subscribeSprayPhotoSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
