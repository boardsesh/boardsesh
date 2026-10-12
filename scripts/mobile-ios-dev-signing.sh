#!/usr/bin/env bash
set -euo pipefail

# CI only. Secrets enter through environment variables, never command arguments.
for variable in IOS_P12_CERTIFICATE_BASE64 IOS_P12_PASSWORD IOS_DEV_APP_PROVISIONING_PROFILE_BASE64 IOS_DEV_WIDGETS_PROVISIONING_PROFILE_BASE64 IOS_DEV_SHARE_EXTENSION_PROVISIONING_PROFILE_BASE64 KEYCHAIN_NAME KEYCHAIN_PASSWORD; do
  if [ -z "${!variable:-}" ]; then
    echo "::error::Missing $variable; see docs/ios-dev-client-testflight.md."
    exit 1
  fi
done

security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME"
security set-keychain-settings -lut 21600 "$KEYCHAIN_NAME"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME"
certificate_path="$RUNNER_TEMP/ios-dev-certificate.p12"
printf '%s' "$IOS_P12_CERTIFICATE_BASE64" | base64 --decode > "$certificate_path"
security import "$certificate_path" -k "$KEYCHAIN_NAME" -P "$IOS_P12_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security
rm "$certificate_path"
security set-key-partition-list -S apple-tool:,apple: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME"
security list-keychains -d user -s "$KEYCHAIN_NAME" $(security list-keychains -d user | tr -d '"')

install_profile() {
  local variable="$1" expected_bundle_id="$2" output_name="$3" label="$4"
  local profile_path="$RUNNER_TEMP/ios-dev-${label}.mobileprovision"
  local plist_path="$RUNNER_TEMP/ios-dev-${label}.plist"
  local profiles_directory="$HOME/Library/MobileDevice/Provisioning Profiles"
  printf '%s' "${!variable}" | base64 --decode > "$profile_path"
  security cms -D -i "$profile_path" > "$plist_path"
  vp exec python3 - "$plist_path" "$expected_bundle_id" <<'PYTHON'
import datetime
import plistlib
import sys

with open(sys.argv[1], 'rb') as profile_file:
    profile = plistlib.load(profile_file)
entitlements = profile['Entitlements']
identifier = entitlements['application-identifier'].split('.', 1)[1]
if identifier != sys.argv[2]:
    raise SystemExit(f'Profile bundle ID {identifier} differs from {sys.argv[2]}')
if profile.get('ProvisionedDevices') or profile.get('ProvisionsAllDevices') or entitlements.get('get-task-allow'):
    raise SystemExit('An App Store Connect distribution profile is required, not development/ad hoc/enterprise')
if profile['ExpirationDate'] <= datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None):
    raise SystemExit('Provisioning profile has expired')
if '9L3HKPZBH3' not in profile.get('TeamIdentifier', []):
    raise SystemExit('Provisioning profile belongs to a different Apple team')
if 'group.com.boardsesh.app.dev' not in entitlements.get('com.apple.security.application-groups', []):
    raise SystemExit('Provisioning profile is missing the Dev App Group')
if sys.argv[2] == 'com.boardsesh.app.dev' and entitlements.get('aps-environment') != 'production':
    raise SystemExit('Dev TestFlight requires production APNs entitlement')
PYTHON
  local profile_uuid profile_name
  profile_uuid=$(/usr/libexec/PlistBuddy -c 'Print UUID' "$plist_path")
  profile_name=$(/usr/libexec/PlistBuddy -c 'Print Name' "$plist_path")
  mkdir -p "$profiles_directory"
  cp "$profile_path" "$profiles_directory/$profile_uuid.mobileprovision"
  export "$output_name=$profile_name"
  echo "$output_name=$profile_name" >> "$GITHUB_ENV"
  echo "Installed Dev profile: $expected_bundle_id"
}

install_profile IOS_DEV_APP_PROVISIONING_PROFILE_BASE64 com.boardsesh.app.dev IOS_DEV_APP_PROFILE_NAME app
install_profile IOS_DEV_WIDGETS_PROVISIONING_PROFILE_BASE64 com.boardsesh.app.dev.widgets IOS_DEV_WIDGETS_PROFILE_NAME widgets
install_profile IOS_DEV_SHARE_EXTENSION_PROVISIONING_PROFILE_BASE64 com.boardsesh.app.dev.share-extension IOS_DEV_SHARE_PROFILE_NAME share

bundle exec ruby <<'RUBY'
require 'xcodeproj'
projects = Dir.glob('packages/mobile/ios/*.xcodeproj')
raise 'Expected exactly one generated iOS project' unless projects.length == 1
project = Xcodeproj::Project.open(projects.first)
profiles = {
  'com.boardsesh.app.dev' => ENV.fetch('IOS_DEV_APP_PROFILE_NAME'),
  'com.boardsesh.app.dev.widgets' => ENV.fetch('IOS_DEV_WIDGETS_PROFILE_NAME'),
  'com.boardsesh.app.dev.share-extension' => ENV.fetch('IOS_DEV_SHARE_PROFILE_NAME'),
}
configured = []
project.targets.each do |target|
  target.build_configurations.each do |configuration|
    next unless configuration.name == 'Debug'
    bundle_id = configuration.build_settings['PRODUCT_BUNDLE_IDENTIFIER']
    next unless profiles.key?(bundle_id)
    settings = configuration.build_settings
    settings['CODE_SIGN_STYLE'] = 'Manual'
    settings['DEVELOPMENT_TEAM'] = '9L3HKPZBH3'
    settings['CODE_SIGN_IDENTITY'] = 'Apple Distribution'
    settings['PROVISIONING_PROFILE_SPECIFIER'] = profiles.fetch(bundle_id)
    settings['ONLY_ACTIVE_ARCH'] = 'NO'
    settings['ENABLE_DEBUG_DYLIB'] = 'NO'
    settings['DEBUG_INFORMATION_FORMAT'] = 'dwarf-with-dsym'
    configured << bundle_id
  end
end
missing = profiles.keys - configured
raise "Missing Debug targets for: #{missing.join(', ')}" unless missing.empty?
project.save
RUBY

vp exec python3 - <<'PYTHON'
import os
import plistlib

options = {
    'method': 'app-store-connect',
    'destination': 'upload',
    'teamID': '9L3HKPZBH3',
    'signingStyle': 'manual',
    'testFlightInternalTestingOnly': True,
    'uploadSymbols': True,
    'manageAppVersionAndBuildNumber': False,
    'provisioningProfiles': {
        'com.boardsesh.app.dev': os.environ['IOS_DEV_APP_PROFILE_NAME'],
        'com.boardsesh.app.dev.widgets': os.environ['IOS_DEV_WIDGETS_PROFILE_NAME'],
        'com.boardsesh.app.dev.share-extension': os.environ['IOS_DEV_SHARE_PROFILE_NAME'],
    },
}
with open(os.environ['EXPORT_OPTIONS_PLIST'], 'wb') as export_file:
    plistlib.dump(options, export_file)
PYTHON
