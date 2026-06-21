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

export function readableTextColor(backgroundColor: string): string {
  const lightContrast = contrastRatio(backgroundColor, readableLightText);
  const darkContrast = contrastRatio(backgroundColor, readableDarkText);
  if (lightContrast == null || darkContrast == null) return readableLightText;
  return darkContrast >= lightContrast ? readableDarkText : readableLightText;
}
