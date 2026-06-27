import type { FeedbackContextInput, SubmitAppFeedbackInput, UserBoard } from '@boardsesh/shared-schema';
import type { ClimbQueueItem } from '@boardsesh/queue';

const BOARD_NAME_MAX = 100;
const URL_MAX = 1000;

type MobileFeedbackEnrichment = Pick<
  SubmitAppFeedbackInput,
  'boardName' | 'layoutId' | 'sizeId' | 'setIds' | 'angle' | 'context'
>;

export type BuildMobileFeedbackEnrichmentArgs = {
  activeBoard: UserBoard | null | undefined;
  currentClimbQueueItem: ClimbQueueItem | null;
  sessionId: string | null;
  pathname: string | null | undefined;
  /** Opt-in BLE diagnostics dump; only set when the reporter ticks the toggle. */
  bleDiagnostics?: string | null;
};

export function clipFeedbackString(value: string | null | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) return undefined;
  return trimmedValue.length > maxLength ? trimmedValue.slice(0, maxLength) : trimmedValue;
}

function compactFeedbackContext(input: FeedbackContextInput): FeedbackContextInput | null {
  const context: FeedbackContextInput = {};
  for (const [contextKey, contextValue] of Object.entries(input) as Array<[keyof FeedbackContextInput, unknown]>) {
    if (typeof contextValue === 'string' && contextValue.length > 0) {
      context[contextKey] = contextValue;
    }
  }
  return Object.keys(context).length > 0 ? context : null;
}

function parseBoardSetIds(setIds: string | null | undefined): number[] | null {
  if (!setIds) return null;
  const parsedSetIds = setIds
    .split(',')
    .map((rawSetId) => Number.parseInt(rawSetId, 10))
    .filter((setId) => Number.isFinite(setId));
  return parsedSetIds.length > 0 ? parsedSetIds : null;
}

export function buildMobileFeedbackEnrichment(args: BuildMobileFeedbackEnrichmentArgs): MobileFeedbackEnrichment {
  const currentClimb = args.currentClimbQueueItem?.climb;
  const activeBoard = args.activeBoard ?? null;

  return {
    boardName: clipFeedbackString(activeBoard?.boardType, BOARD_NAME_MAX) ?? null,
    layoutId: activeBoard?.layoutId ?? null,
    sizeId: activeBoard?.sizeId ?? null,
    setIds: parseBoardSetIds(activeBoard?.setIds),
    angle: activeBoard?.angle ?? null,
    context: compactFeedbackContext({
      climbUuid: currentClimb?.uuid,
      climbName: currentClimb?.name,
      difficulty: currentClimb?.difficulty,
      sessionId: args.sessionId,
      url: clipFeedbackString(args.pathname, URL_MAX),
      bleDiagnostics: args.bleDiagnostics ?? undefined,
    }),
  };
}
