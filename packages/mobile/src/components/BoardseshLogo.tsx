import { type ComponentProps } from 'react';
import { Image } from 'expo-image';

// The transparent Boardsesh mark (shared with the login screen). Kept in one
// place so the static asset require lives behind a component — screens and their
// tests never touch the raw png.
const LOGO_SOURCE = require('../../assets/splash-icon.png');

type BoardseshLogoProps = {
  size?: number;
  style?: ComponentProps<typeof Image>['style'];
};

export function BoardseshLogo({ size = 88, style }: BoardseshLogoProps) {
  return (
    <Image
      source={LOGO_SOURCE}
      style={[{ width: size, height: size }, style]}
      contentFit="contain"
      accessibilityIgnoresInvertColors
    />
  );
}
