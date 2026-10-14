import { describe, expect, it, vi } from 'vitest';
import { buildDeveloperModel, type DeveloperModelInput } from '../developer-model';
import type { MoreRow } from '../../../MoreForm.types';

type DevTools = NonNullable<DeveloperModelInput['devTools']>;

function devTools(overrides: Partial<DevTools> = {}): DevTools {
  return {
    showDevServerSwitcher: false,
    showFeatureFlags: false,
    showOfflineWrites: false,
    showQaPicker: false,
    showOutlineEditor: false,
    showSentryDiagnostics: false,
    forceServerUnreachable: { enabled: false, onChange: vi.fn() },
    ...overrides,
  };
}

function makeInput(overrides: Partial<DeveloperModelInput> = {}): DeveloperModelInput {
  return {
    t: (key: string) => key,
    devMetadataSection: null,
    devTools: devTools(),
    bottomChromeDiagnostics: null,
    showPreviewBuild: false,
    onNavigate: vi.fn(),
    ...overrides,
  };
}

function layout(input: DeveloperModelInput): [string, string[]][] {
  return buildDeveloperModel(input).sections.map((section) => [section.key, section.rows.map((row) => row.key)]);
}

function findRow(input: DeveloperModelInput, key: string): MoreRow {
  const row = buildDeveloperModel(input)
    .sections.flatMap((section) => section.rows)
    .find((candidate) => candidate.key === key);
  if (!row) throw new Error(`no row ${key}`);
  return row;
}

describe('buildDeveloperModel', () => {
  it('always gives the dev tools the server-unreachable switch, so the section is never empty', () => {
    expect(layout(makeInput())).toEqual([['development', ['forceServerUnreachable']]]);
  });

  it('lists every tool that applies, in the order they always had', () => {
    const everything = devTools({
      showDevServerSwitcher: true,
      showFeatureFlags: true,
      showOfflineWrites: true,
      showQaPicker: true,
      showOutlineEditor: true,
      showSentryDiagnostics: true,
    });
    expect(layout(makeInput({ devTools: everything }))).toEqual([
      [
        'development',
        [
          'metroServers',
          'featureFlags',
          'offlineWrites',
          'qaPick',
          'outlineEditor',
          'sentryDiagnostics',
          'forceServerUnreachable',
        ],
      ],
    ]);
  });

  it('puts dev metadata first, then the tools, the geometry overlay and the branch switcher', () => {
    const input = makeInput({
      devMetadataSection: {
        key: 'devMetadata',
        rows: [{ kind: 'info', key: 'devBranch', label: 'Branch', body: 'x' }],
      },
      bottomChromeDiagnostics: { enabled: false, onChange: vi.fn() },
      showPreviewBuild: true,
    });
    expect(layout(input).map(([key]) => key)).toEqual(['devMetadata', 'development', 'diagnostics', 'previewBuild']);
  });

  it('shows a pr-preview climber who is not a tester just the geometry overlay', () => {
    expect(
      layout(makeInput({ devTools: null, bottomChromeDiagnostics: { enabled: false, onChange: vi.fn() } })),
    ).toEqual([['diagnostics', ['bottomChromeDiagnostics']]]);
  });

  it('shows a preview build its branch switcher without the tester tools', () => {
    expect(layout(makeInput({ devTools: null, showPreviewBuild: true }))).toEqual([
      ['previewBuild', ['branchSwitcher']],
    ]);
  });

  it('opens each tool at its route', () => {
    const onNavigate = vi.fn();
    const input = makeInput({
      onNavigate,
      devTools: devTools({ showFeatureFlags: true, showQaPicker: true }),
      showPreviewBuild: true,
    });
    for (const key of ['featureFlags', 'qaPick', 'branchSwitcher']) {
      const row = findRow(input, key);
      if (row.kind !== 'nav') throw new Error(`${key} is not a nav row`);
      row.onPress();
    }
    expect(onNavigate.mock.calls.map(([href]) => href)).toEqual([
      '/settings/feature-flags',
      '/qa/pick?prNumbers=1',
      '/settings/branch-switcher',
    ]);
  });

  it('hands both switches to their handlers', () => {
    const forceServerUnreachable = { enabled: true, onChange: vi.fn() };
    const bottomChromeDiagnostics = { enabled: false, onChange: vi.fn() };
    const input = makeInput({ devTools: devTools({ forceServerUnreachable }), bottomChromeDiagnostics });
    const unreachable = findRow(input, 'forceServerUnreachable');
    const overlay = findRow(input, 'bottomChromeDiagnostics');
    if (unreachable.kind !== 'toggle' || overlay.kind !== 'toggle') throw new Error('not toggles');
    expect(unreachable.value).toBe(true);
    unreachable.onValueChange(false);
    overlay.onValueChange(true);
    expect(forceServerUnreachable.onChange).toHaveBeenCalledWith(false);
    expect(bottomChromeDiagnostics.onChange).toHaveBeenCalledWith(true);
  });
});
