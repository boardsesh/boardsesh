const { createRunOncePlugin, withAppDelegate, withMainApplication } = require('expo/config-plugins');

// Public RN SDK initialization APIs keep the React Native defaults (including
// duplicate-JS-crash filtering) and chain these callbacks after native enrichment.
// JS must use autoInitializeNativeSdk:false, otherwise its later initialization
// replaces these callbacks. This changes generated app code, never SDK sources.
const BEGIN = '// @generated begin boardsesh-sentry-privacy';
const END = '// @generated end boardsesh-sentry-privacy';
const ENVIRONMENT_TAG = 'boardsesh_environment';

function removeGeneratedBlock(contents) {
  const hasBegin = contents.includes(BEGIN);
  const hasEnd = contents.includes(END);
  if (hasBegin !== hasEnd) throw new Error('with-sentry-native-privacy: incomplete generated startup block');
  return contents.replace(
    /^[ \t]*\/\/ @generated begin boardsesh-sentry-privacy[\s\S]*?^[ \t]*\/\/ @generated end boardsesh-sentry-privacy[ \t]*\r?\n?/gm,
    '',
  );
}

function hasControlCharacters(contents) {
  return Array.from(contents).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint < 32 || codePoint === 127;
  });
}

function resolveOptions({ dsn, environment = 'production' } = {}) {
  if (dsn !== undefined && typeof dsn !== 'string') throw new Error('with-sentry-native-privacy: DSN must be a string');
  const normalizedDsn = dsn?.trim();
  if (!normalizedDsn) return null;
  if (hasControlCharacters(normalizedDsn)) {
    throw new Error('with-sentry-native-privacy: DSN must not contain control characters');
  }
  const parsedDsn = new URL(normalizedDsn);
  if (!['http:', 'https:'].includes(parsedDsn.protocol) || !parsedDsn.username || !parsedDsn.pathname.slice(1)) {
    throw new Error('with-sentry-native-privacy: DSN must be an HTTP(S) Sentry project DSN');
  }
  if (typeof environment !== 'string' || hasControlCharacters(environment)) {
    throw new Error('with-sentry-native-privacy: environment must be a string without control characters');
  }
  return { dsn: normalizedDsn, environment: environment || 'production' };
}

function kotlinLiteral(contents) {
  // Kotlin interpolates $ even inside a quoted literal.
  return JSON.stringify(contents).replace(/\$/g, '\\$');
}

function addImport(contents, importLine, anchor) {
  if (contents.includes(importLine)) return contents;
  if (!anchor.test(contents)) throw new Error(`with-sentry-native-privacy: missing import anchor for ${importLine}`);
  return contents.replace(anchor, (line) => `${line}\n${importLine}`);
}

/** @param {string} contents @param {{dsn?: string, environment?: string}} options */
function applySwiftSentryPrivacy(contents, options) {
  const source = removeGeneratedBlock(contents);
  const resolved = resolveOptions(options);
  if (!resolved) return source;
  const launch = /^([ \t]*)(?:public\s+)?override func application\([\s\S]*?\) -> Bool \{[ \t]*\r?\n/m.exec(source);
  if (!launch) throw new Error('with-sentry-native-privacy: missing Swift application launch method');
  const indent = `${launch[1]}  `;
  const block = [
    BEGIN,
    '#if !DEBUG',
    'RNSentrySDK.start(configureOptions: { options in',
    `  options.dsn = ${JSON.stringify(resolved.dsn)}`,
    `  options.environment = ${JSON.stringify(resolved.environment)}`,
    '  options.sendDefaultPii = false',
    '  options.enableCrashHandler = true',
    '  options.enableAppHangTracking = true',
    '  options.appHangTimeoutInterval = 2',
    '  options.attachStacktrace = true',
    '  options.beforeSend = { event in',
    '    event.user = nil',
    '    if var context = event.context, var device = context["device"] {',
    '      device.removeValue(forKey: "id")',
    '      context["device"] = device',
    '      event.context = context',
    '    }',
    `    if let environment = event.tags?["${ENVIRONMENT_TAG}"] {`,
    '      event.environment = environment',
    '    }',
    '    return event',
    '  }',
    '})',
    '#endif',
    END,
  ]
    .map((line) => `${indent}${line}`)
    .join('\n');
  const insertAt = launch.index + launch[0].length;
  return addImport(
    `${source.slice(0, insertAt)}${block}\n${source.slice(insertAt)}`,
    'import RNSentry',
    /^import \S+.*$/m,
  );
}

/** @param {string} contents @param {{dsn?: string, environment?: string}} options */
function applyKotlinSentryPrivacy(contents, options) {
  const source = removeGeneratedBlock(contents);
  const resolved = resolveOptions(options);
  if (!resolved) return source;
  const launch = /^([ \t]*)override fun onCreate\(\) \{[ \t]*\r?\n([ \t]*)super\.onCreate\(\)[ \t]*\r?\n/m.exec(source);
  if (!launch) throw new Error('with-sentry-native-privacy: missing Kotlin onCreate/super.onCreate startup anchor');
  const indent = launch[2];
  const block = [
    BEGIN,
    'if (!BuildConfig.DEBUG) {',
    '  RNSentrySDK.init(this) { options ->',
    `    options.dsn = ${kotlinLiteral(resolved.dsn)}`,
    `    options.environment = ${kotlinLiteral(resolved.environment)}`,
    '    options.isSendDefaultPii = false',
    '    options.isAnrEnabled = true',
    '    options.isAttachStacktrace = true',
    '    options.setBeforeSend { event, _ ->',
    '      event.user = null',
    '      event.contexts.device?.id = null',
    `      event.getTag("${ENVIRONMENT_TAG}")?.let { event.environment = it }`,
    '      event',
    '    }',
    '    options.setBeforeSendTransaction { transaction, _ ->',
    '      transaction.user = null',
    '      transaction.contexts.device?.id = null',
    `      transaction.getTag("${ENVIRONMENT_TAG}")?.let { transaction.environment = it }`,
    '      transaction',
    '    }',
    '  }',
    '}',
    END,
  ]
    .map((line) => `${indent}${line}`)
    .join('\n');
  const insertAt = launch.index + launch[0].length;
  return addImport(
    `${source.slice(0, insertAt)}${block}\n${source.slice(insertAt)}`,
    'import io.sentry.react.RNSentrySDK',
    /^package [\w.]+[ \t]*$/m,
  );
}

function withSentryNativePrivacy(config, options) {
  let nextConfig = withAppDelegate(config, (modConfig) => {
    if (modConfig.modResults.language !== 'swift')
      throw new Error('with-sentry-native-privacy: expected Swift AppDelegate');
    modConfig.modResults.contents = applySwiftSentryPrivacy(modConfig.modResults.contents, options);
    return modConfig;
  });
  nextConfig = withMainApplication(nextConfig, (modConfig) => {
    if (modConfig.modResults.language !== 'kt')
      throw new Error('with-sentry-native-privacy: expected Kotlin MainApplication');
    modConfig.modResults.contents = applyKotlinSentryPrivacy(modConfig.modResults.contents, options);
    return modConfig;
  });
  return nextConfig;
}

module.exports = createRunOncePlugin(withSentryNativePrivacy, 'with-sentry-native-privacy', '1.0.0');
module.exports.applySwiftSentryPrivacy = applySwiftSentryPrivacy;
module.exports.applyKotlinSentryPrivacy = applyKotlinSentryPrivacy;
module.exports.ENVIRONMENT_TAG = ENVIRONMENT_TAG;
