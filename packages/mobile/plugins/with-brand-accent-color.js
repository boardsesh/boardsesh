const fs = require('node:fs');
const path = require('node:path');
const {
  AndroidConfig,
  IOSConfig,
  createRunOncePlugin,
  withAndroidColors,
  withAndroidColorsNight,
  withAndroidStyles,
  withDangerousMod,
} = require('expo/config-plugins');
const { withXcodeProjectBeta } = require('@bacons/apple-targets/build/with-bacons-xcode');
const { findIosApplicationTarget } = require('./with-ios-app-store-build-settings');

/**
 * The brand tint for the parts of the app the OS draws: alerts, context menus,
 * share sheets, pickers (HIG Color: "use your app's accent colour" — without an
 * AccentColor asset, every UIKit control the app does not tint itself falls
 * back to system blue).
 *
 * The values are `brandColors.tint` (light) and `brandColorsDark.tint` (dark)
 * from `@boardsesh/velvet-tokens`. They are literals here because this file is
 * evaluated by Expo's config loader and the fingerprint tooling, which do not
 * load TypeScript workspace packages; `brand-accent-color-plugin.test.ts` fails
 * when the two disagree.
 */
const ACCENT_LIGHT = '#6D28D9';
const ACCENT_DARK = '#A78BFA';
// The iOS DynamicColorIOS accent variants in src/theme/colors.ts (HIG Contrast).
const ACCENT_HIGH_CONTRAST_LIGHT = '#4C1D95';
const ACCENT_HIGH_CONTRAST_DARK = '#C4B5FD';

const IOS_ACCENT_COLOR_NAME = 'AccentColor';
const IOS_ACCENT_BUILD_SETTING = 'ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME';
const ANDROID_ACCENT_COLOR_NAME = 'colorAccent';

/** `#6D28D9` -> the asset-catalog component map Xcode writes for an sRGB colour. */
function colorComponents(hexColor) {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hexColor);
  if (!match) {
    throw new Error(`with-brand-accent-color: ${hexColor} is not a #RRGGBB colour.`);
  }
  const [, red, green, blue] = match;
  return {
    alpha: '1.000',
    blue: `0x${blue.toUpperCase()}`,
    green: `0x${green.toUpperCase()}`,
    red: `0x${red.toUpperCase()}`,
  };
}

/** The `Contents.json` of `AccentColor.colorset`: light by default, dark under the dark appearance. */
function buildAccentColorSetContents(light = ACCENT_LIGHT, dark = ACCENT_DARK) {
  return {
    colors: [
      {
        color: { 'color-space': 'srgb', components: colorComponents(light) },
        idiom: 'universal',
      },
      {
        appearances: [{ appearance: 'luminosity', value: 'dark' }],
        color: { 'color-space': 'srgb', components: colorComponents(dark) },
        idiom: 'universal',
      },
      {
        appearances: [{ appearance: 'contrast', value: 'high' }],
        color: { 'color-space': 'srgb', components: colorComponents(ACCENT_HIGH_CONTRAST_LIGHT) },
        idiom: 'universal',
      },
      {
        appearances: [
          { appearance: 'luminosity', value: 'dark' },
          { appearance: 'contrast', value: 'high' },
        ],
        color: { 'color-space': 'srgb', components: colorComponents(ACCENT_HIGH_CONTRAST_DARK) },
        idiom: 'universal',
      },
    ],
    info: { author: 'xcode', version: 1 },
  };
}

/** Writes `<app>/Images.xcassets/AccentColor.colorset/Contents.json`, replacing any older copy. */
function writeAccentColorSet(sourceRoot) {
  const colorSetDir = path.join(sourceRoot, 'Images.xcassets', `${IOS_ACCENT_COLOR_NAME}.colorset`);
  fs.mkdirSync(colorSetDir, { recursive: true });
  fs.writeFileSync(
    path.join(colorSetDir, 'Contents.json'),
    `${JSON.stringify(buildAccentColorSetContents(), null, 2)}\n`,
  );
  return colorSetDir;
}

/**
 * Names the colour set as the app's global accent, which is what puts
 * `NSAccentColorName` in the built Info.plist and makes UIKit use it as the
 * window tint. The app target only (found the same way the App Store build
 * settings plugin finds it): the widget and share extension keep their own look.
 */
function setAccentColorBuildSetting(project) {
  const appTarget = findIosApplicationTarget(project);
  if (typeof appTarget.setBuildSetting !== 'function') {
    throw new Error('with-brand-accent-color: the app target does not support setBuildSetting().');
  }
  appTarget.setBuildSetting(IOS_ACCENT_BUILD_SETTING, IOS_ACCENT_COLOR_NAME);
  return project;
}

/** colors.xml (light or night) with `colorAccent` set. */
function applyAndroidAccentColor(colors, value) {
  return AndroidConfig.Colors.assignColorValue(colors, { name: ANDROID_ACCENT_COLOR_NAME, value });
}

/**
 * The app theme reads `colorAccent`, which AppCompat dialogs (RN's `Alert`),
 * text selection handles and pickers use. Without it they draw AppCompat's teal.
 */
function applyAndroidAccentStyle(styles) {
  return AndroidConfig.Styles.assignStylesValue(styles, {
    add: true,
    parent: AndroidConfig.Styles.getAppThemeGroup(),
    name: ANDROID_ACCENT_COLOR_NAME,
    value: `@color/${ANDROID_ACCENT_COLOR_NAME}`,
  });
}

function withBrandAccentColor(config) {
  config = withDangerousMod(config, [
    'ios',
    async (modConfig) => {
      writeAccentColorSet(IOSConfig.Paths.getSourceRoot(modConfig.modRequest.projectRoot));
      return modConfig;
    },
  ]);
  config = withXcodeProjectBeta(config, async (modConfig) => {
    setAccentColorBuildSetting(modConfig.modResults);
    return modConfig;
  });
  config = withAndroidColors(config, (modConfig) => {
    modConfig.modResults = applyAndroidAccentColor(modConfig.modResults, ACCENT_LIGHT);
    return modConfig;
  });
  config = withAndroidColorsNight(config, (modConfig) => {
    modConfig.modResults = applyAndroidAccentColor(modConfig.modResults, ACCENT_DARK);
    return modConfig;
  });
  config = withAndroidStyles(config, (modConfig) => {
    modConfig.modResults = applyAndroidAccentStyle(modConfig.modResults);
    return modConfig;
  });
  return config;
}

module.exports = createRunOncePlugin(withBrandAccentColor, 'with-brand-accent-color', '1.0.0');
module.exports.ACCENT_LIGHT = ACCENT_LIGHT;
module.exports.ACCENT_DARK = ACCENT_DARK;
module.exports.ACCENT_HIGH_CONTRAST_LIGHT = ACCENT_HIGH_CONTRAST_LIGHT;
module.exports.ACCENT_HIGH_CONTRAST_DARK = ACCENT_HIGH_CONTRAST_DARK;
module.exports.IOS_ACCENT_BUILD_SETTING = IOS_ACCENT_BUILD_SETTING;
module.exports.buildAccentColorSetContents = buildAccentColorSetContents;
module.exports.writeAccentColorSet = writeAccentColorSet;
module.exports.setAccentColorBuildSetting = setAccentColorBuildSetting;
module.exports.applyAndroidAccentColor = applyAndroidAccentColor;
module.exports.applyAndroidAccentStyle = applyAndroidAccentStyle;
