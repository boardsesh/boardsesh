import { expect, type Locator, type Page } from '@playwright/test';

/** The seeded setter has multiple pages of linked climbs. Wait for those controls before measuring them. */
export async function waitForSeededSetter(page: Page) {
  await expect(page.getByRole('button', { name: 'Share setter profile', exact: true })).toBeVisible();
  await expect(page.locator('main a[href*="/view/"]').first()).toBeVisible();
  await expect(page.locator('main nav a[rel="next"]')).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

/** Browser measurements, including offscreen content in the normal page flow. */
export async function auditPublicPage(page: Page, target?: Locator) {
  // Navigation or moving the pointer can start a hover-out transition. Measure
  // its settled colours rather than an intermediate foreground/background pair.
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation instanceof CSSTransition)
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  const targetHandle = target ? await target.elementHandle() : null;
  if (target && !targetHandle) throw new Error('The audited target is unavailable');
  try {
    return await page.evaluate((targetElement) => {
      type Rgba = { red: number; green: number; blue: number; alpha: number };
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const maybeContext = canvas.getContext('2d', { willReadFrequently: true });
      if (!maybeContext) throw new Error('Canvas colour resolution is unavailable');
      const context = maybeContext;

      function parseColor(color: string): Rgba {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
        return { red, green, blue, alpha: alpha / 255 };
      }

      function composite(foreground: Rgba, background: Rgba): Rgba {
        return {
          red: foreground.red * foreground.alpha + background.red * (1 - foreground.alpha),
          green: foreground.green * foreground.alpha + background.green * (1 - foreground.alpha),
          blue: foreground.blue * foreground.alpha + background.blue * (1 - foreground.alpha),
          alpha: 1,
        };
      }

      function luminance(color: Rgba): number {
        const channels = [color.red, color.green, color.blue].map((channel) => {
          const normalized = channel / 255;
          return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
        });
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      }

      function contrastRatio(foreground: Rgba, background: Rgba): number {
        const foregroundLuminance = luminance(composite(foreground, background));
        const backgroundLuminance = luminance(background);
        return (
          (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
          (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
        );
      }

      function effectiveBackground(element: Element | null): { background: Rgba; unresolved: string | null } {
        const ancestors: Element[] = [];
        for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
          ancestors.unshift(ancestor);
        }
        let background: Rgba = { red: 255, green: 255, blue: 255, alpha: 1 };
        let unresolved: string | null = null;
        for (const ancestor of ancestors) {
          const style = getComputedStyle(ancestor);
          // A colour-only calculation cannot prove text over imagery, gradients,
          // group opacity or filtered pixels. Keep these explicit in the report.
          if (style.backgroundImage !== 'none') unresolved = 'background image or gradient';
          if (Number(style.opacity) !== 1) unresolved = 'ancestor opacity';
          if (style.filter !== 'none' || (style.backdropFilter && style.backdropFilter !== 'none')) {
            unresolved = 'filtered background';
          }
          background = composite(parseColor(style.backgroundColor), background);
        }
        return { background, unresolved };
      }

      function isVisible(element: Element): boolean {
        if (element.getClientRects().length === 0) return false;
        for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor);
          if (style.visibility !== 'visible' || Number(style.opacity) === 0) return false;
        }
        return true;
      }

      function scopeFor(element: Element): string {
        if (element.closest('[data-testid="marketing-header"]')) return 'header';
        if (element.closest('[data-testid="site-footer"]')) return 'footer';
        if (element.closest('[role="menuitem"]')) return 'menu';
        return 'main';
      }

      const targets = Array.from(
        document.querySelectorAll(
          'main a[href], main button, main [role="button"], main summary, header a[href], header button, footer a[href], footer button, [role="menuitem"]',
        ),
      )
        .filter(isVisible)
        .map((element) => {
          const rectangle = element.getBoundingClientRect();
          return {
            scope: scopeFor(element),
            label: element.getAttribute('aria-label') ?? element.textContent?.trim().replace(/\s+/g, ' ') ?? '',
            href: element.getAttribute('href'),
            disabled: element.matches(':disabled, [aria-disabled="true"]'),
            width: rectangle.width,
            height: rectangle.height,
            left: rectangle.left,
            right: rectangle.right,
          };
        });

      type TextSample = {
        scope: string;
        label: string;
        ratio: number | null;
        inactive: boolean;
        unresolved: string | null;
      };
      const text: TextSample[] = [];
      const targetText: TextSample[] = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const element = node.parentElement;
        const label = node.textContent?.trim();
        if (!element || !label || !element.closest('main, header, footer, [role="menuitem"]')) continue;
        if (element.closest('script, style, noscript, svg') || !isVisible(element)) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        if (range.getBoundingClientRect().width === 0) continue;

        const { background, unresolved } = effectiveBackground(element);
        const sample = {
          scope: scopeFor(element),
          label,
          ratio: unresolved ? null : contrastRatio(parseColor(getComputedStyle(element).color), background),
          inactive: element.closest('button:disabled') !== null,
          unresolved,
        };
        text.push(sample);
        if (targetElement?.contains(element)) targetText.push(sample);
      }

      type FocusOutline = {
        visible: boolean;
        width: number;
        style: string;
        color: string;
        alpha: number;
        ratio: number | null;
        unresolved: string | null;
        fullyWithinClip: boolean;
      };
      let focusOutline: FocusOutline | null = null;
      if (targetElement) {
        const style = getComputedStyle(targetElement);
        const outlineColor = parseColor(style.outlineColor);
        // A nonnegative offset paints outside the target, over its surroundings.
        const backdropElement = parseFloat(style.outlineOffset) < 0 ? targetElement : targetElement.parentElement;
        const { background, unresolved: backgroundUnresolved } = effectiveBackground(backdropElement);
        let unresolved = backgroundUnresolved;
        if (Number(style.opacity) !== 1) unresolved = 'ancestor opacity';
        if (style.filter !== 'none' || (style.backdropFilter && style.backdropFilter !== 'none')) {
          unresolved = 'filtered background';
        }
        // Only certify a complete ring. An outline outside an overflow clip can
        // have excellent computed contrast yet paint no pixels at all.
        const clip = { left: 0, top: 0, right: document.documentElement.clientWidth, bottom: innerHeight };
        for (let ancestor = targetElement.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const ancestorStyle = getComputedStyle(ancestor);
          if (ancestorStyle.clipPath !== 'none' || ancestorStyle.maskImage !== 'none')
            unresolved = 'nonrectangular clip';
          if (ancestorStyle.overflowX === 'visible' && ancestorStyle.overflowY === 'visible') continue;
          const bounds = ancestor.getBoundingClientRect();
          const left = bounds.left + ancestor.clientLeft;
          const top = bounds.top + ancestor.clientTop;
          if (ancestorStyle.overflowX !== 'visible') {
            clip.left = Math.max(clip.left, left);
            clip.right = Math.min(clip.right, left + ancestor.clientWidth);
          }
          if (ancestorStyle.overflowY !== 'visible') {
            clip.top = Math.max(clip.top, top);
            clip.bottom = Math.min(clip.bottom, top + ancestor.clientHeight);
          }
        }
        const ringExtent = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
        const bounds = targetElement.getBoundingClientRect();
        focusOutline = {
          visible:
            document.activeElement === targetElement &&
            targetElement.matches(':focus-visible') &&
            isVisible(targetElement),
          width: parseFloat(style.outlineWidth),
          style: style.outlineStyle,
          color: style.outlineColor,
          alpha: outlineColor.alpha,
          ratio: unresolved ? null : contrastRatio(outlineColor, background),
          unresolved,
          fullyWithinClip:
            bounds.left - ringExtent >= clip.left &&
            bounds.top - ringExtent >= clip.top &&
            bounds.right + ringExtent <= clip.right &&
            bounds.bottom + ringExtent <= clip.bottom,
        };
      }

      return {
        pathname: location.pathname,
        width: innerWidth,
        overflow: document.documentElement.scrollWidth - innerWidth,
        h1Count: document.querySelectorAll('main h1').length,
        targets,
        text,
        targetText,
        focusOutline,
      };
    }, targetHandle);
  } finally {
    await targetHandle?.dispose();
  }
}

/** Only text inside a genuinely disabled native button gets the inactive exception. */
export function readableContrastFailures(audit: Awaited<ReturnType<typeof auditPublicPage>>) {
  return audit.text.filter((entry) => !entry.inactive && entry.ratio !== null && entry.ratio < 4.5);
}

/** The actual control label must be measured; other readable page text cannot stand in for it. */
export function hasReadableTargetText(audit: Awaited<ReturnType<typeof auditPublicPage>>) {
  return (
    audit.targetText.length > 0 &&
    audit.targetText.every((entry) => !entry.inactive && entry.ratio !== null && entry.ratio >= 4.5)
  );
}

/** Alpha is composited against the ring's backdrop; unresolved pixels cannot prove visible focus. */
export function hasVisibleFocusOutline(audit: Awaited<ReturnType<typeof auditPublicPage>>) {
  const outline = audit.focusOutline;
  return (
    outline !== null &&
    outline.visible &&
    outline.fullyWithinClip &&
    outline.width >= 2 &&
    !['none', 'hidden'].includes(outline.style) &&
    outline.alpha > 0 &&
    outline.ratio !== null &&
    outline.ratio >= 3
  );
}
