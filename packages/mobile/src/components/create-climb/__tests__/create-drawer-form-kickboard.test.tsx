// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// #5960: a spray wall has no kickboard, so the create form must not offer the
// "No kickboard" switch there. Every catalogue board keeps it.

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  TextInput: () => createElement('textarea'),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { fill: '#000', label: '#fff', tertiaryLabel: '#888' } }),
}));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
  borderRadius: { md: 8 },
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../SwitchRow', () => ({
  SwitchRow: ({ label }: { label: string }) => createElement('div', { 'data-testid': 'switch-row' }, label),
}));

import { CreateDrawerForm } from '../CreateDrawerForm';

function renderForm(boardName: string) {
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
