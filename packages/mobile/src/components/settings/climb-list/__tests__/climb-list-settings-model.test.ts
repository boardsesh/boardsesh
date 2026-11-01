import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CLIMB_ROW_DISPLAY, CLIMB_ROW_FIELD_IDS, matchClimbRowPreset } from '../../../../lib/climb-row-display';
import { buildClimbListSettingsModel, climbRowPresetLabel } from '../climb-list-settings-model';
const translate = (key: string) => key;

describe('Climb list settings model', () => {
  it('exposes every switch once, with preview before the controls', () => {
    const model = buildClimbListSettingsModel({
      display: DEFAULT_CLIMB_ROW_DISPLAY,
      t: translate,
      setField: vi.fn(),
      preview: 'example',
      previewHeight: 177,
      layout: null,
    });
    expect(model.sections.map((section) => section.key)).toEqual([
      'preview',
      'picture',
      'underName',
      'yourClimbing',
      'actions',
    ]);
    expect(model.sections[0].rows[0]).toMatchObject({ kind: 'custom', height: 177, content: 'example' });
    const fields = model.sections.flatMap((section) => section.rows).filter((row) => row.kind === 'toggle');
    expect(fields.map((row) => row.key).sort()).toEqual([...CLIMB_ROW_FIELD_IDS].sort());
  });
  it('reflects and writes a handmade mix without touching grade preferences', () => {
    const setField = vi.fn();
    const display = { ...DEFAULT_CLIMB_ROW_DISPLAY, setter: false, quickActions: false };
    const model = buildClimbListSettingsModel({
      display,
      t: translate,
      setField,
      preview: null,
      previewHeight: 177,
      layout: null,
    });
    const setter = model.sections.flatMap((section) => section.rows).find((row) => row.key === 'setter');
    expect(setter?.kind).toBe('toggle');
    if (setter?.kind !== 'toggle') throw new Error('Missing setter switch');
    expect(setter.value).toBe(false);
    setter.onValueChange(true);
    expect(setField).toHaveBeenCalledWith('setter', true);
    expect(climbRowPresetLabel(matchClimbRowPreset(display), translate)).toBe(
      'mobile.settings.climbList.presets.custom',
    );
    expect(model.sections.find((section) => section.key === 'underName')?.footer).toBe(
      'mobile.settings.climbList.gradeFooter',
    );
  });
  it('offers One column / Two columns right after the preview where two columns are possible', () => {
    const onChange = vi.fn();
    const model = buildClimbListSettingsModel({
      display: DEFAULT_CLIMB_ROW_DISPLAY,
      t: translate,
      setField: vi.fn(),
      preview: null,
      previewHeight: 177,
      layout: { value: 'two', onChange },
    });
    expect(model.sections.map((section) => section.key).slice(0, 2)).toEqual(['preview', 'layout']);
    const layoutSection = model.sections.find((section) => section.key === 'layout');
    expect(layoutSection?.title).toBe('mobile.settings.climbList.layout.title');
    expect(layoutSection?.footer).toBe('mobile.settings.climbList.layout.footer');
    const row = layoutSection?.rows[0];
    if (row?.kind !== 'segmented') throw new Error('Missing layout control');
    expect(row.options.map((option) => option.key)).toEqual(['one', 'two']);
    expect(row.selectedKey).toBe('two');
    row.onSelect('one');
    expect(onChange).toHaveBeenCalledWith('one');
  });

  it('leaves the layout section out where two columns can never fit', () => {
    const model = buildClimbListSettingsModel({
      display: DEFAULT_CLIMB_ROW_DISPLAY,
      t: translate,
      setField: vi.fn(),
      preview: null,
      previewHeight: 177,
      layout: null,
    });
    expect(model.sections.some((section) => section.key === 'layout')).toBe(false);
  });
});
