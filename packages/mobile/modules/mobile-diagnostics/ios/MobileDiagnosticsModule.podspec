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
  s.dependency 'ExpoModulesCore'
end
