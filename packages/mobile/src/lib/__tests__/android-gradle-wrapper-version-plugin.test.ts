import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

type AndroidGradleWrapperVersionPlugin = {
  applyAndroidGradleWrapperVersion(contents: string): string;
  DISTRIBUTION_URL: string;
  GRADLE_VERSION: string;
};

const plugin = require('../../../plugins/with-android-gradle-wrapper-version.js') as AndroidGradleWrapperVersionPlugin;

describe('with-android-gradle-wrapper-version', () => {
  it('pins an existing distributionUrl to the supported Gradle runtime', () => {
    const result = plugin.applyAndroidGradleWrapperVersion(
      [
        'distributionBase=GRADLE_USER_HOME',
        'distributionPath=wrapper/dists',
        'distributionUrl=https\\://services.gradle.org/distributions/gradle-9.3.1-bin.zip',
        'zipStoreBase=GRADLE_USER_HOME',
      ].join('\n'),
    );

    expect(result).toContain(`distributionUrl=${plugin.DISTRIBUTION_URL}`);
    expect(result).toContain('zipStoreBase=GRADLE_USER_HOME');
    expect(result).not.toContain('gradle-9.3.1');
  });

  it('appends distributionUrl when the wrapper file is missing it', () => {
    const result = plugin.applyAndroidGradleWrapperVersion('distributionBase=GRADLE_USER_HOME\n');

    expect(result).toBe(`distributionBase=GRADLE_USER_HOME\ndistributionUrl=${plugin.DISTRIBUTION_URL}\n`);
  });

  it('documents the Gradle version being pinned', () => {
    expect(plugin.GRADLE_VERSION).toBe('8.14.3');
  });
});
