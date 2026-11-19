import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import catalog from '@boardsesh/i18n/locales/en-US/devTools.json';
import DevTranslationEditor from '../dev-translation-editor';

const entries = [
  { namespace: 'marketing', key: 'hello', text: 'Hello {{name}}' },
  { namespace: 'common', key: 'hello', text: 'Hello Sarah' },
  { namespace: 'marketing', key: 'start', text: 'Start climbing' },
];
const fetchMock = vi.fn();

async function mountEditor() {
  const instance = createInstance();
  await instance.init({
    lng: 'en-US',
    resources: { 'en-US': { devTools: catalog } },
    interpolation: { escapeValue: false },
  });
  render(
    <I18nextProvider i18n={instance}>
      <a href="/start" data-testid="page-link">
        <strong>Start</strong> climbing
      </a>
      <p>Hello Sarah</p>
      <DevTranslationEditor locale="en-US" />
    </I18nextProvider>,
  );
  const enableButton = await screen.findByRole('button', { name: 'Edit translations' });
  await act(async () => {
    fireEvent.click(enableButton);
  });
  await screen.findByRole('button', { name: 'Search strings' });
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ entries })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('development translation editor', () => {
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
    expect((screen.getByRole('button', { name: 'Save and reload' }) as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.change(field, { target: { value: 'Welcome {{name}}' } });
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 409 }));
    fireEvent.click(screen.getByRole('button', { name: 'Save and reload' }));
    await screen.findByText(
      'This string changed since you opened it. Reload to load the latest version before editing again.',
    );
    const [, options] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(options.body as string)).toEqual({
      locale: 'en-US',
      namespace: 'marketing',
      key: 'hello',
      previous: 'Hello {{name}}',
      replacement: 'Welcome {{name}}',
    });
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
