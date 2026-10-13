import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { isCppClimbId, type CppRecordedBoard } from './screenshot-cpp';
import { readScreenshotFixtureManifest } from './screenshot-backend';
import {
  SCREENSHOT_WALL_SEED_COUNT,
  screenshotWallKioskPaintedTestId,
} from '../../packages/mobile/src/lib/screenshot-climb-selection';
import { DEFAULT_CLIMB_FILTER_STATE, toClimbSearchInput } from '../../packages/shared/climb-filters/src/filter-state';
import { SEARCH_CLIMBS } from '../../packages/mobile/src/lib/graphql/operations';
import { canonicalJson, graphqlFixtureKey, normalizeDocument } from './screenshot-fixtures';
import {
  matchScreenshotBoardCandidates,
  type ScreenshotBoardMatchingFields,
} from '../../packages/mobile/src/lib/screenshot-board-matching';

export interface IosCampaignPrimaryCapture {
  board: CppRecordedBoard & { setIds: string };
  climb: { uuid: string; name: string; frames: string; angle: number };
  paintedId: string;
}

/** Resolve the primary identity and wall seed from recorded answers before launching Metro. */
export function readIosCampaignPrimaryCapture(
  fixturesDir: string,
  selector: string,
  recordedBoards: readonly (CppRecordedBoard & ScreenshotBoardMatchingFields)[],
): IosCampaignPrimaryCapture {
  const canonicalSets = (setIds: string) =>
    setIds
      .split(',')
      .map(Number)
      .sort((left, right) => left - right)
      .join(',');
  const matches = matchScreenshotBoardCandidates(recordedBoards, selector);
  if (
    !matches.length ||
    matches.some(
      (board) =>
        !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(board.uuid) ||
        board.boardType !== 'kilter' ||
        !Number.isSafeInteger(board.layoutId) ||
        board.layoutId <= 0 ||
        !Number.isSafeInteger(board.sizeId) ||
        board.sizeId <= 0 ||
        !Number.isFinite(board.angle) ||
        !board.setIds ||
        !/^\d+(,\d+)*$/.test(board.setIds),
    )
  )
    throw new Error('Regular campaign primary board must have a genuine recorded Kilter identity');
  const identities = new Map(
    matches.map((board) => [
      JSON.stringify([
        board.uuid,
        board.boardType,
        board.layoutId,
        board.sizeId,
        canonicalSets(board.setIds!),
        board.angle,
      ]),
      board,
    ]),
  );
  if (identities.size !== 1) throw new Error('Regular campaign primary board identity is ambiguous');
  const recorded = [...identities.values()][0];
  const board = { ...recorded, setIds: recorded.setIds! };
  const expectedInput = toClimbSearchInput(
    DEFAULT_CLIMB_FILTER_STATE,
    {
      boardName: board.boardType,
      layoutId: board.layoutId,
      sizeId: board.sizeId,
      setIds: canonicalSets(board.setIds),
      angle: board.angle,
    },
    { page: 0, pageSize: SCREENSHOT_WALL_SEED_COUNT },
  );
  const manifest = readScreenshotFixtureManifest(fixturesDir);
  const seeds = (manifest?.graphql ?? [])
    .filter((entry) => entry.operationName === 'SearchClimbs')
    .flatMap((entry) => {
      const fixture = JSON.parse(readFileSync(join(fixturesDir, entry.file), 'utf8')) as {
        operationName: string;
        documentHash: string;
        variablesHash: string;
        status: number;
        query?: string;
        variables?: {
          input?: {
            boardName: string;
            layoutId: number;
            sizeId: number;
            setIds: string;
            angle: number;
            page: number;
            pageSize: number;
          };
        };
        response?: {
          errors?: unknown[];
          data?: {
            searchClimbs?: {
              climbs?: Array<{
                uuid: string;
                name: string;
                frames: string;
                boardType: string;
                layoutId: number;
                angle: number;
                compatibleSizeIds?: number[];
              }>;
            };
          };
        };
      };
      const query = fixture.variables?.input;
      if (
        !query ||
        typeof query.setIds !== 'string' ||
        canonicalJson({ ...query, setIds: canonicalSets(query.setIds) }) !== canonicalJson(expectedInput) ||
        typeof fixture.query !== 'string' ||
        normalizeDocument(fixture.query) !== normalizeDocument(SEARCH_CLIMBS)
      )
        return [];
      const key = graphqlFixtureKey({ ...fixture, query: fixture.query }, (text) =>
        createHash('sha256').update(text).digest('hex'),
      );
      if (
        fixture.status !== 200 ||
        fixture.response?.errors?.length ||
        fixture.operationName !== 'SearchClimbs' ||
        key.documentHash !== entry.documentHash ||
        key.variablesHash !== entry.variablesHash ||
        key.documentHash !== fixture.documentHash ||
        key.variablesHash !== fixture.variablesHash
      )
        throw new Error('Regular campaign primary seed response or index provenance is invalid');
      const climb = fixture.response?.data?.searchClimbs?.climbs?.[0];
      if (
        !climb?.uuid ||
        !isCppClimbId(climb.uuid) ||
        climb.name !== 'Lightest Pair of Shorts' ||
        !climb.frames?.trim() ||
        climb.boardType !== board.boardType ||
        climb.layoutId !== board.layoutId ||
        climb.angle !== board.angle ||
        (climb.compatibleSizeIds && !climb.compatibleSizeIds.includes(board.sizeId))
      )
        throw new Error('Regular campaign primary wall seed is missing or belongs to another board');
      return [{ uuid: climb.uuid, name: climb.name, frames: climb.frames, angle: climb.angle }];
    });
  const uniqueSeeds = new Map(seeds.map((climb) => [JSON.stringify(climb), climb]));
  if (uniqueSeeds.size !== 1) throw new Error('Regular campaign needs one unambiguous recorded primary wall seed');
  const climb = [...uniqueSeeds.values()][0];
  const paintedId = screenshotWallKioskPaintedTestId(
    true,
    board.uuid,
    { ...board, boardName: board.boardType },
    {
      climbUuid: climb.uuid,
      frames: climb.frames,
      angle: climb.angle,
    },
  );
  if (!paintedId) throw new Error('Regular campaign primary artwork identity is incomplete');
  return { board, climb, paintedId };
}
