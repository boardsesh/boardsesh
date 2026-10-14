import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MoreFormModel } from '../../components/MoreForm.types';

const trackMock = vi.hoisted(() => vi.fn());
vi.mock('../analytics', () => ({ track: trackMock }));

import { withSettingTracking } from '../settings-analytics';

function buildModel(handlers: { toggle: (next: boolean) => void; select: (key: string) => void }): MoreFormModel {
  return {
    sections: [
      {
        key: 'section',
        rows: [
          {
            kind: 'toggle',
            key: 'lightOnSwipe',
            label: 'Light on swipe',
            value: false,
            onValueChange: handlers.toggle,
          },
          {
            kind: 'select',
            key: 'language',
            label: 'Language',
            options: [
              { key: 'system', label: 'System' },
              { key: 'de', label: 'Deutsch' },
            ],
            selectedKey: 'system',
            onSelect: handlers.select,
          },
          { kind: 'nav', key: 'boardLook', label: 'Board look', onPress: vi.fn() },
        ],
      },
    ],
  };
}

describe('withSettingTracking', () => {
  beforeEach(() => trackMock.mockClear());

  it('reports a toggle change with its page, key and value, then applies it', () => {
    const toggle = vi.fn();
    const model = withSettingTracking(buildModel({ toggle, select: vi.fn() }), 'board');
    const row = model.sections[0]?.rows[0];
    if (row?.kind !== 'toggle') throw new Error('expected a toggle row');

    row.onValueChange(true);

    expect(trackMock).toHaveBeenCalledWith('Setting Changed', {
      page: 'board',
      key: 'lightOnSwipe',
      value: true,
    });
    expect(toggle).toHaveBeenCalledWith(true);
  });

  it('reports the option key of a select, and stays quiet when the same option is picked again', () => {
    const select = vi.fn();
    const model = withSettingTracking(buildModel({ toggle: vi.fn(), select }), 'general');
    const row = model.sections[0]?.rows[1];
    if (row?.kind !== 'select') throw new Error('expected a select row');

    row.onSelect('system');
    expect(trackMock).not.toHaveBeenCalled();

    row.onSelect('de');
    expect(trackMock).toHaveBeenCalledWith('Setting Changed', { page: 'general', key: 'language', value: 'de' });
    expect(select).toHaveBeenCalledTimes(2);
  });

  it('leaves navigation rows and skipped keys untouched', () => {
    const toggle = vi.fn();
    const original = buildModel({ toggle, select: vi.fn() });
    const model = withSettingTracking(original, 'privacy', { skipKeys: new Set(['lightOnSwipe']) });

    expect(model.sections[0]?.rows[0]).toBe(original.sections[0]?.rows[0]);
    expect(model.sections[0]?.rows[2]).toBe(original.sections[0]?.rows[2]);
  });
});
