// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor, within, type RenderResult } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  MoonBoardCollectionImportInput,
  MoonBoardCollectionImportResult,
  MoonBoardCollectionPreview,
  MoonBoardCollectionPreviewInput,
} from '@boardsesh/shared-schema';
import type { MoonBoardCsvParseOptions } from '@boardsesh/shared-schema/moonboard-import';
import { MoonBoardCsvConfiguration } from '../MoonBoardCsvConfiguration';

const mocks = vi.hoisted(() => ({
  preview: vi.fn<(input: MoonBoardCollectionPreviewInput) => Promise<MoonBoardCollectionPreview>>(),
  importCollection: vi.fn<(input: MoonBoardCollectionImportInput) => Promise<MoonBoardCollectionImportResult>>(),
  request: vi.fn(),
  clipboard: vi.fn<(text: string) => Promise<void>>(),
  randomUUID: vi.fn(() => '77777777-7777-4777-8777-777777777777'),
  invalidate: vi.fn(),
  onParsed: vi.fn(),
  onClose: vi.fn(),
  onBusyChange: vi.fn(),
}));

vi.mock('expo-crypto', () => ({ randomUUID: mocks.randomUUID }));
vi.mock('expo-clipboard', () => ({ setStringAsync: mocks.clipboard }));
vi.mock('../../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: mocks.request }) }));
vi.mock('../../../lib/integrations/moonboard-collection', () => ({
  previewMoonBoardCollection: mocks.preview,
  importMoonBoardCollection: mocks.importCollection,
}));
vi.mock('../../../lib/integrations/board-import-completion', () => ({
  invalidateOwnDataAfterImport: mocks.invalidate,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number; message?: string }) =>
      options?.count != null ? `${key}:${options.count}` : options?.message ? `${key}:${options.message}` : key,
  }),
}));
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
  ActivityIndicator: () => createElement('div', { role: 'progressbar' }),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryLabel: '#888' }, brandColors: { error: '#c00' } }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { md: 16 } }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', {}, children),
}));
vi.mock('../../ModalSheet', () => ({
  ModalSheet: ({ header, children }: { header?: ReactNode; children?: ReactNode }) =>
    createElement('section', {}, header, children),
}));

type Action = { label: string; selected?: boolean; disabled?: boolean };
vi.mock('../../AppMenu', () => ({
  AppMenu: ({
    label,
    accessibilityLabel,
    actions,
    onSelectIndex,
  }: {
    label: string;
    accessibilityLabel?: string;
    actions: Action[];
    onSelectIndex: (index: number) => void;
  }) =>
    createElement(
      'select',
      {
        'aria-label': accessibilityLabel ?? label,
        value: actions.findIndex((action) => action.selected),
        onChange: (event: { target: { value: string } }) => onSelectIndex(Number(event.target.value)),
      },
      createElement('option', { value: -1, disabled: true }, label),
      ...actions.map((action, index) =>
        createElement('option', { key: index, value: index, disabled: action.disabled }, action.label),
      ),
    ),
}));

vi.mock('../../AccessibleBottomSheetTextInput', () => ({
  AccessibleBottomSheetTextInput: ({
    accessibilityLabel,
    value,
    onChangeText,
    editable,
  }: {
    accessibilityLabel: string;
    value: string;
    onChangeText: (text: string) => void;
    editable?: boolean;
  }) =>
    createElement('input', {
      'aria-label': accessibilityLabel,
      value,
      disabled: editable === false,
      onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
    }),
}));

vi.mock('../../SwitchRow', () => ({
  SwitchRow: ({
    label,
    value,
    disabled,
    onValueChange,
  }: {
    label: string;
    value: boolean;
    disabled?: boolean;
    onValueChange: (checked: boolean) => void;
  }) =>
    createElement('input', {
      type: 'checkbox',
      'aria-label': label,
      checked: value,
      disabled,
      onChange: (event: { target: { checked: boolean } }) => onValueChange(event.target.checked),
    }),
}));

vi.mock('../../Button', () => ({
  Button: ({ title, onPress, disabled }: { title: string; onPress: () => void; disabled?: boolean }) =>
    createElement('button', { disabled, onClick: onPress }, title),
}));

type BarAction = { label?: string; kind?: string; disabled?: boolean; loading?: boolean; onPress: () => void };
vi.mock('../../SheetTopBar', () => ({
  SheetTopBar: ({ title, leading, trailing }: { title: string; leading?: BarAction; trailing?: BarAction }) =>
    createElement(
      'header',
      {},
      title,
      ...[leading, trailing].map((action, index) =>
        action
          ? createElement(
              'button',
              {
                key: index,
                disabled: action.disabled || action.loading,
                onClick: action.onPress,
              },
              action.label ?? `actions.${action.kind}`,
            )
          : null,
      ),
    ),
}));

const key = (suffix: string) => `aurora.moonboard.recovery.${suffix}`;
const COLLECTION_CSV = [
  'Name,Grade,Active,Deleted',
  'Known,6C,TRUE,',
  'Missing,7A,TRUE,',
  'Ambiguous,6B+,TRUE,',
  'Known,6C,TRUE,',
  'Inactive,7B,FALSE,',
  'Deleted,7A,TRUE,14/03/24 10:34',
].join('\n');
const PREVIEW: MoonBoardCollectionPreview = {
  matched: 1,
  missing: 1,
  ambiguous: 1,
  duplicates: 1,
  rows: [
    { lineNumber: 2, name: 'Known', grade: '6C', climbUuid: 'known-climb', status: 'matched' },
    { lineNumber: 3, name: 'Missing', grade: '7A', climbUuid: null, status: 'missing' },
    { lineNumber: 4, name: 'Ambiguous', grade: '6B+', climbUuid: null, status: 'ambiguous' },
    { lineNumber: 5, name: 'Known', grade: '6C', climbUuid: 'known-climb', status: 'duplicate' },
  ],
};
const IMPORT_RESULT: MoonBoardCollectionImportResult = {
  playlistId: '10',
  playlistUuid: '77777777-7777-4777-8777-777777777777',
  imported: 1,
  skipped: 1,
  preview: PREVIEW,
};
const clients: QueryClient[] = [];

function renderForm(csv = COLLECTION_CSV, initialOptions?: MoonBoardCsvParseOptions) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  const view = render(
    <QueryClientProvider client={client}>
      <MoonBoardCsvConfiguration
        csv={csv}
        initialOptions={initialOptions}
        onParsed={mocks.onParsed}
        onClose={mocks.onClose}
        onBusyChange={mocks.onBusyChange}
      />
    </QueryClientProvider>,
  );
  return { ...view, queryClient: client };
}

function selectOption(view: RenderResult, name: string, label: string) {
  const select = view.getByRole('combobox', { name });
  const option = within(select).getByRole('option', { name: label }) as HTMLOptionElement;
  fireEvent.change(select, { target: { value: option.value } });
}

function enableCollectionPreview(view: RenderResult) {
  fireEvent.click(view.getByRole('checkbox', { name: key('confirmClimbRows') }));
  selectOption(view, key('layout'), 'MoonBoard 2016');
}

async function previewCollection(view: RenderResult) {
  enableCollectionPreview(view);
  fireEvent.click(view.getByRole('button', { name: key('previewMatches') }));
  await waitFor(() => expect(view.getByRole('button', { name: `${key('importMatched')}:1` })).toBeTruthy());
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.preview.mockResolvedValue(PREVIEW);
  mocks.importCollection.mockResolvedValue(IMPORT_RESULT);
  mocks.clipboard.mockResolvedValue(undefined);
  mocks.request.mockResolvedValue({ allUserPlaylists: { playlists: [] } });
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});

describe('MoonBoardCsvConfiguration', () => {
  it('explains profile files and offers no import action', () => {
    const view = renderForm('Firstname,Example\nUsername,example-setter\nEmail,example@example.test');

    expect(view.getByText(key('profileUnsupported'))).toBeTruthy();
    expect(view.getByText(key('chooseLogbook'))).toBeTruthy();
    expect(view.queryByRole('button', { name: key('previewMatches') })).toBeNull();
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.importCollection).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole('button', { name: 'actions.close' }));
    expect(mocks.onClose).toHaveBeenCalledOnce();
  });

  it('builds a logbook preview only after unfamiliar columns have been mapped', () => {
    const view = renderForm(
      'Report,October\nRoute title,Difficulty,Outcome,Climbed on\nExample climb,6B+,Flashed,01/01/24',
    );
    const previewButton = () => view.getByRole('button', { name: key('previewMatches') }) as HTMLButtonElement;
    expect(previewButton().disabled).toBe(true);

    fireEvent.change(view.getByLabelText(key('headerRow')), { target: { value: '2' } });
    selectOption(view, key('fields.name'), '1. Route title');
    selectOption(view, key('fields.grade'), '2. Difficulty');
    selectOption(view, key('fields.tries'), '3. Outcome');
    expect(previewButton().disabled).toBe(true);
    selectOption(view, key('fields.date'), '4. Climbed on');
    expect(previewButton().disabled).toBe(false);
    expect(mocks.onParsed).not.toHaveBeenCalled();

    fireEvent.click(previewButton());

    expect(mocks.onParsed).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          user: {},
          logs: [
            {
              lineNumber: 3,
              name: 'Example climb',
              grade: '6B+',
              tries: 'Flashed',
              date: '01/01/24',
              attempts: 0,
              rating: null,
            },
          ],
        },
        preview: expect.objectContaining({ rows: 1, sends: 1, flashes: 1 }),
      }),
      { headerRowIndex: 1, columns: { name: 0, grade: 1, tries: 2, date: 3 } },
    );
    expect(mocks.importCollection).not.toHaveBeenCalled();
  });

  it('requires both a climb-row confirmation and a selected layout', async () => {
    const view = renderForm();
    const previewButton = view.getByRole('button', { name: key('previewMatches') }) as HTMLButtonElement;
    expect(previewButton.disabled).toBe(true);
    expect(mocks.request).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole('checkbox', { name: key('confirmClimbRows') }));
    expect(previewButton.disabled).toBe(true);
    selectOption(view, key('layout'), 'MoonBoard 2016');
    expect(previewButton.disabled).toBe(false);
    await waitFor(() => expect(mocks.request).toHaveBeenCalledOnce());
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.importCollection).not.toHaveBeenCalled();
  });

  it('restores manual mappings when reopening configuration from the preview', () => {
    const options = { headerRowIndex: 1, columns: { name: 0, grade: 1, tries: 2, date: 3 } };
    const view = renderForm(
      'Report,October\nRoute title,Difficulty,Outcome,Climbed on\nExample,6C,Flashed,01/01/24',
      options,
    );

    expect((view.getByLabelText(key('headerRow')) as HTMLInputElement).value).toBe('2');
    expect(
      (view.getByRole('combobox', { name: key('fields.name') }) as HTMLSelectElement).selectedOptions[0].textContent,
    ).toBe('1. Route title');
    expect(
      (view.getByRole('combobox', { name: key('fields.grade') }) as HTMLSelectElement).selectedOptions[0].textContent,
    ).toBe('2. Difficulty');
    const previewButton = view.getByRole('button', { name: key('previewMatches') }) as HTMLButtonElement;
    expect(previewButton.disabled).toBe(false);
    fireEvent.click(previewButton);
    expect(mocks.onParsed).toHaveBeenCalledWith(
      expect.objectContaining({ preview: expect.objectContaining({ rows: 1, flashes: 1 }) }),
      options,
    );
  });

  it('previews filtered source rows at the selected layout and angle before writing', async () => {
    const view = renderForm();
    const invalidateQueries = vi.spyOn(view.queryClient, 'invalidateQueries');
    enableCollectionPreview(view);
    selectOption(view, key('angle'), '25°');
    expect(view.getByText(`${key('excludedRows')}:2`)).toBeTruthy();

    fireEvent.click(view.getByRole('button', { name: key('previewMatches') }));

    await waitFor(() => expect(view.getByText(`${key('matched')}:1`)).toBeTruthy());
    expect(mocks.preview).toHaveBeenCalledWith({
      layoutId: 2,
      angle: 25,
      rows: [
        { lineNumber: 2, name: 'Known', grade: '6C' },
        { lineNumber: 3, name: 'Missing', grade: '7A' },
        { lineNumber: 4, name: 'Ambiguous', grade: '6B+' },
        { lineNumber: 5, name: 'Known', grade: '6C' },
      ],
    });
    expect(view.getByText(`${key('missing')}:1`)).toBeTruthy();
    expect(view.getByText(`${key('ambiguous')}:1`)).toBeTruthy();
    expect(view.getByText(`${key('duplicates')}:1`)).toBeTruthy();
    expect(view.getByText(key('missingNote'))).toBeTruthy();
    expect(mocks.importCollection).not.toHaveBeenCalled();

    fireEvent.change(view.getByLabelText(key('playlistName')), { target: { value: 'Recovered problems' } });
    fireEvent.click(view.getByRole('button', { name: `${key('importMatched')}:1` }));

    await waitFor(() => expect(view.getByText(`${key('collectionComplete')}:1`)).toBeTruthy());
    expect(mocks.importCollection).toHaveBeenCalledWith(
      expect.objectContaining({
        layoutId: 2,
        angle: 25,
        playlistName: 'Recovered problems',
        playlistUuid: IMPORT_RESULT.playlistUuid,
      }),
    );
    expect(mocks.invalidate).toHaveBeenCalledOnce();
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['moonBoardImportDestinations'] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['playlist', IMPORT_RESULT.playlistUuid] });
  });

  it('can include inactive source rows while still excluding deletion records', async () => {
    const view = renderForm();
    enableCollectionPreview(view);
    fireEvent.click(view.getByRole('checkbox', { name: key('includeInactive') }));
    expect(view.getByText(`${key('excludedRows')}:1`)).toBeTruthy();

    fireEvent.click(view.getByRole('button', { name: key('previewMatches') }));

    await waitFor(() => expect(mocks.preview).toHaveBeenCalledOnce());
    expect(mocks.preview.mock.calls[0][0].rows).toHaveLength(5);
    expect(mocks.preview.mock.calls[0][0].rows.at(-1)).toEqual({ lineNumber: 6, name: 'Inactive', grade: '7B' });
    expect(mocks.preview.mock.calls[0][0].rows.some((row) => row.name === 'Deleted')).toBe(false);
  });

  it('offers only compatible private playlists owned by the signed-in user', async () => {
    mocks.request.mockResolvedValue({
      allUserPlaylists: {
        playlists: [
          { id: '10', uuid: 'owned-private', name: 'Owned private', isPublic: false, userRole: 'owner', layoutId: 2 },
          { id: '11', uuid: 'public', name: 'Public playlist', isPublic: true, userRole: 'owner', layoutId: 2 },
          { id: '12', uuid: 'viewer', name: 'Shared read-only', isPublic: false, userRole: 'viewer', layoutId: 2 },
          { id: '13', uuid: 'wrong-layout', name: 'Another layout', isPublic: false, userRole: 'owner', layoutId: 3 },
        ],
      },
    });
    const view = renderForm();
    await previewCollection(view);

    const destinations = view.getByRole('combobox', { name: key('newPlaylist') });
    await waitFor(() => expect(within(destinations).getByRole('option', { name: 'Owned private' })).toBeTruthy());
    expect(within(destinations).queryByRole('option', { name: 'Public playlist' })).toBeNull();
    expect(within(destinations).queryByRole('option', { name: 'Shared read-only' })).toBeNull();
    expect(within(destinations).queryByRole('option', { name: 'Another layout' })).toBeNull();

    selectOption(view, key('newPlaylist'), 'Owned private');
    fireEvent.click(view.getByRole('button', { name: `${key('importMatched')}:1` }));
    await waitFor(() => expect(mocks.importCollection).toHaveBeenCalledOnce());
    expect(mocks.importCollection).toHaveBeenCalledWith(
      expect.objectContaining({
        playlistId: '10',
        playlistUuid: 'owned-private',
        playlistName: 'Owned private',
      }),
    );
  });

  it('retains the new playlist UUID when an import fails and is retried', async () => {
    mocks.importCollection.mockRejectedValueOnce(new Error('connection interrupted'));
    const view = renderForm();
    await previewCollection(view);

    fireEvent.click(view.getByRole('button', { name: `${key('importMatched')}:1` }));
    await waitFor(() => expect(view.getByText(key('failed'))).toBeTruthy());
    expect(mocks.invalidate).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: `${key('importMatched')}:1` }));

    await waitFor(() => expect(view.getByText(`${key('collectionComplete')}:1`)).toBeTruthy());
    expect(mocks.importCollection).toHaveBeenCalledTimes(2);
    expect(mocks.importCollection.mock.calls[1][0].playlistUuid).toBe(
      mocks.importCollection.mock.calls[0][0].playlistUuid,
    );
    expect(mocks.randomUUID).toHaveBeenCalledOnce();
  });

  it('allows retrying a failed preview without writing a collection', async () => {
    mocks.preview.mockRejectedValueOnce(new Error('offline'));
    const view = renderForm();
    enableCollectionPreview(view);

    fireEvent.click(view.getByRole('button', { name: key('previewMatches') }));
    await waitFor(() => expect(view.getByText(key('failed'))).toBeTruthy());
    expect(mocks.importCollection).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: key('previewMatches') }));

    await waitFor(() => expect(view.getByText(`${key('matched')}:1`)).toBeTruthy());
    expect(mocks.preview).toHaveBeenCalledTimes(2);
    expect(mocks.importCollection).not.toHaveBeenCalled();
  });

  it('copies unresolved climb names and grades without treating them as drafts', async () => {
    const view = renderForm();
    await previewCollection(view);

    fireEvent.click(view.getByRole('button', { name: key('copyUnresolved') }));

    await waitFor(() => expect(view.getByRole('button', { name: key('copied') })).toBeTruthy());
    expect(mocks.clipboard).toHaveBeenCalledWith('Missing (7A)\nAmbiguous (6B+)');
    expect(mocks.importCollection).not.toHaveBeenCalled();
  });

  it('blocks duplicate preview requests and cancellation while matching is pending', async () => {
    let resolvePreview: (preview: MoonBoardCollectionPreview) => void = () => {};
    mocks.preview.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePreview = resolve;
        }),
    );
    const view = renderForm();
    enableCollectionPreview(view);

    fireEvent.click(view.getByRole('button', { name: key('previewMatches') }));
    fireEvent.click(view.getByRole('button', { name: key('previewMatches') }));
    fireEvent.click(view.getByRole('button', { name: 'actions.cancel' }));
    expect(mocks.preview).toHaveBeenCalledOnce();
    expect(mocks.onClose).not.toHaveBeenCalled();
    expect(mocks.onBusyChange).toHaveBeenCalledWith(true);

    await act(async () => resolvePreview(PREVIEW));
    await waitFor(() => expect(view.getByRole('button', { name: `${key('importMatched')}:1` })).toBeTruthy());
    expect(mocks.onBusyChange).toHaveBeenLastCalledWith(false);
    fireEvent.click(view.getByRole('button', { name: 'actions.cancel' }));
    expect(mocks.onClose).toHaveBeenCalledOnce();
    expect(mocks.importCollection).not.toHaveBeenCalled();
  });

  it('keeps an empty match result reviewable but disables import', async () => {
    mocks.preview.mockResolvedValue({
      ...PREVIEW,
      matched: 0,
      duplicates: 0,
      missing: 4,
      rows: PREVIEW.rows.map((row) => ({ ...row, status: 'missing', climbUuid: null })),
    });
    const view = renderForm();
    enableCollectionPreview(view);
    fireEvent.click(view.getByRole('button', { name: key('previewMatches') }));

    await waitFor(() => expect(view.getByText(key('noMatches'))).toBeTruthy());
    expect((view.getByRole('button', { name: `${key('importMatched')}:0` }) as HTMLButtonElement).disabled).toBe(true);
    expect(view.getByRole('button', { name: key('copyUnresolved') })).toBeTruthy();
    expect(mocks.importCollection).not.toHaveBeenCalled();
  });

  it('submits one import when confirmation is tapped repeatedly', async () => {
    let finishImport: (result: MoonBoardCollectionImportResult) => void = () => {};
    mocks.importCollection.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishImport = resolve;
        }),
    );
    const view = renderForm();
    await previewCollection(view);

    fireEvent.click(view.getByRole('button', { name: `${key('importMatched')}:1` }));
    fireEvent.click(view.getByRole('button', { name: `${key('importMatched')}:1` }));
    fireEvent.click(view.getByRole('button', { name: 'actions.cancel' }));
    expect(mocks.importCollection).toHaveBeenCalledOnce();
    expect(mocks.onClose).not.toHaveBeenCalled();

    await act(async () => finishImport(IMPORT_RESULT));
    await waitFor(() => expect(view.getByText(`${key('collectionComplete')}:1`)).toBeTruthy());
    fireEvent.click(view.getByRole('button', { name: 'actions.done' }));
    expect(mocks.onClose).toHaveBeenCalledOnce();
  });

  it('blocks oversized collection imports while showing only bounded source samples', () => {
    const csv = ['Name,Grade', ...Array.from({ length: 1001 }, (_, index) => `Problem ${index},6C`)].join('\n');
    const view = renderForm(csv);
    enableCollectionPreview(view);

    expect(view.getByText(key('tooManyRows'))).toBeTruthy();
    expect((view.getByRole('button', { name: key('previewMatches') }) as HTMLButtonElement).disabled).toBe(true);
    expect(view.queryByText('Problem 1000 · 6C')).toBeNull();
    expect(mocks.preview).not.toHaveBeenCalled();
  });
});
