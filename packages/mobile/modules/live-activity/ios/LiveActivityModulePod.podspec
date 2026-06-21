require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'LiveActivityModulePod'
  s.version        = package['version']
  s.summary        = package['description']
  s.homepage       = 'https://github.com/boardsesh/boardsesh'
  s.license        = package['license']
  s.author         = 'Boardsesh'
  s.source         = { git: 'https://github.com/boardsesh/boardsesh' }
  s.platforms      = { ios: '16.4' }
  s.swift_version  = '5.9'
  s.source_files   = '*.swift'
  s.frameworks     = 'ActivityKit', 'CoreBluetooth', 'WidgetKit', 'AppIntents'
  s.dependency 'ExpoModulesCore'
  # libwebp-backed coder for the bundled board-background webp(s) composited into
  # Live Activity thumbnails. expo-image already pins SDWebImageWebPCoder, so this
  # (left unpinned) unifies on the same resolved pod — no duplicate libwebp. Needed
  # because Apple ImageIO (UIImage(contentsOfFile:)) can't decode the lossy VP8 webp.
  s.dependency 'SDWebImageWebPCoder'
end
