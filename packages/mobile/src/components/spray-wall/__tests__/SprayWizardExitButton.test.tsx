// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const navigation = vi.hoisted(() => ({ canGoBack: vi.fn(), back: vi.fn(), dismissTo: vi.fn() }));
vi.mock('expo-router', () => ({ useRouter: () => navigation }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native', () => ({
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children: ReactNode;
    onPress: () => void;
    accessibilityLabel: string;
  }) => createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
import { SprayWizardExitButton } from '../SprayWizardExitButton';
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);
describe('wizard header exit', () => {
  it('provides an accessible cold-link exit to the resolved source tab', () => {
    navigation.canGoBack.mockReturnValue(false);
    const { getByRole } = render(<SprayWizardExitButton returnTo="/(tabs)/discover" />);
    fireEvent.click(getByRole('button', { name: 'ariaLabels.close' }));
    expect(navigation.dismissTo).toHaveBeenCalledExactlyOnceWith('/(tabs)/discover');
    expect(navigation.back).not.toHaveBeenCalled();
  });
  it('uses the existing route history when the flow was opened normally', () => {
    navigation.canGoBack.mockReturnValue(true);
    const { getByRole } = render(<SprayWizardExitButton returnTo="/(tabs)/climbs" />);
    fireEvent.click(getByRole('button', { name: 'ariaLabels.close' }));
    expect(navigation.back).toHaveBeenCalledOnce();
    expect(navigation.dismissTo).not.toHaveBeenCalled();
  });
});
