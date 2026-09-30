require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'BoardRendererModule'
  s.version        = package['version']
  s.summary        = package['description']
  s.homepage       = 'https://github.com/boardsesh/boardsesh'
  s.license        = package['license']
  s.author         = 'Boardsesh'
  s.source         = { git: 'https://github.com/boardsesh/boardsesh' }
  s.platforms      = { ios: '15.1' }
  s.swift_version  = '5.9'
  s.source_files   = '*.swift', '*.h'
  s.vendored_frameworks = 'BoardRendererNative.xcframework'
  s.public_header_files = 'include/board_renderer.h'
  s.preserve_paths = 'include/board_renderer.h'
  s.pod_target_xcconfig = {
    # RNSentry 8.28 uses a prebuilt Cocoa SDK, not a Sentry CocoaPod. Its
    # custom pod search paths do not propagate into dependent module targets.
    'FRAMEWORK_SEARCH_PATHS[sdk=iphoneos*]' => '$(inherited) "$(PODS_ROOT)/sentry-xcframeworks/9.29.0/Sentry.xcframework/ios-arm64_arm64e"',
    'FRAMEWORK_SEARCH_PATHS[sdk=iphonesimulator*]' => '$(inherited) "$(PODS_ROOT)/sentry-xcframeworks/9.29.0/Sentry.xcframework/ios-arm64_x86_64-simulator"',
    'HEADER_SEARCH_PATHS' => '"$(PODS_TARGET_SRCROOT)/include"',
    'OTHER_LDFLAGS' => '-lboard_renderer_ffi'
  }
  s.dependency 'ExpoModulesCore'
  s.dependency 'RNSentry'
end
