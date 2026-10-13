import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SEARCH_CLIMBS_COUNT } from '../../packages/shared/graphql/src/operations/climb-search';
import { buildCountPreviewInput } from '../../packages/mobile/src/lib/climb-count-preview-input';
import { DEFAULT_FILTERS } from '../../packages/mobile/src/lib/climb-filter-types';
import {
  canonicalJson,
  graphqlFixtureKey,
  STATIC_KEY_LENGTH,
  type GraphqlFixtureFile,
  type ScreenshotFixtureManifest,
} from './screenshot-fixtures';
import { readCppPage, type CppGradeCountProof } from './screenshot-cpp';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const locales = ['en-US', 'es', 'fr', 'de'] as const;
type CountLocale = (typeof locales)[number];
function assertCountFixtureIndex(manifest: ScreenshotFixtureManifest, fixture: GraphqlFixtureFile): void {
  const key = graphqlFixtureKey(fixture, sha256);
  const file = `graphql/${key.operationName}/${key.variablesHash.slice(0, STATIC_KEY_LENGTH)}.json`;
  const entry = manifest.graphql.find(
    (candidate) => candidate.operationName === key.operationName && candidate.variablesHash === key.variablesHash,
  );
  if (
    !entry ||
    entry.file !== file ||
    entry.documentHash !== key.documentHash ||
    fixture.documentHash !== key.documentHash ||
    fixture.variablesHash !== key.variablesHash
  )
    throw new Error('CPP count fixture index failed canonical provenance verification');
}

/** The exact native count wire input, bound to the recorded owned primary UUID. */
export function cppGradeCountKey(manifest: ScreenshotFixtureManifest, fixtures: readonly GraphqlFixtureFile[]) {
  const coverage = manifest.capture?.cpp;
  const grade = coverage?.scenes.search?.gradeFilter;
  if (manifest.flow !== 'app-store-cpp' || !coverage || !grade || !manifest.accountUserId)
    throw new Error('CPP grade count lacks its recorded account and selection');
  const primaryId = coverage.scenes.search.boardId;
  const variant = readCppPage(coverage.target).primaryBoard;
  if (coverage.boardIds?.[variant.id] !== primaryId)
    throw new Error('CPP grade count primary UUID differs from capture boards');
  const rows = fixtures
    .filter((fixture) => fixture.operationName === 'GetMyBoards')
    .flatMap((fixture) => {
      assertCountFixtureIndex(manifest, fixture);
      const key = graphqlFixtureKey(fixture, sha256);
      if (
        fixture.status !== 200 ||
        key.documentHash !== fixture.documentHash ||
        key.variablesHash !== fixture.variablesHash ||
        (fixture.response as { errors?: unknown })?.errors !== undefined
      )
        throw new Error('CPP grade count roster failed provenance verification');
      const response = fixture.response as {
        data?: {
          myBoards?: {
            boards?: Array<{
              uuid: string;
              ownerId: string;
              boardType: string;
              layoutId: number;
              sizeId: number;
              setIds: string;
              angle: number;
            }>;
          };
        };
      };
      return response.data?.myBoards?.boards ?? [];
    })
    .filter((row) => row.uuid === primaryId);
  const board = rows[0];
  const geometry = (row: NonNullable<typeof board>) => ({
    boardType: row.boardType,
    layoutId: row.layoutId,
    sizeId: row.sizeId,
    setIds: row.setIds,
    angle: row.angle,
  });
  if (
    !board ||
    rows.some(
      (row) =>
        row.ownerId !== manifest.accountUserId || canonicalJson(geometry(row)) !== canonicalJson(geometry(board)),
    ) ||
    !board.boardType ||
    !Number.isSafeInteger(board.layoutId) ||
    board.layoutId < 1 ||
    !Number.isSafeInteger(board.sizeId) ||
    board.sizeId < 1 ||
    !Number.isFinite(board.angle) ||
    typeof board.setIds !== 'string'
  )
    throw new Error('CPP grade count lacks unique owned primary geometry');
  const sets = board.setIds
    .split(',')
    .map(Number)
    .sort((left, right) => left - right);
  if (
    board.boardType !== variant.boardType ||
    (variant.layoutId !== undefined && board.layoutId !== variant.layoutId) ||
    (variant.sizeId !== undefined && board.sizeId !== variant.sizeId) ||
    (variant.angle !== undefined && board.angle !== variant.angle) ||
    sets.some((set) => !Number.isSafeInteger(set) || set < 1) ||
    (variant.setIds !== undefined &&
      canonicalJson(sets) !== canonicalJson([...variant.setIds].sort((left, right) => left - right)))
  )
    throw new Error('CPP grade count primary configuration differs from target');
  if (!Number.isInteger(grade.minGradeId) || !Number.isInteger(grade.maxGradeId) || grade.minGradeId > grade.maxGradeId)
    throw new Error('CPP grade count has invalid real grade bounds');
  const variables = {
    input: buildCountPreviewInput(
      { ...DEFAULT_FILTERS, minGrade: grade.minGradeId, maxGrade: grade.maxGradeId },
      {},
      {
        boardName: board.boardType,
        layoutId: board.layoutId,
        sizeId: board.sizeId,
        setIds: board.setIds,
        angle: board.angle,
      },
      '',
    ),
  };
  return {
    ...graphqlFixtureKey({ operationName: 'SearchClimbsCount', query: SEARCH_CLIMBS_COUNT, variables }, sha256),
    variables,
  };
}

export function resolveCppGradeCountProof(
  manifest: ScreenshotFixtureManifest,
  fixtures: readonly GraphqlFixtureFile[],
): CppGradeCountProof {
  const key = cppGradeCountKey(manifest, fixtures);
  const matches = fixtures.filter(
    (fixture) => fixture.operationName === key.operationName && fixture.variablesHash === key.variablesHash,
  );
  if (matches.length !== 1) throw new Error('CPP exact grade count recording is missing or ambiguous');
  const fixture = matches[0];
  assertCountFixtureIndex(manifest, fixture);
  const actualKey = graphqlFixtureKey(fixture, sha256);
  const response = fixture.response as { errors?: unknown; data?: { searchClimbs?: { totalCount?: unknown } } };
  const totalCount = response?.data?.searchClimbs?.totalCount;
  if (
    fixture.documentHash !== key.documentHash ||
    actualKey.documentHash !== key.documentHash ||
    actualKey.variablesHash !== key.variablesHash ||
    canonicalJson(fixture.variables) !== canonicalJson(key.variables) ||
    fixture.status !== 200 ||
    response?.errors !== undefined ||
    typeof totalCount !== 'number' ||
    !Number.isSafeInteger(totalCount) ||
    totalCount < 1 ||
    !Number.isFinite(Date.parse(fixture.recordedAt)) ||
    fixture.upstream !== manifest.upstream
  )
    throw new Error('CPP exact grade count response failed provenance verification');
  return {
    file: `graphql/${key.operationName}/${key.variablesHash.slice(0, STATIC_KEY_LENGTH)}.json`,
    documentHash: key.documentHash,
    variablesHash: key.variablesHash,
    recordedAt: fixture.recordedAt,
    responseSha256: sha256(canonicalJson(fixture.response)),
    totalCount,
  };
}

export function bindCppGradeCountProof(
  manifest: ScreenshotFixtureManifest,
  fixtures: readonly GraphqlFixtureFile[],
): ScreenshotFixtureManifest {
  const proof = resolveCppGradeCountProof(manifest, fixtures);
  const capture = manifest.capture!;
  const coverage = capture.cpp!;
  const search = coverage.scenes.search;
  return {
    ...manifest,
    capture: {
      ...capture,
      cpp: {
        ...coverage,
        scenes: {
          ...coverage.scenes,
          search: { ...search, gradeFilter: { ...search.gradeFilter!, expectedCount: proof.totalCount, proof } },
        },
      },
    },
  };
}

export function assertCppGradeCountProof(
  manifest: ScreenshotFixtureManifest,
  fixtures: readonly GraphqlFixtureFile[],
): void {
  if (!manifest.capture?.cpp?.scenes.search?.gradeFilter) return;
  const actual = resolveCppGradeCountProof(manifest, fixtures);
  const grade = manifest.capture.cpp.scenes.search.gradeFilter;
  if (
    grade.expectedCount !== actual.totalCount ||
    (grade.proof && canonicalJson(grade.proof) !== canonicalJson(actual))
  )
    throw new Error('CPP grade count metadata differs from its exact recorded response');
}

/** One locale-formatted, API-proven number, never a count wildcard. */
export function cppRecordedCountSelector(count: number, locale: string): string {
  if (!locales.includes(locale as CountLocale) || !Number.isSafeInteger(count) || count < 1)
    throw new Error('Invalid CPP count locale or value');
  const catalog = JSON.parse(
    readFileSync(new URL(`../../packages/shared/i18n/locales/${locale}/climbs.json`, import.meta.url), 'utf8'),
  ) as { mobile: { filter: Record<string, string> } };
  const plural = new Intl.PluralRules(locale).select(count);
  const template = catalog.mobile.filter[`matchingCount_${plural}`] ?? catalog.mobile.filter.matchingCount;
  if (!template) throw new Error('CPP count translation is missing');
  const label = template.replace(/\{\{count(?:,\s*number)?\}\}/g, new Intl.NumberFormat(locale).format(count));
  return `^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

export function readCppCountFixtures(directory: string, manifest: ScreenshotFixtureManifest): GraphqlFixtureFile[] {
  return manifest.graphql
    .filter((entry) => ['GetMyBoards', 'SearchClimbsCount'].includes(entry.operationName))
    .map((entry) => {
      if (!/^graphql\/[A-Za-z_]\w*\/[a-f0-9]+\.json$/.test(entry.file))
        throw new Error('Invalid CPP count fixture path');
      const fixture = JSON.parse(readFileSync(join(directory, entry.file), 'utf8')) as GraphqlFixtureFile;
      if (
        fixture.operationName !== entry.operationName ||
        fixture.variablesHash !== entry.variablesHash ||
        fixture.documentHash !== entry.documentHash
      )
        throw new Error('CPP count fixture index differs from actual recording');
      assertCountFixtureIndex(manifest, fixture);
      return fixture;
    });
}
