import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

type CapturingTarget = {
  isa: 'PBXNativeTarget';
  props: {
    name?: string;
    productName?: string;
    productType?: string;
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

type IosAppStoreBuildSettingsPlugin = {
  configureIosAppStoreBuildSettings(project: CapturingProject): void;
  IOS_APPLICATION_PRODUCT_TYPE: string;
  MAC_DESIGNED_FOR_IPHONE_IPAD_BUILD_SETTING: string;
  MAC_DESIGNED_FOR_IPHONE_IPAD_DISABLED: string;
};

const appStoreBuildSettingsPlugin =
  require('../../../plugins/with-ios-app-store-build-settings.js') as IosAppStoreBuildSettingsPlugin;

function createCapturingTarget(props: CapturingTarget['props']): {
  capturedBuildSettings: Record<string, string>;
  target: CapturingTarget;
} {
  const capturedBuildSettings: Record<string, string> = {};

  return {
    capturedBuildSettings,
    target: {
      isa: 'PBXNativeTarget',
      props,
      setBuildSetting(settingName, settingValue) {
        capturedBuildSettings[settingName] = settingValue;
      },
    },
  };
}

describe('iOS App Store prebuild settings', () => {
  it('opts the Boardsesh app target out of Mac Designed for iPhone/iPad availability', () => {
    const boardseshTarget = createCapturingTarget({
      name: 'Boardsesh',
      productName: 'Boardsesh',
      productType: appStoreBuildSettingsPlugin.IOS_APPLICATION_PRODUCT_TYPE,
    });
    const widgetTarget = createCapturingTarget({
      name: 'BoardseshWidgets',
      productName: 'BoardseshWidgets',
      productType: 'com.apple.product-type.app-extension',
    });

    appStoreBuildSettingsPlugin.configureIosAppStoreBuildSettings({
      rootObject: {
        props: {
          targets: [boardseshTarget.target, widgetTarget.target],
        },
      },
    });

    expect(
      boardseshTarget.capturedBuildSettings[appStoreBuildSettingsPlugin.MAC_DESIGNED_FOR_IPHONE_IPAD_BUILD_SETTING],
    ).toBe(appStoreBuildSettingsPlugin.MAC_DESIGNED_FOR_IPHONE_IPAD_DISABLED);
    expect(widgetTarget.capturedBuildSettings).toEqual({});
  });

  it('uses the only iOS application target when Expo generates a variant target name', () => {
    const devVariantTarget = createCapturingTarget({
      name: 'Boardsesh Dev',
      productName: 'Boardsesh Dev',
      productType: appStoreBuildSettingsPlugin.IOS_APPLICATION_PRODUCT_TYPE,
    });

    appStoreBuildSettingsPlugin.configureIosAppStoreBuildSettings({
      rootObject: {
        props: {
          targets: [devVariantTarget.target],
        },
      },
    });

    expect(
      devVariantTarget.capturedBuildSettings[appStoreBuildSettingsPlugin.MAC_DESIGNED_FOR_IPHONE_IPAD_BUILD_SETTING],
    ).toBe(appStoreBuildSettingsPlugin.MAC_DESIGNED_FOR_IPHONE_IPAD_DISABLED);
  });
});
