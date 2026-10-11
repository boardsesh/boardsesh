const { withAndroidManifest, withMainApplication, withAppDelegate } = require('expo/config-plugins');

// Decorate the current privacy initializer. Keep one SDK start and all native
// redaction callbacks; startup markers must exist before that same SDK start.
function guardAndroidInit(contents) {
  if (contents.includes('boardsesh native diagnostics')) return contents;
  if (
    !contents.includes('// @generated begin boardsesh-sentry-privacy') ||
    !contents.includes('RNSentrySDK.init(this) { options ->')
  )
    throw new Error('Sentry native Android privacy init was not generated');
  const guarded = contents.replace(/([ \t]*)RNSentrySDK\.init\(this\) \{ options ->/, (_, indent) =>
    [
      '// boardsesh native diagnostics',
      'val preferences = getSharedPreferences("boardsesh-diagnostics", MODE_PRIVATE)',
      'val previousStartupId = if (preferences.getBoolean("startupMarkerDurable", false)) preferences.getString("startupId", null) else null',
      'val startupId = java.util.UUID.randomUUID().toString()',
      'val startupMarkerDurable = preferences.edit().putString("previousStartupId", previousStartupId).putString("startupId", startupId).putBoolean("startupMarkerDurable", true).commit()',
      'if (!startupMarkerDurable) preferences.edit().putBoolean("startupMarkerDurable", false).apply()',
      'RNSentrySDK.init(this) { options ->',
      '  options.setAttachRawTombstone(true)',
    ]
      .map((line) => `${indent}${line}`)
      .join('\n'),
  );
  return guarded.replace(
    /\n([ \t]*)\}\n([ \t]*)\}\n([ \t]*)\/\/ @generated end boardsesh-sentry-privacy/,
    '\n$1}\n$1io.sentry.Sentry.setTag("native_startup_id", startupId)\n$2}\n$3// @generated end boardsesh-sentry-privacy',
  );
}
function guardIosInit(contents) {
  if (contents.includes('boardsesh native diagnostics')) return contents;
  if (
    !contents.includes('// @generated begin boardsesh-sentry-privacy') ||
    !contents.includes('RNSentryStart.start(options: options)')
  )
    throw new Error('Sentry native iOS privacy init was not generated');
  const guarded = contents
    .replace(/([ \t]*)do \{\n([ \t]*)let options = try RNSentryStart\.createOptions/, (_, indent, optionsIndent) =>
      [
        `${indent}// boardsesh native diagnostics`,
        `${indent}let previousStartupId = UserDefaults.standard.bool(forKey: "boardsesh.diagnostics.startupMarkerDurable") ? UserDefaults.standard.string(forKey: "boardsesh.diagnostics.startupId") : nil`,
        `${indent}UserDefaults.standard.set(previousStartupId, forKey: "boardsesh.diagnostics.previousStartupId")`,
        `${indent}let startupId = UUID().uuidString`,
        `${indent}UserDefaults.standard.set(startupId, forKey: "boardsesh.diagnostics.startupId")`,
        `${indent}UserDefaults.standard.set(true, forKey: "boardsesh.diagnostics.startupMarkerDurable")`,
        `${indent}if !UserDefaults.standard.synchronize() {`,
        `${indent}  UserDefaults.standard.set(false, forKey: "boardsesh.diagnostics.startupMarkerDurable")`,
        `${indent}}`,
        `${indent}do {`,
        `${optionsIndent}let options = try RNSentryStart.createOptions`,
      ].join('\n'),
    )
    .replace(
      /([ \t]*)RNSentryStart\.start\(options: options\)/,
      '$1RNSentryStart.start(options: options)\n$1SentrySDK.configureScope { $0.setTag(value: startupId, key: "native_startup_id") }',
    );
  return guarded.includes('import Sentry\n')
    ? guarded
    : guarded.replace('import RNSentry', 'import RNSentry\nimport Sentry');
}
function withSentryNativeDiagnostics(config) {
  config = withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application?.[0];
    if (!application) throw new Error('Android manifest missing application');
    const entries = application['meta-data'] ?? [];
    // No manifest auto-init before our release guard (SDK provider normally disabled by RN).
    for (const [name, value] of Object.entries({
      'io.sentry.auto-init': 'false',
      'io.sentry.tombstone.enable': 'true',
      'io.sentry.tombstone.attach-raw': 'true',
      'io.sentry.tombstone.report-historical': 'false',
    })) {
      const existing = entries.find((entry) => entry.$?.['android:name'] === name);
      if (existing) existing.$['android:value'] = value;
      else entries.push({ $: { 'android:name': name, 'android:value': value } });
    }
    application['meta-data'] = entries;
    return mod;
  });
  config = withMainApplication(config, (mod) => {
    if (mod.modResults.language !== 'kt') throw new Error('Expected Kotlin MainApplication for Sentry guard');
    mod.modResults.contents = guardAndroidInit(mod.modResults.contents);
    return mod;
  });
  return withAppDelegate(config, (mod) => {
    if (mod.modResults.language !== 'swift') throw new Error('Expected Swift AppDelegate for Sentry guard');
    mod.modResults.contents = guardIosInit(mod.modResults.contents);
    return mod;
  });
}
module.exports = withSentryNativeDiagnostics;
module.exports.guardAndroidInit = guardAndroidInit;
module.exports.guardIosInit = guardIosInit;
