import type { AscentFeedItem } from '@boardsesh/graphql/operations';
import { STORY_BOARD, STORY_CLIMBS } from './climbs';
import type { StoryBoardPresentation } from '../stories/story-board-fixture';
export function buildStoryAscents({ board, climbs, label, attemptsOnly }: StoryBoardPresentation): AscentFeedItem[] {
  return climbs.slice(0, 4).map((climb, index) => ({
    uuid: `story-ascent-${index}`,
    climbUuid: climb.uuid,
    climbName: climb.name,
    setterUsername: climb.setter_username,
    boardType: board.boardName,
    boardId: null,
    boardDisplayName: label,
    layoutId: board.layoutId,
    renderBoard: {
      layoutId: board.layoutId,
      sizeId: board.sizeId,
      setIds: board.setIds.split(',').map(Number),
    },
    angle: board.angle,
    isMirror: false,
    status: attemptsOnly ? 'attempt' : index === 0 ? 'flash' : index === 2 ? 'attempt' : 'send',
    attemptCount: index + 1,
    quality: 3,
    difficulty: null,
    difficultyName: climb.difficulty,
    boardseshDifficulty: null,
    boardseshConfidence: null,
    consensusDifficulty: null,
    consensusDifficultyName: climb.difficulty,
    qualityAverage: null,
    isBenchmark: false,
    isNoMatch: false,
    comment: index === 1 ? 'Keep the left heel high.' : '',
    climbedAt: `2026-10-26T10:${index}0:00.000Z`,
    frames: climb.frames,
    hasBetaVideo: index === 0,
  }));
}
export const STORY_ASCENTS = buildStoryAscents({ board: STORY_BOARD, climbs: STORY_CLIMBS, label: 'Garage Board' });
