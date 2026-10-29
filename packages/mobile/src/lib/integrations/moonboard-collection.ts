import { gql } from 'graphql-request';
import type {
  MoonBoardCollectionImportInput,
  MoonBoardCollectionImportResult,
  MoonBoardCollectionPreview,
  MoonBoardCollectionPreviewInput,
  MoonBoardCollectionDestination,
} from '@boardsesh/shared-schema';
import { getHttpClient } from '../graphql/client';

export const GET_MOONBOARD_COLLECTION_DESTINATIONS = gql`
  query MoonBoardCollectionDestinations($layoutId: Int!) {
    moonBoardCollectionDestinations(layoutId: $layoutId) {
      id
      uuid
      name
      layoutId
    }
  }
`;

export async function getMoonBoardCollectionDestinations(layoutId: number): Promise<MoonBoardCollectionDestination[]> {
  const response = await getHttpClient().request<{ moonBoardCollectionDestinations: MoonBoardCollectionDestination[] }>(
    GET_MOONBOARD_COLLECTION_DESTINATIONS,
    { layoutId },
  );
  return response.moonBoardCollectionDestinations;
}

const COLLECTION_PREVIEW_FIELDS = `
  matched missing ambiguous duplicates
  rows { lineNumber name grade climbUuid status }
`;

export const PREVIEW_MOONBOARD_COLLECTION = gql`
  query PreviewMoonBoardCollectionImport($input: MoonBoardCollectionPreviewInput!) {
    previewMoonBoardCollectionImport(input: $input) { ${COLLECTION_PREVIEW_FIELDS} }
  }
`;

export const IMPORT_MOONBOARD_COLLECTION = gql`
  mutation ImportMoonBoardCollection($input: MoonBoardCollectionImportInput!) {
    importMoonBoardCollection(input: $input) {
      playlistId playlistUuid imported skipped
      preview { ${COLLECTION_PREVIEW_FIELDS} }
    }
  }
`;

export async function previewMoonBoardCollection(
  input: MoonBoardCollectionPreviewInput,
): Promise<MoonBoardCollectionPreview> {
  const response = await getHttpClient().request<{ previewMoonBoardCollectionImport: MoonBoardCollectionPreview }>(
    PREVIEW_MOONBOARD_COLLECTION,
    { input },
  );
  return response.previewMoonBoardCollectionImport;
}

export async function importMoonBoardCollection(
  input: MoonBoardCollectionImportInput,
): Promise<MoonBoardCollectionImportResult> {
  const response = await getHttpClient().request<{ importMoonBoardCollection: MoonBoardCollectionImportResult }>(
    IMPORT_MOONBOARD_COLLECTION,
    { input },
  );
  return response.importMoonBoardCollection;
}
