import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfigContext, ExpoConfig } from 'expo/config';
import { brandColors, brandColorsDark } from '@boardsesh/velvet-tokens';
import { describe, expect, it } from 'vitest';

import createExpoConfig from '../../../app.config';

const require = createRequire(import.meta.url);

type ColorComponents = { alpha: string; red: string; green: string; blue: string };
type ColorSet = {
  colors: { appearances?: { appearance: string; value: string }[]; color: { components: ColorComponents } }[];
};
type ResourceItem = { $: { name: string }; _: string };
type ResourceXml = { resources: { color?: ResourceItem[]; style?: { $: { name: string }; item: ResourceItem[] }[] } };
type CapturingTarget = {
  isa: 'PBXNativeTarget';
  props: { name: string; productName: string; productType: string };
  setBuildSetting(settingName: string, settingValue: string): void;
};

type BrandAccentColorPlugin = {
  ACCENT_LIGHT: string;
  ACCENT_DARK: string;
  ACCENT_HIGH_CONTRAST_LIGHT: string;
  ACCENT_HIGH_CONTRAST_DARK: string;
  IOS_ACCENT_BUILD_SETTING: string;
  buildAccentColorSetContents(): ColorSet;
  writeAccentColorSet(sourceRoot: string): string;
  setAccentColorBuildSetting(project: { rootObject: { props: { targets: CapturingTarget[] } } }): void;
  applyAndroidAccentColor(colors: ResourceXml, value: string): ResourceXml;
  applyAndroidAccentStyle(styles: ResourceXml): ResourceXml;
};

const plugin = require('../../../plugins/with-brand-accent-color.js') as BrandAccentColorPlugin;

function hexOf(components: ColorComponents): string {
  return `#${[components.red, components.green, components.blue].map((part) => part.slice(2)).join('')}`;
}

function buildConfig(): ExpoConfig {
  const previousTailscaleHosts = process.env.TAILSCALE_HOSTS;
  process.env.TAILSCALE_HOSTS = '';
  try {
    return createExpoConfig({ config: { name: 'Boardsesh', slug: 'boardsesh' } } as ConfigContext);
  } finally {
    if (previousTailscaleHosts === undefined) delete process.env.TAILSCALE_HOSTS;
    else process.env.TAILSCALE_HOSTS = previousTailscaleHosts;
  }
}

function target(name: string, productType: string): { target: CapturingTarget; settings: Record<string, string> } {
  const settings: Record<string, string> = {};
  return {
    settings,
    target: {
      isa: 'PBXNativeTarget',
      props: { name, productName: name, productType },
      setBuildSetting(settingName, settingValue) {
        settings[settingName] = settingValue;
      },
    },
  };
}

describe('with-brand-accent-color (HIG Color: the app accent in system UI)', () => {
  it('uses the Velvet Send brand tint, light and dark', () => {
    expect(plugin.ACCENT_LIGHT.toLowerCase()).toBe(brandColors.tint.toLowerCase());
    expect(plugin.ACCENT_DARK.toLowerCase()).toBe(brandColorsDark.tint.toLowerCase());
  });

  it('writes an AccentColor colour set: light by default, dark under the dark appearance', () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'accent-color-'));
    try {
      const colorSetDir = plugin.writeAccentColorSet(sourceRoot);
      expect(colorSetDir).toBe(join(sourceRoot, 'Images.xcassets', 'AccentColor.colorset'));

      const contents = JSON.parse(readFileSync(join(colorSetDir, 'Contents.json'), 'utf8')) as ColorSet;
      const [light, dark, highContrastLight, highContrastDark] = contents.colors;
      expect(light?.appearances).toBeUndefined();
      expect(hexOf(light!.color.components)).toBe(plugin.ACCENT_LIGHT.toUpperCase());
      expect(dark?.appearances).toEqual([{ appearance: 'luminosity', value: 'dark' }]);
      expect(hexOf(dark!.color.components)).toBe(plugin.ACCENT_DARK.toUpperCase());

      expect(highContrastLight?.appearances).toEqual([{ appearance: 'contrast', value: 'high' }]);
      expect(hexOf(highContrastLight!.color.components)).toBe('#4C1D95');
      expect(highContrastDark?.appearances).toEqual([
        { appearance: 'luminosity', value: 'dark' },
        { appearance: 'contrast', value: 'high' },
      ]);
      expect(hexOf(highContrastDark!.color.components)).toBe('#C4B5FD');

      // A second prebuild rewrites the same file rather than failing.
      expect(() => plugin.writeAccentColorSet(sourceRoot)).not.toThrow();
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  it('names the colour set as the global accent on the app target only', () => {
    const app = target('Boardsesh', 'com.apple.product-type.application');
    const widget = target('BoardseshWidgets', 'com.apple.product-type.app-extension');

    plugin.setAccentColorBuildSetting({ rootObject: { props: { targets: [widget.target, app.target] } } });

    expect(app.settings).toEqual({ [plugin.IOS_ACCENT_BUILD_SETTING]: 'AccentColor' });
    expect(widget.settings).toEqual({});
  });

  it('sets colorAccent in colors.xml and points the app theme at it', () => {
    const colors = plugin.applyAndroidAccentColor({ resources: {} }, plugin.ACCENT_DARK);
    expect(colors.resources.color).toContainEqual({ $: { name: 'colorAccent' }, _: plugin.ACCENT_DARK });

    const styles = plugin.applyAndroidAccentStyle({
      resources: { style: [{ $: { name: 'AppTheme' }, item: [] }] },
    });
    expect(styles.resources.style?.[0]?.item).toContainEqual({ $: { name: 'colorAccent' }, _: '@color/colorAccent' });
  });

  it('is registered, with the brand as the Android primary colour', () => {
    const config = buildConfig();

    expect(config.plugins).toContain('./plugins/with-brand-accent-color');
    expect(config.primaryColor?.toLowerCase()).toBe(brandColors.tint.toLowerCase());
  });
});
