import { createContext, useContext } from 'react';
import { STORY_BOARD, STORY_CLIMBS } from '../fixtures/climbs';
import type { StoryBoardFixture } from '../fixtures/boards';

export type StoryBoardPresentation = StoryBoardFixture & {
  label: string;
  attemptsOnly?: boolean;
  gradeRange?: { minGrade: number; maxGrade: number; label: string };
};
const DEFAULT_PRESENTATION: StoryBoardPresentation = {
  board: STORY_BOARD,
  climbs: STORY_CLIMBS,
  label: STORY_BOARD.name,
};
export const StoryBoardFixtureContext = createContext<StoryBoardPresentation>(DEFAULT_PRESENTATION);
export function useStoryBoardFixture() {
  return useContext(StoryBoardFixtureContext);
}
