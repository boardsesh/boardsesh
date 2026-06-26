// Colour-vision-deficiency (CVD) simulation for the accessibility hold picker.
//
// Lets a user preview how their chosen marker colours would look to someone with
// the three dichromacies, so they can confirm the four hold roles stay
// distinguishable. This is a visualisation aid, not a clinical tool.
//
// Uses the Machado, Oliveira & Fernandes (2009) severity-1.0 matrices. These are
// applied directly to gamma-encoded sRGB (no linearisation) — the form Machado's
// own implementation and the common ports use, so the simulated colours match
// the reference look other CVD tools produce. Pure TS, no React Native imports.

export type CvdType = 'deuteranopia' | 'protanopia' | 'tritanopia';

type Matrix3 = readonly [number, number, number, number, number, number, number, number, number];

// Severity 1.0 (full dichromacy) matrices, row-major. Rows sum to ~1 so greys
// map to greys. Applied in the sRGB gamma domain (see header).
const CVD_MATRICES: Record<CvdType, Matrix3> = {
  protanopia: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deuteranopia: [0.367322, 0.860646, -0.227968, 0.28009, 0.672501, 0.047409, -0.01182, 0.04294, 0.968881],
  tritanopia: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039],
};

function clampByte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function parseHex(hex: string): [number, number, number] | null {
  const trimmed = hex.trim().replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(trimmed)) return null;
  return [parseInt(trimmed.slice(0, 2), 16), parseInt(trimmed.slice(2, 4), 16), parseInt(trimmed.slice(4, 6), 16)];
}

function toHex(red: number, green: number, blue: number): string {
  const channel = (value: number) => clampByte(value).toString(16).padStart(2, '0');
  return `#${channel(red)}${channel(green)}${channel(blue)}`;
}

/**
 * Simulate how `hex` (#rrggbb) appears under the given dichromacy.
 * Returns a #rrggbb hex string. Malformed input is returned unchanged.
 */
export function simulateCvd(hex: string, type: CvdType): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;

  const [sr, sg, sb] = [rgb[0], rgb[1], rgb[2]];
  const m = CVD_MATRICES[type];
  return toHex(m[0] * sr + m[1] * sg + m[2] * sb, m[3] * sr + m[4] * sg + m[5] * sb, m[6] * sr + m[7] * sg + m[8] * sb);
}
