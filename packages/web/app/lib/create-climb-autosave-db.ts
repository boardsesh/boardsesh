import { createIndexedDBStore } from './idb-helper';

const STORE_NAME = 'autosave';
const AUTOSAVE_KEY = 'create-climb';

export type CreateClimbAutosave = {
  /**
   * The *active* frame only (JSON stringified LitUpHoldsMap), kept for backward
   * compatibility — `framesJson` below is the full route and takes priority when
   * present. Autosaves written before `framesJson` existed only have this.
   */
  holdsJson: string;
  /** JSON.stringify(LitUpHoldsMap[]) — the full frame sequence, every board. */
  framesJson?: string;
  climbName: string;
  description: string;
  isDraft: boolean;
  /** Board identifier so we only restore on the matching board */
  boardKey: string;
};

const getDB = createIndexedDBStore('boardsesh-create-climb', STORE_NAME);

export async function saveAutosave(data: CreateClimbAutosave): Promise<void> {
  try {
    const db = await getDB();
    if (!db) return;
    await db.put(STORE_NAME, data, AUTOSAVE_KEY);
  } catch {
    // Silently ignore — autosave is best-effort
  }
}

export async function loadAutosave(boardKey: string): Promise<CreateClimbAutosave | null> {
  try {
    const db = await getDB();
    if (!db) return null;
    const data = (await db.get(STORE_NAME, AUTOSAVE_KEY)) as CreateClimbAutosave | undefined;
    if (!data || data.boardKey !== boardKey) return null;
    return data;
  } catch {
    return null;
  }
}

export async function clearAutosave(): Promise<void> {
  try {
    const db = await getDB();
    if (!db) return;
    await db.delete(STORE_NAME, AUTOSAVE_KEY);
  } catch {
    // Silently ignore
  }
}
