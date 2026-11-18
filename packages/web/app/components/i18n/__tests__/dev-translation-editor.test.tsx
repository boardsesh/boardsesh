import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider, useTranslation } from 'react-i18next';
import catalog from '@boardsesh/i18n/locales/en-US/devTools.json';
import DevTranslationEditor from '../dev-translation-editor';

const entries = [
  { namespace: 'marketing', key: 'hello', text: 'Hello {{name}}' },
  { namespace: 'common', key: 'hello', text: 'Hello Sarah' },
  { namespace: 'marketing', key: 'start', text: 'Start climbing' },
  { namespace: 'settings', key: 'title', text: 'Settings title' },
  { namespace: 'devTools', key: 'save', text: 'Save' },
];
const fetchMock = vi.fn();
const routing = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => routing }));

function ClientTranslation() {
  const { t } = useTranslation('marketing');
  return <p data-testid="client-copy">{t('start')}</p>;
}

async function mountEditor(devToolsCatalog = catalog) {
  const instance = createInstance();
  await instance.init({
    lng: 'en-US',
    resources: { 'en-US': { devTools: devToolsCatalog, marketing: { start: 'Start climbing' } } },
    interpolation: { escapeValue: false },
  });
  render(
    <I18nextProvider i18n={instance}>
      <a href="/start" data-testid="page-link">
        <strong>Start</strong> climbing
      </a>
      <p>Hello Sarah</p>
      <ClientTranslation />
      <DevTranslationEditor locale="en-US" />
    </I18nextProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Edit translations' }));
  await screen.findByRole('button', { name: 'Search strings' });
  return instance;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ entries })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('development translation editor', () => {
  it('refreshes editor labels cached by an already-open development tab', async () => {
    await mountEditor({ ...catalog, save: 'Save and reload' });
    fireEvent.click(screen.getByRole('button', { name: 'Search strings' }));
    fireEvent.click(await screen.findByText('marketing:start'));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Save and reload' })).toBeNull();
  });
  it('adds floating controls without changing the inspected markup and intercepts link navigation', async () => {
    await mountEditor();
    const link = screen.getByTestId('page-link');
    const originalMarkup = link.outerHTML;
    fireEvent.pointerOver(screen.getByText('Start'));
    await screen.findByRole('button', { name: 'Edit' });
    expect(link.outerHTML).toBe(originalMarkup);
    expect(fireEvent.click(link)).toBe(false);
    expect(await screen.findByRole('textbox', { name: 'New translation' })).toBeDefined();
    expect(screen.getByText('marketing:start')).toBeDefined();
    expect(link.outerHTML).toBe(originalMarkup);
  });

  it('asks which key to edit when literal and interpolated strings collide', async () => {
    await mountEditor();
    fireEvent.click(screen.getByText('Hello Sarah'));
    expect(await screen.findByText('Several keys use this text. Choose the correct key before editing.')).toBeDefined();
    expect(screen.getByText('common:hello')).toBeDefined();
    expect(screen.getByText('marketing:hello')).toBeDefined();
    expect(screen.queryByRole('textbox', { name: 'New translation' })).toBeNull();
  });

  it('prevents broken placeholder saves and shows stale-write conflicts', async () => {
    await mountEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Search strings' }));
    fireEvent.click(await screen.findByText('marketing:hello'));
    const field = screen.getByRole('textbox', { name: 'New translation' });
    fireEvent.change(field, { target: { value: 'Hello' } });
    expect(((await screen.findByRole('button', { name: 'Save' })) as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.change(field, { target: { value: 'Welcome {{name}}' } });
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 409 }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await screen.findByText(
      'This string changed since you opened it. Load the latest version, compare it with your draft, then save again.',
    );
    const [, options] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(options.body as string)).toEqual({
      locale: 'en-US',
      namespace: 'marketing',
      key: 'hello',
      previous: 'Hello {{name}}',
      replacement: 'Welcome {{name}}',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Back to strings' }));
    expect(screen.queryByRole('button', { name: 'Load latest version' })).toBeNull();
  });

  it('updates client copy, keeps the editor open, and uses the saved baseline for another save', async () => {
    await mountEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Search strings' }));
    fireEvent.click(await screen.findByText('marketing:start'));
    const field = screen.getByRole('textbox', { name: 'New translation' });
    fetchMock.mockResolvedValueOnce(new Response('{}'));
    fireEvent.change(field, { target: { value: 'Climb together' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await screen.findByText('Saved. The page updates in place.');
    expect(screen.getByTestId('client-copy').textContent).toBe('Climb together');
    expect((screen.getByRole('textbox', { name: 'Current translation' }) as HTMLTextAreaElement).value).toBe(
      'Climb together',
    );
    expect(screen.getByRole('dialog')).toBeDefined();
    expect(routing.refresh).toHaveBeenCalledTimes(1);
    expect(((await screen.findByRole('button', { name: 'Save' })) as HTMLButtonElement).disabled).toBe(true);

    fetchMock.mockResolvedValueOnce(new Response('{}'));
    fireEvent.change(field, { target: { value: 'Climb with friends' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await screen.findByText('Saved. The page updates in place.');
    const [, options] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(JSON.parse(options.body as string)).toMatchObject({
      previous: 'Climb together',
      replacement: 'Climb with friends',
    });
    expect(screen.getByTestId('client-copy').textContent).toBe('Climb with friends');
    expect(routing.refresh).toHaveBeenCalledTimes(2);
    await screen.findByRole('button', { name: 'Save' });
    fireEvent.click(screen.getByRole('button', { name: 'Back to strings' }));
    expect(within(screen.getByRole('dialog')).getByText('Climb with friends')).toBeDefined();
  });

  it('loads a conflict baseline without losing the draft and permits a deliberate retry', async () => {
    await mountEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Search strings' }));
    fireEvent.click(await screen.findByText('marketing:hello'));
    const field = screen.getByRole('textbox', { name: 'New translation' });
    fireEvent.change(field, { target: { value: 'Welcome {{name}}' } });
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 409 }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await screen.findByRole('button', { name: 'Load latest version' });
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          entries: entries.map((entry) =>
            entry.key === 'hello' && entry.namespace === 'marketing' ? { ...entry, text: 'Hi {{name}}' } : entry,
          ),
        }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Load latest version' }));
    await waitFor(() =>
      expect((screen.getByRole('textbox', { name: 'Current translation' }) as HTMLTextAreaElement).value).toBe(
        'Hi {{name}}',
      ),
    );
    expect((field as HTMLTextAreaElement).value).toBe('Welcome {{name}}');
    fetchMock.mockResolvedValueOnce(new Response('{}'));
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await screen.findByText('Saved. The page updates in place.');
    const [, options] = fetchMock.mock.calls[3] as [string, RequestInit];
    expect(JSON.parse(options.body as string)).toMatchObject({
      previous: 'Hi {{name}}',
      replacement: 'Welcome {{name}}',
    });
  });

  it('keeps off-page namespaces unloaded so navigation can install their full catalog', async () => {
    const instance = await mountEditor();
    expect(instance.hasResourceBundle('en-US', 'settings')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Search strings' }));
    fireEvent.click(await screen.findByText('settings:title'));
    fetchMock.mockResolvedValueOnce(new Response('{}'));
    fireEvent.change(screen.getByRole('textbox', { name: 'New translation' }), { target: { value: 'Your settings' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await screen.findByText('Saved. The page updates in place.');
    expect(instance.hasResourceBundle('en-US', 'settings')).toBe(false);
    // A later route can still load the complete namespace.
    instance.addResourceBundle('en-US', 'settings', { title: 'Your settings', subtitle: 'Preferences' }, true, true);
    expect(instance.t('settings:subtitle')).toBe('Preferences');
  });

  it('stops inspection on Escape', async () => {
    await mountEditor();
    fireEvent.pointerOver(screen.getByTestId('page-link'));
    await screen.findByRole('button', { name: 'Edit' });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull());
    expect(screen.getByRole('button', { name: 'Edit translations' })).toBeDefined();
  });
});
