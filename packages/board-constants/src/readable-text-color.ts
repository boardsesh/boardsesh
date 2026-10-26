export const readableDarkText = '#000000';
export const readableLightText = '#FFFFFF';

function normalizeHexColor(hexColor: string): string | null {
  const raw = hexColor.trim().replace('#', '');
  if (/^[0-9a-fA-F]{3}$/.test(raw)) {
    return raw.replace(/(.)/g, '$1$1');
  }
  if (/^[0-9a-fA-F]{6}$/.test(raw)) {
    return raw;
  }
  return null;
}

function channelToLinear(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hexColor: string): number | null {
  const normalized = normalizeHexColor(hexColor);
  if (!normalized) return null;
  const red = parseInt(normalized.slice(0, 2), 16);
  const green = parseInt(normalized.slice(2, 4), 16);
  const blue = parseInt(normalized.slice(4, 6), 16);
  return channelToLinear(red) * 0.2126 + channelToLinear(green) * 0.7152 + channelToLinear(blue) * 0.0722;
}

export function contrastRatio(firstHexColor: string, secondHexColor: string): number | null {
  const firstLuminance = relativeLuminance(firstHexColor);
  const secondLuminance = relativeLuminance(secondHexColor);
  if (firstLuminance == null || secondLuminance == null) return null;
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function toHexChannel(channel: number): string {
  return Math.round(channel).toString(16).padStart(2, '0').toUpperCase();
}

/**
 * The opaque colour `foregroundColor` at `alpha` paints over `backgroundColor`,
 * e.g. a 15% grade tint over a card. Returns `backgroundColor` for invalid input.
 */
export function compositeOver(foregroundColor: string, alpha: number, backgroundColor: string): string {
  const foreground = normalizeHexColor(foregroundColor);
  const background = normalizeHexColor(backgroundColor);
  if (!foreground || !background) return backgroundColor;
  const channels = [0, 2, 4].map((offset) => {
    const top = parseInt(foreground.slice(offset, offset + 2), 16);
    const bottom = parseInt(background.slice(offset, offset + 2), 16);
    return toHexChannel(top * alpha + bottom * (1 - alpha));
  });
  return `#${channels.join('')}`;
}

/**
 * Lighten `foregroundColor` toward white just far enough to reach `minRatio`
 * against `surfaceColor`, so a colour keeps as much of its own hue as it can.
 * Returns the input unchanged when it already passes, and white when nothing
 * short of white does. Only lightens: meant for foregrounds on dark surfaces.
 */
export function liftToContrast(foregroundColor: string, surfaceColor: string, minRatio: number): string {
  const normalized = normalizeHexColor(foregroundColor);
  if (!normalized) return foregroundColor;
  const initialRatio = contrastRatio(normalized, surfaceColor);
  if (initialRatio == null || initialRatio >= minRatio) return foregroundColor;

  const red = parseInt(normalized.slice(0, 2), 16);
  const green = parseInt(normalized.slice(2, 4), 16);
  const blue = parseInt(normalized.slice(4, 6), 16);
  for (let step = 1; step <= 100; step += 1) {
    const mix = step / 100;
    const candidate = `#${toHexChannel(red + (255 - red) * mix)}${toHexChannel(green + (255 - green) * mix)}${toHexChannel(blue + (255 - blue) * mix)}`;
    const ratio = contrastRatio(candidate, surfaceColor);
    if (ratio != null && ratio >= minRatio) return candidate;
  }
  return readableLightText;
}

export function readableTextColor(backgroundColor: string): string {
  const lightContrast = contrastRatio(backgroundColor, readableLightText);
  const darkContrast = contrastRatio(backgroundColor, readableDarkText);
  if (lightContrast == null || darkContrast == null) return readableLightText;
  return darkContrast >= lightContrast ? readableDarkText : readableLightText;
}
