// @vitest-environment jsdom
import { createElement, StrictMode, useEffect, type ReactNode } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SprayHoldPersistence } from '../use-spray-hold-autosave';
vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 4: 16, 6: 24 } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: { background: '#000' } }) }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', {}, children),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));
import { SprayHoldEditorLeaseBoundary } from '../SprayHoldEditorLeaseBoundary';
function Probe({
  name,
  onReady,
  retire,
}: {
  name: string;
  onReady: (persistence: SprayHoldPersistence | null) => void;
  retire: () => Promise<void>;
}) {
  useEffect(() => {
    onReady({ flush: async () => undefined, retire });
    return () => onReady(null);
  }, [onReady, retire]);
  return <span>{name}</span>;
}
const retired = async () => undefined;
function Editor({ name, retire = retired }: { name: string; retire?: () => Promise<void> }) {
  return (
    <SprayHoldEditorLeaseBoundary storageKey="setter:wall:17">
      {(onReady) => <Probe name={name} onReady={onReady} retire={retire} />}
    </SprayHoldEditorLeaseBoundary>
  );
}
afterEach(cleanup);
describe('exclusive editor lifecycle', () => {
  it('keeps a second editor blocked until the first final drain completes', async () => {
    let finishDrain: (() => void) | undefined;
    const drain = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDrain = resolve;
        }),
    );
    const first = render(<Editor name="first" retire={drain} />);
    await screen.findByText('first');
    render(<Editor name="second" />);
    expect(screen.queryByText('second')).toBeNull();
    first.unmount();
    expect(drain).toHaveBeenCalledTimes(1);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText('second')).toBeNull();
    await act(async () => finishDrain?.());
    await screen.findByText('second');
  });
  it('releases after a failed involuntary drain and handles StrictMode acquisition cleanup', async () => {
    const first = render(
      <StrictMode>
        <Editor
          name="first"
          retire={async () => {
            throw new Error('storage locked');
          }}
        />
      </StrictMode>,
    );
    await screen.findByText('first');
    render(<Editor name="next" />);
    first.unmount();
    await screen.findByText('next');
  });
  it('cancels a waiting editor without later mounting its session', async () => {
    const first = render(<Editor name="owner" />);
    await screen.findByText('owner');
    const waiter = render(<Editor name="cancelled" />);
    waiter.unmount();
    render(<Editor name="successor" />);
    first.unmount();
    await waitFor(() => expect(screen.queryByText('successor')).not.toBeNull());
    expect(screen.queryByText('cancelled')).toBeNull();
  });
});
