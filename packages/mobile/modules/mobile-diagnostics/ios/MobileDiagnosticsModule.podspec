Pod::Spec.new do |s|
  s.name = 'MobileDiagnosticsModule'
  s.version = '0.1.0'
  s.summary = 'Release-only native crash verification and startup correlation'
  s.homepage = 'https://github.com/boardsesh/boardsesh'
  s.license = 'MIT'
  s.author = 'Boardsesh'
  s.source = { git: 'https://github.com/boardsesh/boardsesh' }
  s.platforms = { ios: '15.1' }
  s.swift_version = '5.9'
  s.source_files = '*.swift', '*.c', '*.h'
  s.pod_target_xcconfig = {
    # RNSentry's prebuilt Cocoa framework paths do not propagate to module targets.
    'FRAMEWORK_SEARCH_PATHS[sdk=iphoneos*]' => '$(inherited) "$(PODS_ROOT)/sentry-xcframeworks/9.29.0/Sentry.xcframework/ios-arm64_arm64e"',
    'FRAMEWORK_SEARCH_PATHS[sdk=iphonesimulator*]' => '$(inherited) "$(PODS_ROOT)/sentry-xcframeworks/9.29.0/Sentry.xcframework/ios-arm64_x86_64-simulator"'
  }
  s.dependency 'RNSentry'
  s.dependency 'ExpoModulesCore'
end
