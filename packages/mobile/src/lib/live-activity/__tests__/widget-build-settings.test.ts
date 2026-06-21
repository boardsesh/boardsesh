import { createRequire } from 'node:module';

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
  configureBoardseshWidgetTarget(project: CapturingProject): void;
  WIDGET_DEPLOYMENT_TARGET: string;
  WIDGET_SWIFT_FLAGS: string;
};

const widgetTargetConfig = require('../../../../targets/BoardseshWidgets/expo-target.config.js') as WidgetTargetConfig;
const widgetBuildSettingsPlugin =
  require('../../../../plugins/with-boardsesh-widget-build-settings.js') as WidgetBuildSettingsPlugin;

describe('BoardseshWidgets prebuild settings', () => {
  it('targets iOS 17 for the AppIntents-backed Live Activity widget', () => {
    expect(widgetTargetConfig.deploymentTarget).toBe(widgetBuildSettingsPlugin.WIDGET_DEPLOYMENT_TARGET);
    expect(widgetTargetConfig.xcodeProjectSettings).toBeUndefined();
  });

  it('adds the widget Swift flag to the generated Xcode target', () => {
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

    widgetBuildSettingsPlugin.configureBoardseshWidgetTarget({
      rootObject: {
        props: {
          targets: [boardseshWidgetsTarget],
        },
      },
    });

    expect(capturedBuildSettings.OTHER_SWIFT_FLAGS).toBe(widgetBuildSettingsPlugin.WIDGET_SWIFT_FLAGS);
    expect(capturedBuildSettings.IPHONEOS_DEPLOYMENT_TARGET).toBe(widgetBuildSettingsPlugin.WIDGET_DEPLOYMENT_TARGET);
  });
});
