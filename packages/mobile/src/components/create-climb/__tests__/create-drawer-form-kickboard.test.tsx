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
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// #5960: a spray wall has no kickboard, so the create form must not offer the
// "No kickboard" switch there. Every catalogue board keeps it.

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1,
  },
  TextInput: () => createElement('textarea'),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({ systemColors: { fill: '#000', label: '#fff', tertiaryLabel: '#888' } }),
}));
vi.mock('../../../theme/tokens', () => ({
  opacity: { disabled: 0.5 },
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
  borderRadius: { md: 8 },
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../SwitchRow', () => ({
  SwitchRow: ({ label, description }: { label: string; description?: string }) =>
    createElement('div', { 'data-testid': 'switch-row', 'data-description': description }, label),
}));

import { CreateDrawerForm } from '../CreateDrawerForm';

function renderForm(boardName: string, sprayWallPublic = false) {
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
