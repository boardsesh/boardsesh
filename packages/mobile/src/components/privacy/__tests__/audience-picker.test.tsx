// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const confirm = vi.hoisted(() => vi.fn());
vi.mock('react-native', () => ({ View: 'div', StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/dialog-provider', () => ({ useConfirm: () => confirm }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ spacing: [], radii: {}, systemColors: {}, brandColors: {} }),
}));
vi.mock('../../Text', () => ({ Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
    accessibilityRole,
  }: {
    children: React.ReactNode;
    onPress: () => void;
    accessibilityLabel?: string;
    accessibilityRole?: string;
  }) => (
    <button onClick={onPress} aria-label={accessibilityLabel} role={accessibilityRole}>
      {children}
    </button>
  ),
}));
import { AudiencePicker, BOARD_AUDIENCES } from '../AudiencePicker';
beforeEach(() => confirm.mockReset());
describe('private audience publication consent', () => {
  it('asks again when an already-selected Public choice has stale consent', async () => {
    const onChange = vi.fn();
    confirm.mockResolvedValue(false);
    const view = render(
      <AudiencePicker audience="public" options={BOARD_AUDIENCES} onChange={onChange} confirmPublic reconfirmPublic />,
    );
    fireEvent.click(view.getByLabelText('privacy.audienceLabel'));
    fireEvent.click(view.getByRole('radio', { name: 'privacy.audiences.public' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    expect(onChange).not.toHaveBeenCalled();
  });
  it.each(['public', 'unlisted'] as const)('requires confirmation before widening to %s', async (audience) => {
    const onChange = vi.fn();
    confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const view = render(
      <AudiencePicker audience="followers" options={BOARD_AUDIENCES} onChange={onChange} confirmPublic resource />,
    );
    fireEvent.click(view.getByLabelText('privacy.audienceLabel'));
    const label = audience === 'public' ? 'privacy.audiences.public' : 'privacy.audiences.unlisted';
    fireEvent.click(view.getByRole('radio', { name: label }));
    await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole('radio', { name: label }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(audience));
    expect(confirm).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: audience === 'public' ? 'privacy.publishResourceMessage' : 'privacy.publishLinkMessage',
      }),
    );
  });
});
