import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-constants', () => ({ default: { expoConfig: null } }));

import { buildDevMetadataSection } from '../dev-metadata-section';

describe('buildDevMetadataSection', () => {
  it('keeps long QA notes inside the MoreForm model', () => {
    const qaNotes = 'Exercise the board renderer controls.\n'.repeat(100);

    expect(
      buildDevMetadataSection({
        branchName: 'fix/boardsesh-renderer-ios-artifact',
        qaNotes,
        qaNotesFilePath: '.boardsesh/qa-notes.md',
      }),
    ).toEqual({
      key: 'devBuild',
      title: 'Dev Build',
      rows: [
        {
          kind: 'info',
          key: 'devBranch',
          label: 'Branch',
          body: 'fix/boardsesh-renderer-ios-artifact',
          selectable: true,
        },
        {
          kind: 'info',
          key: 'devQaNotes',
          label: 'QA Notes',
          body: qaNotes,
          detail: '.boardsesh/qa-notes.md',
          selectable: true,
        },
      ],
    });
  });

  it('ignores object values produced when Expo serializes null extras', () => {
    expect(buildDevMetadataSection({ branchName: {}, qaNotes: {}, qaNotesFilePath: {} })).toBeNull();
  });

  it('builds a selectable branch-only section', () => {
    expect(buildDevMetadataSection({ branchName: 'release/next' })).toEqual({
      key: 'devBuild',
      title: 'Dev Build',
      rows: [
        {
          kind: 'info',
          key: 'devBranch',
          label: 'Branch',
          body: 'release/next',
          selectable: true,
        },
      ],
    });
  });

  it('builds selectable notes without requiring a file path', () => {
    expect(buildDevMetadataSection({ qaNotes: 'Exercise the More screen.' })).toEqual({
      key: 'devBuild',
      title: 'Dev Build',
      rows: [
        {
          kind: 'info',
          key: 'devQaNotes',
          label: 'QA Notes',
          body: 'Exercise the More screen.',
          selectable: true,
        },
      ],
    });
  });

  it('returns null when branch and notes are absent or empty', () => {
    expect(buildDevMetadataSection({})).toBeNull();
    expect(buildDevMetadataSection({ branchName: '', qaNotes: '' })).toBeNull();
  });
});
