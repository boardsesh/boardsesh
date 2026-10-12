import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

type WidgetTargetConfig = {
  deploymentTarget: string;
  xcodeProjectSettings?: unknown;
};

type CapturingTarget = {
  isa: 'PBXNativeTarget';
  props: {
    name: string;
    productName: string;
  };
  setBuildSetting(settingName: string, settingValue: string): void;
};

type CapturingProject = {
  rootObject: {
    props: {
      targets: CapturingTarget[];
    };
  };
};

type WidgetBuildSettingsPlugin = {
  configureBoardseshWidgetTarget(project: CapturingProject, hostBundleIdentifier?: string): void;
  WIDGET_DEPLOYMENT_TARGET: string;
  WIDGET_SWIFT_FLAGS: string;
};

const widgetTargetConfig = require('../../../../targets/BoardseshWidgets/expo-target.config.js') as WidgetTargetConfig;
const widgetBuildSettingsPlugin =
  require('../../../../plugins/with-boardsesh-widget-build-settings.js') as WidgetBuildSettingsPlugin;

describe('BoardseshWidgets prebuild settings', () => {
  it('embeds immutable identity keys in the actual widget plist using build variables', () => {
    const widgetInfoPlist = readFileSync(
      new URL('../../../../targets/BoardseshWidgets/Info.plist', import.meta.url),
      'utf8',
    );
    expect(widgetInfoPlist).toContain('<key>BoardseshHostBundleIdentifier</key>');
    expect(widgetInfoPlist).toContain('<string>$(BOARDSESH_HOST_BUNDLE_IDENTIFIER)</string>');
    expect(widgetInfoPlist).toContain('<key>BoardseshAppGroupIdentifier</key>');
    expect(widgetInfoPlist).toContain('<string>$(BOARDSESH_APP_GROUP_IDENTIFIER)</string>');
    expect(widgetInfoPlist).toContain('<key>BoardseshKeychainAccessGroup</key>');
    expect(widgetInfoPlist).toContain('<string>$(AppIdentifierPrefix)$(BOARDSESH_APP_GROUP_IDENTIFIER)</string>');
  });

  it('targets iOS 17 for the AppIntents-backed Live Activity widget', () => {
    expect(widgetTargetConfig.deploymentTarget).toBe(widgetBuildSettingsPlugin.WIDGET_DEPLOYMENT_TARGET);
    expect(widgetTargetConfig.xcodeProjectSettings).toBeUndefined();
  });

  it.each(['com.boardsesh.app', 'com.boardsesh.app.dev'])(
    'configures flags and immutable identity for %s',
    (hostBundleIdentifier) => {
      const capturedBuildSettings: Record<string, string> = {};
      const boardseshWidgetsTarget: CapturingTarget = {
        isa: 'PBXNativeTarget',
        props: {
          name: 'BoardseshWidgets',
          productName: 'BoardseshWidgets',
        },
        setBuildSetting(settingName, settingValue) {
          capturedBuildSettings[settingName] = settingValue;
        },
      };

      widgetBuildSettingsPlugin.configureBoardseshWidgetTarget(
        {
          rootObject: {
            props: {
              targets: [boardseshWidgetsTarget],
            },
          },
        },
        hostBundleIdentifier,
      );

      expect(capturedBuildSettings.BOARDSESH_HOST_BUNDLE_IDENTIFIER).toBe(hostBundleIdentifier);
      expect(capturedBuildSettings.BOARDSESH_APP_GROUP_IDENTIFIER).toBe(`group.${hostBundleIdentifier}`);
      expect(capturedBuildSettings.OTHER_SWIFT_FLAGS).toBe(widgetBuildSettingsPlugin.WIDGET_SWIFT_FLAGS);
      expect(capturedBuildSettings.IPHONEOS_DEPLOYMENT_TARGET).toBe(widgetBuildSettingsPlugin.WIDGET_DEPLOYMENT_TARGET);
    },
  );
});
