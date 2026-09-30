import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { randomUUID } from 'expo-crypto';
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import type { ActiveBoard } from '../board/active-board';
import { readJson, writeJson } from '../storage/json-storage';
import {
  addList,
  deleteList,
  isClimbLists,
  listKey,
  listsByClimb,
  removeClimb,
  renameList,
  toggleClimb,
  withDefaultLists,
  type ClimbList,
} from './lists';

// Lists live on the phone. They don't sync with an account.
const LISTS_KEY = 'boardz.lists';
const ON_NO_LISTS: ReadonlySet<string> = new Set();

type ListsContextValue = {
  /** Favourites, Projects, then the climber's own lists. */
  lists: ClimbList[];
  /** The ids of the lists a climb is on. */
  listIdsFor: (boardName: BoardName, uuid: string) => ReadonlySet<string>;
  /** Puts the climb on the list, or takes it off. */
  toggle: (listId: string, climb: Climb, board: ActiveBoard) => void;
  removeFromList: (listId: string, boardName: BoardName, uuid: string) => void;
  /** Starts a new list and returns its id. */
  create: (name: string) => string;
  rename: (listId: string, name: string) => void;
  remove: (listId: string) => void;
};

const ListsContext = createContext<ListsContextValue | null>(null);

export function ListsProvider({ children }: { children: ReactNode }) {
  const [lists, setLists] = useState<ClimbList[]>(() => withDefaultLists([], new Date().toISOString()));
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void readJson(LISTS_KEY, isClimbLists).then((stored) => {
      if (cancelled) return;
      if (stored) setLists(withDefaultLists(stored, new Date().toISOString()));
      setHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist after hydration, so the first render's empty lists never overwrite what's stored.
  useEffect(() => {
    if (hydrated) writeJson(LISTS_KEY, lists);
  }, [lists, hydrated]);

  const index = listsByClimb(lists);

  const value: ListsContextValue = {
    lists,
    listIdsFor: (boardName, uuid) => index.get(listKey(boardName, uuid)) ?? ON_NO_LISTS,
    toggle: (listId, climb, board) => {
      const saved = {
        climb,
        boardName: board.boardName,
        layoutId: board.layoutId,
        savedAt: new Date().toISOString(),
      };
      setLists((current) => toggleClimb(current, listId, saved));
    },
    removeFromList: (listId, boardName, uuid) => {
      setLists((current) => removeClimb(current, listId, boardName, uuid));
    },
    create: (name) => {
      const id = randomUUID();
      const now = new Date().toISOString();
      setLists((current) => addList(current, id, name, now));
      return id;
    },
    rename: (listId, name) => {
      setLists((current) => renameList(current, listId, name));
    },
    remove: (listId) => {
      setLists((current) => deleteList(current, listId));
    },
  };

  return <ListsContext.Provider value={value}>{children}</ListsContext.Provider>;
}

export function useLists(): ListsContextValue {
  const context = useContext(ListsContext);
  if (!context) throw new Error('useLists must be used inside ListsProvider');
  return context;
}
