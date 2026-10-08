import type { TextStyle } from 'react-native';

/** Bold Text raises the resolved weight one step, including explicit style overrides. */
export function boldTextWeight(weight: TextStyle['fontWeight'] = '400'): TextStyle['fontWeight'] {
  const numeric = weight === 'normal' ? 400 : weight === 'bold' ? 700 : Number(weight);
  const heavier = Number.isFinite(numeric) ? Math.min(900, numeric + 100) : 500;
  return String(heavier) as TextStyle['fontWeight'];
}
