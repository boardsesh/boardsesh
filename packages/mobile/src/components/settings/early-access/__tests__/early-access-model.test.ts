import { describe, expect, it, vi } from 'vitest';
import { buildEarlyAccessModel, type EarlyAccessModelInput } from '../early-access-model';

const echo = (key: string, options?: Record<string, unknown>) => (options ? `${key}:${JSON.stringify(options)}` : key);

type Previews = NonNullable<EarlyAccessModelInput['previews']>;

function previews(overrides: Partial<Previews> = {}): Previews {
  return { prNumber: null, onOpenTestPlan: vi.fn(), onOpenPicker: vi.fn(), promptOnLaunch: null, ...overrides };
}

function layout(input: EarlyAccessModelInput): [string, string[]][] {
  return buildEarlyAccessModel(input).sections.map((section) => [section.key, section.rows.map((row) => row.key)]);
}

describe('buildEarlyAccessModel', () => {
  it('shows previews only on a build that can load one', () => {
    expect(layout({ t: echo, previews: previews() })).toEqual([['previews', ['qaPick']]]);
    expect(layout({ t: echo, previews: null })).toEqual([]);
  });

  it('offers the test plan while a preview is running, and the picker otherwise', () => {
    const onOpenTestPlan = vi.fn();
    const model = buildEarlyAccessModel({
      t: echo,
      previews: previews({ prNumber: 4792, onOpenTestPlan }),
    });
    const row = model.sections[0].rows[0];
    if (row.kind !== 'nav') throw new Error('not a nav row');
    expect(row.key).toBe('qaBrief');
    expect(row.label).toBe('mobile.settings.previews.testPlanTitle:{"prNumber":4792}');
    row.onPress();
    expect(onOpenTestPlan).toHaveBeenCalledOnce();
  });

  it('gives testers the prompt-on-launch switch', () => {
    const onChange = vi.fn();
    const model = buildEarlyAccessModel({
      t: echo,
      previews: previews({ promptOnLaunch: { enabled: true, onChange } }),
    });
    expect(model.sections[0].rows.map((row) => row.key)).toEqual(['qaPick', 'qaPromptOnLaunch']);
    const toggle = model.sections[0].rows[1];
    if (toggle.kind !== 'toggle') throw new Error('not a toggle');
    toggle.onValueChange(false);
    expect(onChange).toHaveBeenCalledWith(false);
  });
});
