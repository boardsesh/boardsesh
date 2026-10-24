import { describe, it, expect } from 'vitest';
import { getImportPickerTypes } from '../import-picker-types';

describe('getImportPickerTypes', () => {
  // Drive and mail label exports application/octet-stream or
  // text/comma-separated-values, so any MIME list greys them out (#5426).
  it('opens the Android picker unfiltered for both imports', () => {
    expect(getImportPickerTypes('moonBoardCsv', 'android')).toBe('*/*');
    expect(getImportPickerTypes('auroraJson', 'android')).toBe('*/*');
  });

  it('keeps the file-type filter on iOS', () => {
    expect(getImportPickerTypes('moonBoardCsv', 'ios')).toEqual(['text/csv', 'text/plain', 'application/vnd.ms-excel']);
    expect(getImportPickerTypes('auroraJson', 'ios')).toEqual(['application/json']);
  });

  it('keeps the filter in the browser app', () => {
    expect(getImportPickerTypes('moonBoardCsv', 'web')).toEqual(['text/csv', 'text/plain', 'application/vnd.ms-excel']);
    expect(getImportPickerTypes('auroraJson', 'web')).toEqual(['application/json']);
  });
});
