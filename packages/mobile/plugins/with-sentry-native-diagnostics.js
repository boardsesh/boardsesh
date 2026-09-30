const { withAndroidManifest, withMainApplication, withAppDelegate } = require('expo/config-plugins');

// Runs after the official useNativeInit plugin. Fail prebuild if its insertion
// changes: silently falling back to late JS initialization loses startup crashes.
function guardAndroidInit(contents) {
  if (contents.includes('boardsesh native diagnostics')) return contents;
  if (!contents.includes('RNSentrySDK.init(this)')) throw new Error('Sentry native Android init was not generated');
  return contents.replace(
    /RNSentrySDK\.init\(this\);?/,
    `// boardsesh native diagnostics
    if (!BuildConfig.DEBUG) {
      val preferences = getSharedPreferences("boardsesh-diagnostics", MODE_PRIVATE)
      val previousStartupId = if (preferences.getBoolean("startupMarkerDurable", false)) preferences.getString("startupId", null) else null
      val startupId = java.util.UUID.randomUUID().toString()
      // Save once before SDK initialization so a successfully written marker
      // identifies a pre-JS crash. Failed writes leave attribution unknown.
      val startupMarkerDurable = preferences.edit().putString("previousStartupId", previousStartupId).putString("startupId", startupId).putBoolean("startupMarkerDurable", true).commit()
      if (!startupMarkerDurable) preferences.edit().putBoolean("startupMarkerDurable", false).apply()
      RNSentrySDK.init(this) { options -> options.setAttachRawTombstone(true) }
      io.sentry.Sentry.setTag("native_startup_id", startupId)
    }`,
  );
}
function guardIosInit(contents) {
  if (contents.includes('boardsesh native diagnostics')) return contents;
  if (!contents.includes('RNSentrySDK.start()')) throw new Error('Sentry native iOS init was not generated');
  const guarded = contents.replace(
    'RNSentrySDK.start()',
    `// boardsesh native diagnostics
    #if !DEBUG
    let previousStartupId = UserDefaults.standard.bool(forKey: "boardsesh.diagnostics.startupMarkerDurable") ? UserDefaults.standard.string(forKey: "boardsesh.diagnostics.startupId") : nil
    UserDefaults.standard.set(previousStartupId, forKey: "boardsesh.diagnostics.previousStartupId")
    let startupId = UUID().uuidString
    UserDefaults.standard.set(startupId, forKey: "boardsesh.diagnostics.startupId")
    // One best-effort startup flush before SDK initialization, not per-operation I/O.
    // Apple documents synchronize() as awaiting pending defaults writes and returning
    // disk-write success; this is not an fsync or power-loss durability guarantee.
    UserDefaults.standard.set(true, forKey: "boardsesh.diagnostics.startupMarkerDurable")
    if !UserDefaults.standard.synchronize() {
      UserDefaults.standard.set(false, forKey: "boardsesh.diagnostics.startupMarkerDurable")
    }
    RNSentrySDK.start()
    SentrySDK.configureScope { $0.setTag(value: startupId, key: "native_startup_id") }
    #endif`,
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
