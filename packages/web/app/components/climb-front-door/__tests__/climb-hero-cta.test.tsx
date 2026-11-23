import React from 'react';
import { describe, expect, it, vi } from 'vite-plus/test';
import { render } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { darkTheme } from '@/app/theme/mui-theme';

vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async () => ({ t: (key: string) => key, locale: 'en-US' })),
}));
vi.mock('@/app/lib/analytics', () => ({ track: vi.fn(), trackBeforeNavigation: vi.fn() }));
vi.mock('@/app/lib/ble/capacitor-utils', () => ({
  isNativeApp: () => false,
  isCapacitorWebView: () => false,
  waitForCapacitor: () => Promise.resolve(false),
}));

const ClimbHeroCta = (await import('../climb-hero-cta')).default;

type HoverRule = { specificity: number; order: number; media: string | null; style: CSSStyleDeclaration };

/** Classes, attributes and pseudo-classes; `:not()` counts its argument. Enough for MUI's and emotion's selectors. */
function specificityOf(selector: string): number {
  return (selector.replace(/:not\(/g, ' (').match(/#[\w-]+|\.[\w-]+|\[[^\]]*\]|:[\w-]+/g) ?? []).length;
}

function isGroupingRule(rule: CSSRule): rule is CSSMediaRule {
  return 'cssRules' in rule && 'media' in rule;
}

function isStyleRule(rule: CSSRule): rule is CSSStyleRule {
  return 'selectorText' in rule && 'style' in rule;
}

/** Every `:hover` rule in the document that would apply to `element` while hovered. */
function hoverRulesFor(element: Element): HoverRule[] {
  const found: HoverRule[] = [];
  let order = 0;
  const visit = (rules: CSSRuleList, media: string | null) => {
    for (const rule of Array.from(rules)) {
      if (isGroupingRule(rule)) {
        visit(rule.cssRules, rule.media.mediaText);
        continue;
      }
      if (!isStyleRule(rule)) continue;
      order += 1;
      for (const selector of rule.selectorText.split(',')) {
        if (!selector.includes(':hover')) continue;
        let matchesAtRest = false;
        try {
          matchesAtRest = element.matches(selector.replace(/:hover/g, ''));
        } catch {
          matchesAtRest = false;
        }
        if (matchesAtRest) found.push({ specificity: specificityOf(selector), order, media, style: rule.style });
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) visit(sheet.cssRules, null);
  return found;
}

/** The value the cascade picks for `property` among `rules`: highest specificity, then the later rule. */
function cascadeWinner(rules: HoverRule[], property: string): string | undefined {
  const setting = rules.filter((rule) => rule.style.getPropertyValue(property) !== '');
  setting.sort((first, second) => first.specificity - second.specificity || first.order - second.order);
  return setting.at(-1)?.style.getPropertyValue(property);
}

async function renderHeroCta() {
  const element = await ClimbHeroCta({
    climbName: 'Floats Your Boat',
    climbUuid: 'CLIMB1',
    boardName: 'kilter',
    layoutId: 1,
    layoutName: 'Kilter Board Original',
    angle: 40,
    handoffPath: '/b/the-kilter/40/view/floats-your-boat-CLIMB1',
    tree: 'slug',
  });
  return render(<ThemeProvider theme={darkTheme}>{element}</ThemeProvider>);
}

describe('ClimbHeroCta hand-off hover', () => {
  it('keeps the filled look on a laptop hover, against the theme wash for text buttons', async () => {
    const view = await renderHeroCta();
    const handoff = view.container.querySelector('[data-cta="handoff"]');
    if (!handoff) throw new Error('no hand-off rendered');
    const rules = hoverRulesFor(handoff);

    // The theme's wash does reach this button (it is a text button at every width)...
    expect(
      rules.some((rule) => rule.style.getPropertyValue('background-color') === 'var(--semantic-button-hover)'),
    ).toBe(true);
    // ...and from md the hand-off's own hover wins it.
    const laptopRules = rules.filter((rule) => rule.media === null || rule.media.includes('900px'));
    expect(cascadeWinner(laptopRules, 'background-color')).toBe('var(--color-primary-fill-hover)');
    expect(cascadeWinner(laptopRules, 'color')).toBe('var(--color-on-primary)');
  });

  it('keeps the text-link hover below md', async () => {
    const view = await renderHeroCta();
    const handoff = view.container.querySelector('[data-cta="handoff"]');
    if (!handoff) throw new Error('no hand-off rendered');

    const phoneRules = hoverRulesFor(handoff).filter((rule) => rule.media === null);

    expect(cascadeWinner(phoneRules, 'background-color')).toBe('var(--semantic-button-hover)');
  });

  it('stays a text button, so the store is the only contained one', async () => {
    const view = await renderHeroCta();

    const handoff = view.container.querySelector('[data-cta="handoff"]');
    expect(handoff?.classList.contains('MuiButton-text')).toBe(true);
    expect(handoff?.hasAttribute('aria-label')).toBe(false);
  });
});
