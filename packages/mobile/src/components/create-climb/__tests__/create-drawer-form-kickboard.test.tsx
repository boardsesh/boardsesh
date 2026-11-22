// @vitest-environment jsdom
// Whether partner apps are on, for the draft switch's note (#7387).
const partnerApps = vi.hoisted(() => ({ enabled: false }));
vi.mock('../../../lib/graphql/hooks/use-connected-apps', () => ({ usePartnerAppsEnabled: () => partnerApps.enabled }));
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
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
import { createElement, type ComponentProps, type ReactNode } from 'react';
import type { InsetGroupedListProps } from '../../InsetGroupedList';
import type { SwitchRowProps } from '../../SwitchRow.types';

// #5960: a spray wall has no kickboard, so the create form must not offer the
// "No kickboard" switch there. Every catalogue board keeps it.

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1,
  },
  TextInput: ({
    accessibilityLabel,
    value,
    onChangeText,
    placeholder,
    maxLength,
  }: {
    accessibilityLabel?: string;
    value?: string;
    onChangeText?: (next: string) => void;
    placeholder?: string;
    maxLength?: number;
  }) =>
    createElement('textarea', {
      'aria-label': accessibilityLabel,
      value,
      onChange: (event: { currentTarget: { value: string } }) => onChangeText?.(event.currentTarget.value),
      placeholder,
      maxLength,
    }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({
    textStyles: { callout: {} },
    systemColors: { fill: '#000', label: '#fff', secondaryLabel: '#aaa', tertiaryLabel: '#888' },
  }),
}));
vi.mock('../../../theme/tokens', () => ({
  opacity: { disabled: 0.5 },
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
  cardCorners: { borderRadius: 12, borderCurve: 'continuous' },
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../SwitchRow', () => ({
  SwitchRow: ({ label, description, wrapDescription, value, onValueChange }: SwitchRowProps) =>
    createElement(
      'button',
      {
        type: 'button',
        role: 'switch',
        'aria-checked': value,
        'data-testid': 'switch-row',
        'data-description': description,
        'data-wrap-description': wrapDescription,
        onClick: () => onValueChange(!value),
      },
      label,
    ),
}));
vi.mock('../../InsetGroupedList', () => ({
  InsetGroupedList: ({ children, separatorInset, testID }: InsetGroupedListProps) =>
    createElement('div', { 'data-testid': testID, 'data-separator-inset': separatorInset }, children),
}));

import { CreateDrawerForm } from '../CreateDrawerForm';

function renderForm(
  boardName: string,
  sprayWallPublic = false,
  overrides: Partial<ComponentProps<typeof CreateDrawerForm>> = {},
) {
  const noop = () => {};
  return render(
    <CreateDrawerForm
      boardName={boardName}
      description=""
      onChangeDescription={noop}
      noMatch={false}
      onChangeNoMatch={noop}
      noKickboard={false}
      onChangeNoKickboard={noop}
      campus={false}
      onChangeCampus={noop}
      anyFeet={false}
      onChangeAnyFeet={noop}
      anyFeetAvailable
      isDraft={false}
      onChangeIsDraft={noop}
      sprayWallPublic={sprayWallPublic}
      {...overrides}
    />,
  );
}

function switchLabels(boardName: string): string[] {
  return renderForm(boardName)
    .getAllByTestId('switch-row')
    .map((row) => row.textContent ?? '');
}

describe('CreateDrawerForm no-kickboard switch', () => {
  it('is not offered on a spray wall', () => {
    expect(switchLabels('spray')).not.toContain('mobile.create.settings.noKickboardLabel');
  });

  it('is offered on a catalogue board', () => {
    expect(switchLabels('kilter')).toContain('mobile.create.settings.noKickboardLabel');
  });
});

describe('CreateDrawerForm metadata', () => {
  it('keeps the editable description labelled and above the rule and publication groups', () => {
    const onChangeDescription = vi.fn();
    const form = renderForm('kilter', false, { description: 'Use the sloper', onChangeDescription });
    const description = form.getByRole('textbox', { name: 'createClimbForm.fields.description' });
    const rules = form.getByTestId('create-climb-rules');
    const publication = form.getByTestId('create-climb-publication');

    expect((description as HTMLTextAreaElement).value).toBe('Use the sloper');
    fireEvent.change(description, { target: { value: 'Keep your feet high' } });
    expect(onChangeDescription).toHaveBeenCalledWith('Keep your feet high');
    expect(description.compareDocumentPosition(rules) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(rules.compareDocumentPosition(publication) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(rules).queryByRole('switch', { name: 'mobile.create.settings.draftLabel' })).toBeNull();
    expect(within(publication).getAllByRole('switch')).toHaveLength(1);
  });

  it('keeps unavailable feet rules hidden and every visible description wrapping', () => {
    const form = renderForm('moonboard', false, { anyFeetAvailable: false });

    expect(form.queryByRole('switch', { name: 'mobile.create.settings.anyFeetLabel' })).toBeNull();
    for (const row of form.getAllByTestId('switch-row')) {
      expect(row.getAttribute('data-wrap-description')).toBe('true');
    }
  });

  it('keeps the current switch values and forwards toggles from both groups', () => {
    const onChangeNoMatch = vi.fn();
    const onChangeNoKickboard = vi.fn();
    const onChangeAnyFeet = vi.fn();
    const onChangeCampus = vi.fn();
    const onChangeIsDraft = vi.fn();
    const form = renderForm('kilter', false, {
      noMatch: true,
      onChangeNoMatch,
      noKickboard: true,
      onChangeNoKickboard,
      anyFeet: true,
      onChangeAnyFeet,
      campus: true,
      onChangeCampus,
      isDraft: true,
      onChangeIsDraft,
    });

    for (const [name, onChange] of [
      ['mobile.create.settings.noMatchLabel', onChangeNoMatch],
      ['mobile.create.settings.noKickboardLabel', onChangeNoKickboard],
      ['mobile.create.settings.anyFeetLabel', onChangeAnyFeet],
      ['mobile.create.settings.campusLabel', onChangeCampus],
      ['mobile.create.settings.draftLabel', onChangeIsDraft],
    ] as const) {
      const control = form.getByRole('switch', { name });
      expect(control.getAttribute('aria-checked')).toBe('true');
      fireEvent.click(control);
      expect(onChange).toHaveBeenCalledWith(false);
    }
  });
});

describe('CreateDrawerForm draft switch', () => {
  function draftDescription(boardName: string, sprayWallPublic = false): string | null {
    const draft = renderForm(boardName, sprayWallPublic)
      .getAllByTestId('switch-row')
      .find((row) => row.textContent === 'mobile.create.settings.draftLabel');
    return draft?.getAttribute('data-description') ?? null;
  }

  // A Private or Link only Spraywall's climbs reach apps without their names, so
  // only a board or a public Spraywall mentions them, and only with apps on.
  it.each([
    ['kilter', false, false, 'mobile.create.settings.draftDescription'],
    ['spray', false, true, 'mobile.create.settings.wallDraftDescription'],
    ['kilter', true, false, 'mobile.create.settings.draftDescriptionApps'],
    ['spray', true, false, 'mobile.create.settings.wallDraftDescription'],
    ['spray', true, true, 'mobile.create.settings.wallDraftDescriptionApps'],
  ])('on %s, partner apps on: %s, public wall: %s, says %s', (boardName, enabled, wallPublic, expected) => {
    partnerApps.enabled = enabled;
    try {
      expect(draftDescription(boardName, wallPublic)).toBe(expected);
    } finally {
      partnerApps.enabled = false;
    }
  });
});
