// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const cfg = vi.hoisted(() => ({ isTablet: true, push: vi.fn() }));

vi.mock('react-native', () => ({
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('expo-router', () => ({ router: { push: cfg.push } }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 2: 8, 3: 12, 4: 16 } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../hooks/use-device-layout', () => ({ useDeviceLayout: () => ({ isTablet: cfg.isTablet }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryLabel: '#666' } }),
}));

import { WallDisplayEntry } from '../WallDisplayEntry';

describe('WallDisplayEntry', () => {
  beforeEach(() => {
    cfg.isTablet = true;
    cfg.push.mockReset();
  });

  it('leaves the phone board sheet as it was', () => {
    cfg.isTablet = false;
    const { container } = render(<WallDisplayEntry onBeforeNavigate={vi.fn()} />);
    expect(container.textContent).toBe('');
  });

  it('closes the sheet, then opens the Wall display', async () => {
    const onBeforeNavigate = vi.fn().mockResolvedValue(true);
    const { getByRole, getByText } = render(<WallDisplayEntry onBeforeNavigate={onBeforeNavigate} />);
    expect(getByText('mobile.boardPresence.wallDisplay.openHint')).toBeTruthy();

    fireEvent.click(getByRole('button', { name: 'mobile.boardPresence.wallDisplay.open' }));

    expect(onBeforeNavigate).toHaveBeenCalledOnce();
    await waitFor(() => expect(cfg.push).toHaveBeenCalledWith('/wall-display'));
  });

  it('stays put when the sheet hand-off was abandoned', async () => {
    const onBeforeNavigate = vi.fn().mockResolvedValue(false);
    const { getByRole } = render(<WallDisplayEntry onBeforeNavigate={onBeforeNavigate} />);

    fireEvent.click(getByRole('button', { name: 'mobile.boardPresence.wallDisplay.open' }));

    await waitFor(() => expect(onBeforeNavigate).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(cfg.push).not.toHaveBeenCalled();
  });
});
