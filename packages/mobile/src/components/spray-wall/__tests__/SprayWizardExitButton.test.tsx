// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const navigation = vi.hoisted(() => ({ canGoBack: vi.fn(), back: vi.fn(), dismissTo: vi.fn() }));
vi.mock('expo-router', () => ({ useRouter: () => navigation }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../HeaderActionButtons', () => ({
  HeaderLeadingButton: ({
    kind,
    onPress,
    accessibilityLabel,
  }: {
    kind: string;
    onPress: () => void;
    accessibilityLabel: string;
  }) => createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel, 'data-kind': kind }),
}));
import { SprayWizardExitButton } from '../SprayWizardExitButton';
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);
describe('wizard header exit', () => {
  it('provides an accessible cold-link exit to the resolved source tab', () => {
    navigation.canGoBack.mockReturnValue(false);
    const { getByRole } = render(<SprayWizardExitButton returnTo="/(tabs)/discover" />);
    // The shared header X, so it matches every other native-header close.
    expect(getByRole('button', { name: 'ariaLabels.close' }).getAttribute('data-kind')).toBe('close');
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
