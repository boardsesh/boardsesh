// File-picker filters for the logbook imports in Settings > Integrations.
//
// Android file providers label exports inconsistently: Downloads often says
// text/comma-separated-values, and files saved from mail or Google Drive arrive
// as application/octet-stream, so a MIME filter greys real exports out (#5426).
// Android opens the picker unfiltered and the importer rejects anything that
// isn't an export with its own message. iOS matches by file type (UTType) and
// the browser by `accept`, so both keep the filter.

export type ImportFileKind = 'moonBoardCsv' | 'auroraJson';

const FILTERED_PICKER_TYPES: Record<ImportFileKind, string[]> = {
  moonBoardCsv: ['text/csv', 'text/plain', 'application/vnd.ms-excel'],
  auroraJson: ['application/json'],
};

/** The `type` option for `getDocumentAsync`, given `Platform.OS`. */
export function getImportPickerTypes(kind: ImportFileKind, platformOs: string): string | string[] {
  return platformOs === 'android' ? '*/*' : FILTERED_PICKER_TYPES[kind];
}
