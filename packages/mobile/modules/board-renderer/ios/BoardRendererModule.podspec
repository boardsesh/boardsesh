# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Boardsesh

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
    'HEADER_SEARCH_PATHS' => '"$(PODS_TARGET_SRCROOT)/include"',
    'OTHER_LDFLAGS' => '-lboard_renderer_ffi'
  }
  s.dependency 'ExpoModulesCore'
end
