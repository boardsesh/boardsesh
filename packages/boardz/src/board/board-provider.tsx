import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { readJson, writeJson } from '../storage/json-storage';
import { isActiveBoard, type ActiveBoard } from './active-board';

const STORAGE_KEY = 'boardz.activeBoard';

type BoardContextValue = {
  board: ActiveBoard | null;
  /** True until the stored board has been read. */
  isLoading: boolean;
  setBoard: (board: ActiveBoard) => void;
  setAngle: (angle: number) => void;
};

const BoardContext = createContext<BoardContextValue | null>(null);

export function BoardProvider({ children }: { children: ReactNode }) {
  const [board, setBoardState] = useState<ActiveBoard | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void readJson(STORAGE_KEY, isActiveBoard).then((stored) => {
      if (cancelled) return;
      setBoardState(stored);
      setIsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = (next: ActiveBoard) => {
    setBoardState(next);
    writeJson(STORAGE_KEY, next);
  };

  const value: BoardContextValue = {
    board,
    isLoading,
    setBoard: save,
    setAngle: (angle) => {
      if (board && board.angle !== angle) save({ ...board, angle });
    },
  };

  return <BoardContext.Provider value={value}>{children}</BoardContext.Provider>;
}

export function useBoard(): BoardContextValue {
  const context = useContext(BoardContext);
  if (!context) throw new Error('useBoard must be used inside BoardProvider');
  return context;
}
