import { gql } from 'graphql-request';

export const IMPORT_TICKS_BATCH = gql`
  mutation ImportTicksBatch($input: ImportTicksBatchInput!) {
    importTicksBatch(input: $input) {
      imported
      skipped
      duplicates
      errors
    }
  }
`;

export interface ImportTickRow {
  climbUuid?: string | null;
  climbName: string;
  angle: number;
  date: string;
  loggedGrade?: string | null;
  displayedGrade?: string | null;
  isBenchmark: boolean;
  tries: number;
  isMirror: boolean;
  isAscent: boolean;
  comment?: string | null;
}

export interface ImportTicksBatchInput {
  boardType: string;
  rows: ImportTickRow[];
  buildSessions?: boolean;
}

export interface ImportTicksBatchResult {
  importTicksBatch: {
    imported: number;
    skipped: number;
    duplicates: number;
    errors: string[];
  };
}
