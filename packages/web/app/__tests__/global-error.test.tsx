import React from 'react';
import { render, cleanup } from '@testing-library/react';
import { describe, expect, it, vi, afterEach } from 'vite-plus/test';

const { captureException } = vi.hoisted(() => ({
  captureException: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => captureException(...args),
}));

import GlobalError from '../global-error';

function renderAt(pathname: string) {
  // jsdom's location is read-only; pushState mutates pathname for real.
  window.history.pushState({}, '', pathname);
  return render(<GlobalError error={new Error('boom')} reset={() => {}} />);
}

afterEach(() => {
  cleanup();
  captureException.mockClear();
  window.history.pushState({}, '', '/');
});

describe('GlobalError detectLocale', () => {
  it('renders English copy on the root path', () => {
    const { container } = renderAt('/');
    expect(container.textContent).toContain('Something went wrong');
    expect(container.textContent).toContain('Try reloading to get back on track');
    expect(container.textContent).toContain('Reload app');
  });

  it('renders English copy on an unprefixed path', () => {
    const { container } = renderAt('/about');
    expect(container.textContent).toContain('Something went wrong');
  });

  it('renders Spanish copy on /es', () => {
    const { container } = renderAt('/es');
    expect(container.textContent).toContain('Algo salió mal');
    expect(container.textContent).toContain('Recarga para volver a la pared');
    expect(container.textContent).toContain('Recargar');
  });

  it('renders Spanish copy on /es/<path>', () => {
    const { container } = renderAt('/es/help/foo');
    expect(container.textContent).toContain('Algo salió mal');
  });

  it('renders French copy on /fr', () => {
    const { container } = renderAt('/fr');
    expect(container.textContent).toContain("Quelque chose s'est mal passé");
    expect(container.textContent).toContain('Essayez de recharger pour repartir du bon pied');
    expect(container.textContent).toContain("Recharger l'app");
  });

  it('renders French copy on /fr/<path>', () => {
    const { container } = renderAt('/fr/help/foo');
    expect(container.textContent).toContain("Quelque chose s'est mal passé");
  });

  it('does not match paths that merely start with the locale string (/espoo)', () => {
    const { container } = renderAt('/espoo');
    expect(container.textContent).toContain('Something went wrong');
    expect(container.textContent).not.toContain('Algo salió mal');
  });

  it('does not match paths that merely start with /fr (/fragile)', () => {
    const { container } = renderAt('/fragile');
    expect(container.textContent).toContain('Something went wrong');
    expect(container.textContent).not.toContain("Quelque chose s'est mal passé");
  });

  it('reports the error to Sentry on mount', () => {
    const error = new Error('upstream failure');
    render(<GlobalError error={error} reset={() => {}} />);
    expect(captureException).toHaveBeenCalledWith(error);
  });
});
