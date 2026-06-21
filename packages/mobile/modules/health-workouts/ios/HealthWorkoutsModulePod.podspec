require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'HealthWorkoutsModulePod'
  s.version        = package['version']
  s.summary        = package['description']
  s.homepage       = 'https://github.com/boardsesh/boardsesh'
  s.license        = package['license']
  s.author         = 'Boardsesh'
  s.source         = { git: 'https://github.com/boardsesh/boardsesh' }
  s.platforms      = { ios: '16.4' }
  s.swift_version  = '5.9'
  s.source_files   = '*.swift'
  s.frameworks     = 'HealthKit'
  s.dependency 'ExpoModulesCore'
end
