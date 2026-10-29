/** One named problem from a MoonBoard account export, without ascent data. */
export type MoonBoardCollectionRow = {
  lineNumber: number;
  name: string;
  grade: string;
  setter?: string;
};

export type MoonBoardCollectionDestination = {
  id: string;
  uuid: string;
  name: string;
  layoutId: number | null;
};

export type MoonBoardCollectionPreviewInput = {
  layoutId: number;
  angle: number;
  rows: MoonBoardCollectionRow[];
};

export type MoonBoardCollectionMatchStatus = 'matched' | 'missing' | 'ambiguous' | 'duplicate';

export type MoonBoardCollectionMatch = {
  lineNumber: number;
  name: string;
  grade: string;
  climbUuid: string | null;
  status: MoonBoardCollectionMatchStatus;
};

export type MoonBoardCollectionPreview = {
  rows: MoonBoardCollectionMatch[];
  matched: number;
  missing: number;
  ambiguous: number;
  duplicates: number;
};

export type MoonBoardCollectionImportInput = MoonBoardCollectionPreviewInput & {
  playlistUuid: string;
  playlistName: string;
  playlistId?: string;
};

export type MoonBoardCollectionImportResult = {
  playlistId: string;
  playlistUuid: string;
  imported: number;
  skipped: number;
  preview: MoonBoardCollectionPreview;
};
