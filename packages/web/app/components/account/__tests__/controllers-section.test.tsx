/**
 * ESP32 controllers is the reason `/settings` survives the web reposition —
 * Web Bluetooth/serial hardware with no SPA twin, pinned by shipped devices
 * that point at `www.boardsesh.com`. Before W-21 (#4440) it had no render
 * coverage anywhere in the repo, so a refactor could break the register/remove
 * flow with every gate green.
 *
 * These cover the four things the surface promises: the empty state, the list,
 * registering (which is the only place the API key is ever shown), and removing.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import type { ControllerInfo } from '@/app/api/internal/controllers/route';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ i18nKey }: { i18nKey?: string }) => i18nKey ?? null,
}));

vi.mock('server-only', () => ({}));

const mockShowMessage = vi.fn();
vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: mockShowMessage }),
}));

import ControllersSection from '../controllers-section';

const t = (key: string, options?: Record<string, unknown>) => tFromCatalog('settings', key, options);

function makeController(overrides: Partial<ControllerInfo> = {}): ControllerInfo {
  return {
    id: 'ctrl-1',
    name: 'Garage Kilter',
    boardName: 'kilter',
    layoutId: 8,
    sizeId: 17,
    setIds: '26,27',
    isOnline: true,
    lastSeen: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

let mockFetch: ReturnType<typeof vi.fn>;

/** Answers the mount-time GET, then hands later calls to `then`. */
function respondWith(controllers: ControllerInfo[], then?: (input: RequestInfo, init?: RequestInit) => unknown) {
  mockFetch = vi.fn((input: RequestInfo, init?: RequestInit) => {
    if (!init || init.method === undefined) {
      return Promise.resolve({ ok: true, json: async () => ({ controllers }) });
    }
    return Promise.resolve(then?.(input, init));
  });
  global.fetch = mockFetch as unknown as typeof fetch;
}

const postCalls = () => mockFetch.mock.calls.filter(([, init]) => init?.method === 'POST');

/** MUI `Select` is a popover, not a `<select>`: open it, then click an option. */
async function openSelect(index: number): Promise<HTMLElement[]> {
  const comboboxes = Array.from(document.querySelectorAll('[role="combobox"]'));
  fireEvent.mouseDown(comboboxes[index]);
  return await screen.findAllByRole('option');
}

async function chooseOption(index: number, label: string) {
  const options = await openSelect(index);
  const match = options.find((option) => option.textContent === label);
  expect(match).toBeTruthy();
  fireEvent.click(match as HTMLElement);
  await waitFor(() => expect(screen.queryAllByRole('option').length).toBe(0));
}

async function chooseFirstOption(index: number) {
  const options = await openSelect(index);
  fireEvent.click(options[0]);
  await waitFor(() => expect(screen.queryAllByRole('option').length).toBe(0));
}

beforeEach(() => {
  vi.clearAllMocks();
  respondWith([]);
});

describe('ControllersSection', () => {
  it('shows the empty state when nothing is registered', async () => {
    render(<ControllersSection />);

    expect(await screen.findByText(t('controllers.empty'))).toBeTruthy();
    expect(screen.getByText(t('controllers.add'))).toBeTruthy();
  });

  it('renders a card per registered controller, with its connection status', async () => {
    respondWith([makeController(), makeController({ id: 'ctrl-2', name: null, isOnline: false, lastSeen: null })]);

    render(<ControllersSection />);

    expect(await screen.findByText('Garage Kilter')).toBeTruthy();
    expect(screen.getByText(t('controllers.card.unnamed'))).toBeTruthy();
    expect(screen.getByText(t('controllers.status.online'))).toBeTruthy();
    // No `lastSeen` at all reads as never connected, not as offline.
    expect(screen.getByText(t('controllers.status.neverConnected'))).toBeTruthy();
    expect(screen.queryByText(t('controllers.empty'))).toBeNull();
  });

  it('opens the register dialog from the add button', async () => {
    render(<ControllersSection />);

    fireEvent.click(await screen.findByText(t('controllers.add')));

    expect(await screen.findByText(t('controllers.register.title'))).toBeTruthy();
    expect(screen.getByText(t('controllers.register.boardLabel'))).toBeTruthy();
  });

  it('refuses to register until a board, layout, size and hold sets are chosen', async () => {
    render(<ControllersSection />);
    fireEvent.click(await screen.findByText(t('controllers.add')));
    await screen.findByText(t('controllers.register.title'));

    fireEvent.submit(document.querySelector('form') as HTMLFormElement);

    // A half-filled registration would mint an API key against a board tuple the
    // ESP32 can never match, so the handler bails before it POSTs.
    await waitFor(() => {
      expect(postCalls().length).toBe(0);
    });
  });

  it('registers a controller and surfaces the API key exactly once', async () => {
    respondWith([], () => ({ ok: true, json: async () => ({ apiKey: 'esp32-secret-key' }) }));

    render(<ControllersSection />);
    fireEvent.click(await screen.findByText(t('controllers.add')));
    await screen.findByText(t('controllers.register.title'));

    fireEvent.change(screen.getByPlaceholderText(t('controllers.register.namePlaceholder')), {
      target: { value: 'Garage Kilter' },
    });
    // Board first: layout, size and hold sets each cascade off the one above it.
    await chooseOption(0, 'Kilter');
    await chooseFirstOption(1);
    await chooseFirstOption(2);

    fireEvent.submit(document.querySelector('form') as HTMLFormElement);

    await waitFor(() => {
      expect(postCalls().length).toBe(1);
    });
    const posted = JSON.parse(postCalls()[0][1].body);
    expect(posted.name).toBe('Garage Kilter');
    expect(posted.boardName).toBe('kilter');
    expect(typeof posted.layoutId).toBe('number');
    expect(typeof posted.sizeId).toBe('number');
    // Selecting a size auto-selects every hold set, serialised the way the
    // controllers route parses it.
    expect(posted.setIds).toMatch(/^\d+(,\d+)*$/);

    // The key is shown once and never fetched again — this modal is the only
    // place it exists in the UI.
    expect(await screen.findByText(t('controllers.apiKey.title'))).toBeTruthy();
    expect(screen.getByDisplayValue('esp32-secret-key')).toBeTruthy();
  });

  it('deletes a controller through the confirmation popover', async () => {
    respondWith([makeController()], () => ({ ok: true, json: async () => ({ success: true }) }));

    render(<ControllersSection />);
    fireEvent.click(await screen.findByText(t('controllers.card.delete')));
    fireEvent.click(await screen.findByText(t('controllers.card.deleteConfirm.ok')));

    await waitFor(() => {
      const deleteCalls = mockFetch.mock.calls.filter(([, init]) => init?.method === 'DELETE');
      expect(deleteCalls.length).toBe(1);
      expect(JSON.parse(deleteCalls[0][1].body)).toEqual({ controllerId: 'ctrl-1' });
    });
    await waitFor(() => {
      expect(mockShowMessage).toHaveBeenCalledWith(t('controllers.deleteSuccess'), 'success');
    });
  });

  it('surfaces the server message when a delete fails', async () => {
    respondWith([makeController()], () => ({ ok: false, json: async () => ({ error: 'Controller is in use' }) }));

    render(<ControllersSection />);
    fireEvent.click(await screen.findByText(t('controllers.card.delete')));
    fireEvent.click(await screen.findByText(t('controllers.card.deleteConfirm.ok')));

    await waitFor(() => {
      expect(mockShowMessage).toHaveBeenCalledWith('Controller is in use', 'error');
    });
  });
});
