require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

# Objective-C++ pod with no Expo Module class. The app's AppDelegate imports it
# (added by plugins/with-scheduler-delegate-invalidation.js) and calls
# +[BoardseshReactFlagOverrides install] between the React Native factory's
# init and startReactNative.
Pod::Spec.new do |s|
  s.name                = 'BoardseshReactFlagOverrides'
  s.version             = package['version']
  s.summary             = package['description']
  s.homepage            = 'https://github.com/boardsesh/boardsesh'
  s.license             = package['license']
  s.author              = 'Boardsesh'
  s.source              = { git: 'https://github.com/boardsesh/boardsesh' }
  s.platforms           = { ios: '16.4' }
  s.source_files        = '*.{h,mm}'
  # Only the Objective-C header is public, so the generated umbrella header
  # (and the Swift module the AppDelegate imports) never pulls in C++.
  s.public_header_files = '*.h'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }

  # React Native's helper: React-Core / React-featureflags dependencies and the
  # C++ standard. In prebuilt-core mode (our default — RCT_USE_PREBUILT_RNCORE=1)
  # the react/featureflags headers resolve through React-Core-prebuilt's VFS
  # overlay and the symbols link from React.framework.
  install_modules_dependencies(s)
end
