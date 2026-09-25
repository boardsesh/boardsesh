// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const recovery = vi.hoisted(() => ({
  recoverFromChunkLoadError: vi.fn(),
  reloadPage: vi.fn(),
}));

vi.mock('../../lib/chunk-load-recovery', () => recovery);

vi.mock('react-native', () => ({
  Platform: { OS: 'web' },
  PlatformColor: (colorName: string) => colorName,
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel, type: 'button' }, children),
}));
vi.mock('../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }),
}));

import { ChunkLoadErrorScreen } from '../ChunkLoadErrorScreen';

const chunkError = Object.assign(new Error('Loading module https://app.boardsesh.com/index-1.js failed.'), {
  name: 'AsyncRequireError',
});

async function renderSettled(outcome: 'reloading' | 'offline' | 'unreachable' | 'exhausted') {
  recovery.recoverFromChunkLoadError.mockResolvedValue(outcome);
  const view = render(createElement(ChunkLoadErrorScreen, { error: chunkError }));
  await act(async () => {});
  return view;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ChunkLoadErrorScreen', () => {
  it('says what is happening while it works out whether to reload', () => {
    recovery.recoverFromChunkLoadError.mockReturnValue(new Promise(() => {}));
    render(createElement(ChunkLoadErrorScreen, { error: chunkError }));
    expect(screen.getByText('Loading the latest Boardsesh')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(recovery.recoverFromChunkLoadError).toHaveBeenCalledWith(chunkError);
  });

  it('shows no buttons while the page reloads itself', async () => {
    await renderSettled('reloading');
    expect(screen.getByText('Boardsesh just updated')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers Reload, not Try again or Go home, when offline', async () => {
    await renderSettled('offline');
    expect(screen.getByText("You're offline")).toBeTruthy();
    expect(screen.queryByText('Try again')).toBeNull();
    expect(screen.queryByText('Go home')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(recovery.reloadPage).toHaveBeenCalledTimes(1);
  });

  it("says it couldn't reach Boardsesh, not that you're offline, when the origin did not answer", async () => {
    await renderSettled('unreachable');
    expect(screen.getByText("Couldn't reach Boardsesh")).toBeTruthy();
    expect(screen.getByText('Check your connection, then reload.')).toBeTruthy();
    expect(screen.queryByText("You're offline")).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(recovery.reloadPage).toHaveBeenCalledTimes(1);
  });

  it('offers Reload when its one automatic reload is spent', async () => {
    await renderSettled('exhausted');
    expect(screen.getByText("This screen didn't load")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  });

  it('falls back to the Reload button if recovery itself throws', async () => {
    recovery.recoverFromChunkLoadError.mockRejectedValue(new Error('probe blew up'));
    render(createElement(ChunkLoadErrorScreen, { error: chunkError }));
    await act(async () => {});
    expect(screen.getByText("This screen didn't load")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  });

  it('recovers once per error across re-renders', async () => {
    const view = await renderSettled('exhausted');
    view.rerender(createElement(ChunkLoadErrorScreen, { error: chunkError }));
    await act(async () => {});
    expect(recovery.recoverFromChunkLoadError).toHaveBeenCalledTimes(1);
  });
});

describe('root ErrorBoundary wiring', () => {
  // Rendering app/_layout.tsx pulls in every provider; the branch is one line,
  // so pin it at the source instead.
  const layoutSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../app/_layout.tsx'), 'utf8');

  it('sends chunk failures to ChunkLoadErrorScreen before the generic crash screen', () => {
    const boundary = layoutSource.slice(layoutSource.indexOf('export function ErrorBoundary('));
    const body = boundary.slice(0, boundary.indexOf('\n}\n'));
    expect(body).toMatch(/if \(isChunkLoadError\(error\)\) return <ChunkLoadErrorScreen error=\{error\} \/>;/);
    expect(body).toMatch(/return <CrashScreen error=\{error\} retry=\{retry\} \/>;/);
  });
});
