// @vitest-environment jsdom
vi.mock('../../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../../PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// #5960: the wall name field must not autocorrect, and "Use my location" must
// say something when location is denied or no fix comes back.

type InputMockProps = { accessibilityLabel?: string; autoCorrect?: boolean; spellCheck?: boolean };
vi.mock('react-native', () => ({
  TextInput: ({ accessibilityLabel, autoCorrect, spellCheck }: InputMockProps) =>
    createElement('input', {
      'aria-label': accessibilityLabel,
      'data-autocorrect': String(autoCorrect),
      'data-spellcheck': String(spellCheck),
    }),
  Pressable: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1,
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({
    systemColors: { tertiaryLabel: '#888', label: '#fff', separator: '#222', secondaryBackground: '#111' },
    brandColors: { primary: '#6D28D9' },
  }),
}));
vi.mock('../../../theme/tokens', () => ({
  opacity: { disabled: 0.5 },
  spacing: { 1: 4, 2: 8, 3: 12 },
  borderRadius: { lg: 12, md: 8 },
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { systemRed: '#FF3B30' } }));
vi.mock('../../SwitchRow', () => ({
  SwitchRow: ({
    label,
    description,
    value,
    onValueChange,
  }: {
    label: string;
    description?: string;
    value?: boolean;
    onValueChange?: (next: boolean) => void;
  }) =>
    createElement('div', null, [
      createElement('span', { key: 'label' }, label),
      description ? createElement('span', { key: 'description' }, description) : null,
      createElement('button', {
        key: 'toggle',
        'data-testid': `switch-${label}`,
        'data-value': String(!!value),
        onClick: () => onValueChange?.(!value),
      }),
    ]),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, loading }: { title: string; loading?: boolean }) =>
    createElement('button', { 'data-loading': String(!!loading) }, title),
}));
vi.mock('../GymPickerSheet', () => ({}));
vi.mock('../../SegmentedControl', () => ({
  SegmentedControl: ({
    options,
    selectedKey,
    onSelect,
  }: {
    options: { key: string; label: string }[];
    selectedKey: string;
    onSelect: (key: string) => void;
  }) =>
    createElement(
      'div',
      null,
      options.map((option) =>
        createElement(
          'button',
          {
            key: option.key,
            'data-testid': `segment-${option.key}`,
            'data-selected': String(option.key === selectedKey),
            onClick: () => onSelect(option.key),
          },
          option.label,
        ),
      ),
    ),
}));

const location = vi.hoisted(() => ({ status: 'idle' as string }));
vi.mock('../../../lib/use-device-location', () => ({
  useDeviceLocation: () => ({ status: location.status, coords: null, request: vi.fn(), refresh: vi.fn() }),
}));
const settings = vi.hoisted(() => ({ canOpen: true }));
vi.mock('../../../lib/open-app-settings', () => ({
  canOpenAppSettings: () => settings.canOpen,
  openAppSettings: vi.fn(),
}));

import {
  BoardIdentityFields,
  BoardVisibilityFields,
  SprayTrainingConsentField,
  SprayWallVisibilityField,
} from '../BoardMetaFields';

const visibilityBuilder = {
  isPublic: false,
  setIsPublic: vi.fn(),
  isUnlisted: false,
  setIsUnlisted: vi.fn(),
  hideLocation: false,
  setHideLocation: vi.fn(),
  locationName: '',
  setLocationName: vi.fn(),
  coords: null,
  setCoords: vi.fn(),
};

beforeEach(() => {
  location.status = 'idle';
  settings.canOpen = true;
});

describe('BoardIdentityFields name input', () => {
  it('turns autocorrect and spell-check off', () => {
    const { getByLabelText } = render(
      <BoardIdentityFields
        builder={{ name: '', setName: vi.fn(), selectedGym: null }}
        namePlaceholder="Garage wall"
        onOpenGymPicker={vi.fn()}
      />,
    );
    const input = getByLabelText('mobile.custom.name');
    expect(input.getAttribute('data-autocorrect')).toBe('false');
    expect(input.getAttribute('data-spellcheck')).toBe('false');
  });
});

describe('BoardVisibilityFields location feedback', () => {
  it('says nothing before the tap', () => {
    const { queryByText } = render(<BoardVisibilityFields builder={visibilityBuilder} />);
    expect(queryByText('mobile.create.locationDeniedHint')).toBeNull();
    expect(queryByText('mobile.create.locationUnavailableHint')).toBeNull();
  });

  it('shows a spinner on the button while it looks', () => {
    location.status = 'loading';
    const { getByText } = render(<BoardVisibilityFields builder={visibilityBuilder} />);
    expect(getByText('mobile.create.useMyLocation').getAttribute('data-loading')).toBe('true');
  });

  it('explains a denial and offers Settings', () => {
    location.status = 'denied';
    const { getByText } = render(<BoardVisibilityFields builder={visibilityBuilder} />);
    expect(getByText('mobile.create.locationDeniedHint')).toBeTruthy();
    expect(getByText('mobile.firstBoard.openSettings')).toBeTruthy();
  });

  it('explains a failed fix without a Settings button', () => {
    location.status = 'unavailable';
    const { getByText, queryByText } = render(<BoardVisibilityFields builder={visibilityBuilder} />);
    expect(getByText('mobile.create.locationUnavailableHint')).toBeTruthy();
    expect(queryByText('mobile.firstBoard.openSettings')).toBeNull();
  });
});

// #5960: the wizard drew two switches, so Public and Unlisted could both be on.
describe('SprayWallVisibilityField', () => {
  function renderField(flags: { isPublic: boolean; isUnlisted: boolean }) {
    const builder = { ...flags, setIsPublic: vi.fn(), setIsUnlisted: vi.fn() };
    return { ...render(<SprayWallVisibilityField builder={builder} />), builder };
  }

  it('writes the two flags exclusively', () => {
    const { getByTestId, builder } = renderField({ isPublic: true, isUnlisted: false });
    fireEvent.click(getByTestId('segment-unlisted'));
    expect(builder.setIsPublic).toHaveBeenLastCalledWith(false);
    expect(builder.setIsUnlisted).toHaveBeenLastCalledWith(true);

    fireEvent.click(getByTestId('segment-public'));
    expect(builder.setIsPublic).toHaveBeenLastCalledWith(true);
    expect(builder.setIsUnlisted).toHaveBeenLastCalledWith(false);
  });

  it('explains Link only', () => {
    const { getByText } = renderField({ isPublic: false, isUnlisted: true });
    expect(getByText('mobile.sprayVisibility.unlistedHint')).toBeTruthy();
  });

  it('reads both flags on as Public', () => {
    const { getByTestId } = renderField({ isPublic: true, isUnlisted: true });
    expect(getByTestId('segment-public').getAttribute('data-selected')).toBe('true');
  });
});

describe('BoardVisibilityFields switches', () => {
  it('leaves out the Public and Unlisted switches when asked', () => {
    const { queryByText } = render(<BoardVisibilityFields builder={visibilityBuilder} hideVisibilitySwitches />);
    expect(queryByText('mobile.create.public')).toBeNull();
    expect(queryByText('mobile.create.unlisted')).toBeNull();
  });
});

describe('SprayTrainingConsentField', () => {
  it('says what the switch does and hands back the flip', () => {
    const onValueChange = vi.fn();
    const { getByText, getByTestId, queryByText } = render(
      <SprayTrainingConsentField value onValueChange={onValueChange} />,
    );
    expect(getByText('mobile.sprayTraining.description')).toBeTruthy();
    const toggle = getByTestId('switch-mobile.sprayTraining.label');
    expect(toggle.getAttribute('data-value')).toBe('true');
    fireEvent.click(toggle);
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(queryByText('mobile.sprayTraining.updateError')).toBeNull();
  });

  it('shows a refusal inline', () => {
    const { getByText } = render(
      <SprayTrainingConsentField
        value={false}
        onValueChange={() => {}}
        errorMessage="mobile.sprayTraining.updateError"
      />,
    );
    expect(getByText('mobile.sprayTraining.updateError')).toBeTruthy();
  });
});
