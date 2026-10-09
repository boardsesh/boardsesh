require 'json'
package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))
Pod::Spec.new do |spec|
  spec.name = 'MobileCpuProfile'
  spec.version = package['version']
  spec.summary = package['description']
  spec.homepage = 'https://github.com/boardsesh/boardsesh'
  spec.license = package['license']
  spec.author = 'Boardsesh'
  spec.source = { git: 'https://github.com/boardsesh/boardsesh' }
  spec.platforms = { ios: '16.4' }
  spec.swift_version = '5.9'
  spec.source_files = '*.swift'
  spec.dependency 'ExpoModulesCore'
end
