# frozen_string_literal: true

require "minitest/autorun"
require "tmpdir"
require "fileutils"
require "json"
require_relative "../lib/app_store_version_states"

# Execute the actual lane blocks without loading Fastlane or contacting stores.
module UI
  def self.user_error!(message)
    raise message
  end

  def self.message(_message); end
  def self.success(_message); end
  def self.important(_message); end
end

# `require "spaceship"` in a lane resolves to this empty file, so the stand-ins
# below are all the lane sees of App Store Connect.
SPACESHIP_STUB_DIRECTORY = Dir.mktmpdir("spaceship-stub-")
File.write(File.join(SPACESHIP_STUB_DIRECTORY, "spaceship.rb"), "# Stand-ins live in native_upload_lanes_test.rb\n")
$LOAD_PATH.unshift(SPACESHIP_STUB_DIRECTORY)
Minitest.after_run { FileUtils.remove_entry(SPACESHIP_STUB_DIRECTORY) }

module Spaceship
  module ConnectAPI
    module Platform
      IOS = "IOS"
    end

    class App
      class << self
        attr_accessor :current
      end

      def self.find(_bundle_identifier)
        current
      end
    end
  end
end

module FastlaneCore
  class BuildWatcher
    class << self
      attr_accessor :processed_build
    end

    def self.wait_for_build_processing_to_be_complete(**_options)
      processed_build
    end
  end
end

module BoardseshASC
  class Client
    class << self
      attr_accessor :app_store_versions, :listed_paths
    end

    def initialize(token:)
      @token = token
    end

    def list(path)
      (self.class.listed_paths ||= []) << path
      self.class.app_store_versions
    end
  end
end

FakeEditVersion = Struct.new(:version_string, :selected_build_id) do
  def select_build(build_id:)
    self.selected_build_id = build_id
  end
end

FakeApp = Struct.new(:id, :edit_version) do
  # Spaceship defaults the platform to iOS; the metadata lane relies on that.
  def get_edit_app_store_version(platform: Spaceship::ConnectAPI::Platform::IOS)
    edit_version if platform == Spaceship::ConnectAPI::Platform::IOS
  end
end

FakeBuild = Struct.new(:id, :app_version, :version)

# What the metadata lane's editable-version check reads from Spaceship.
FakeEditableVersion = Struct.new(:version_string, :app_version_state, :app_store_state)

module BoardseshPlayListing
  class Error < StandardError; end

  class Runner
    class << self
      attr_accessor :received, :staged_files
    end

    def initialize(**options)
      self.class.received = options
      # The screenshots lane removes its staging folder afterwards; record it now.
      root = options.fetch(:metadata_path)
      self.class.staged_files = Dir.glob(File.join(root, "**", "*.png")).map { |path| path.delete_prefix("#{root}/") }.sort
    end

    def run
      { "action" => "committed", "parts" => self.class.received.fetch(:parts), "languages" => ["en-US"], "changes" => [] }
    end
  end
end

module BoardseshAndroidRelease
  class Error < StandardError; end

  class Runner
    class << self
      attr_accessor :received
    end

    def initialize(**options)
      self.class.received = options
    end

    def run
      { "action" => "committed", "publicationVerified" => false }
    end
  end
end

class NativeUploadLanesTest < Minitest::Test
  module LaneDsl
    attr_reader :lanes, :commands, :app_store_uploads

    def opt_out_usage; end
    def default_platform(_platform); end
    def desc(_description); end

    def platform(name)
      @platform = name
      yield
    end

    def lane(name, &block)
      (@lanes ||= {})[[@platform, name]] = block
    end

    def sh(*arguments)
      (@commands ||= []) << arguments
    end

    def app_store_connect_api_key(**options)
      { key_id: options.fetch(:key_id) }
    end

    def upload_to_app_store(**options)
      (@app_store_uploads ||= []) << options
    end
  end

  def setup
    @original_env = ENV.to_h
    @root = Dir.mktmpdir("native-upload-lanes-")
    @fastlane_directory = File.join(@root, "fastlane")
    FileUtils.mkdir_p(File.join(@fastlane_directory, "lib"))
    File.write(File.join(@fastlane_directory, "lib", "android_release.rb"), "# Stubbed runner above\n")
    File.write(File.join(@fastlane_directory, "lib", "play_listing.rb"), "# Stubbed runner above\n")
    # Pure constants, required for real at the top of this file.
    File.write(File.join(@fastlane_directory, "lib", "app_store_version_states.rb"), "# Real constants loaded above\n")
    @dsl = Module.new
    @dsl.extend(LaneDsl)
    @dsl.module_eval(File.read(File.expand_path("../Fastfile", __dir__)), File.join(@fastlane_directory, "Fastfile"))
    BoardseshAndroidRelease::Runner.received = nil
    BoardseshPlayListing::Runner.received = nil
    BoardseshPlayListing::Runner.staged_files = nil
    # Lanes append to the run summary when one exists; keep test runs out of it.
    ENV.delete("GITHUB_STEP_SUMMARY")
  end

  def teardown
    ENV.replace(@original_env)
    FileUtils.remove_entry(@root)
  end

  def app_store_version(version_string, state, platform: "IOS", state_attribute: "appVersionState")
    { "type" => "appStoreVersions", "attributes" => { "versionString" => version_string, "platform" => platform, state_attribute => state } }
  end

  # Runs the iOS draft lane for 2.7.1 against the given App Store versions. The
  # Fastfile's helper methods are module instance methods, so the lane's `self`
  # (the module) extends itself to reach them, as fastlane's runner can.
  def run_ios_draft(app_store_versions, edit_version: FakeEditVersion.new("2.7.1"))
    File.write(File.join(@fastlane_directory, "lib", "asc_client.rb"), "# Stubbed client above\n")
    @dsl.extend(@dsl)
    ENV["APP_STORE_CONNECT_API_KEY_ID"] = "FAKEKEY123"
    ENV["APP_STORE_CONNECT_ISSUER_ID"] = "fake-issuer"
    ENV["ASC_KEY_PATH"] = "/nonexistent/AuthKey_FAKEKEY123.p8"
    ENV["RELEASE_VERSION"] = "2.7.1"
    ENV["IOS_BUILD_NUMBER"] = "4"
    BoardseshASC::Client.app_store_versions = app_store_versions
    BoardseshASC::Client.listed_paths = nil
    Spaceship::ConnectAPI::App.current = FakeApp.new("app-1", edit_version)
    FastlaneCore::BuildWatcher.processed_build = FakeBuild.new("build-4", "2.7.1", "4")
    Dir.chdir(@fastlane_directory) { @dsl.lanes.fetch([:ios, :draft_submission]).call }
  end

  # deliver renames the editable version to the version it is asked to draft, so
  # a train draft of 2.7.1 would silently retitle the 2.7.0 someone is about to
  # submit. The lane must refuse before deliver ever runs.
  def test_ios_draft_refuses_to_rename_another_open_version
    %w[PREPARE_FOR_SUBMISSION DEVELOPER_REJECTED REJECTED METADATA_REJECTED INVALID_BINARY
       READY_FOR_REVIEW WAITING_FOR_REVIEW IN_REVIEW].each do |state|
      error = assert_raises(RuntimeError, state) do
        run_ios_draft([app_store_version("2.6.0", "READY_FOR_DISTRIBUTION"), app_store_version("2.7.0", state)])
      end
      assert_includes error.message, "unreleased iOS version 2.7.0 (#{state})"
      assert_includes error.message, "An editable version would be renamed to 2.7.1 by deliver"
      assert_nil @dsl.app_store_uploads
    end
    assert_equal ["/v1/apps/app-1/appStoreVersions?filter[platform]=IOS&limit=200"], BoardseshASC::Client.listed_paths
  end

  def test_ios_draft_reads_the_legacy_state_attribute_too
    error = assert_raises(RuntimeError) do
      run_ios_draft([app_store_version("2.7.0", "WAITING_FOR_REVIEW", state_attribute: "appStoreState")])
    end
    assert_includes error.message, "unreleased iOS version 2.7.0 (WAITING_FOR_REVIEW)"
    assert_nil @dsl.app_store_uploads
  end

  # An approved version that is not released yet is not editable, so deliver
  # would not rename it, but the next version must still wait until it is out.
  def test_ios_draft_waits_for_an_approved_version_to_be_released
    [
      ["PENDING_DEVELOPER_RELEASE", "appVersionState"], ["ACCEPTED", "appVersionState"],
      ["PENDING_APPLE_RELEASE", "appVersionState"], ["PROCESSING_FOR_DISTRIBUTION", "appVersionState"],
      ["WAITING_FOR_EXPORT_COMPLIANCE", "appVersionState"],
      ["PENDING_DEVELOPER_RELEASE", "appStoreState"], ["PENDING_APPLE_RELEASE", "appStoreState"],
      ["PROCESSING_FOR_APP_STORE", "appStoreState"], ["WAITING_FOR_EXPORT_COMPLIANCE", "appStoreState"]
    ].each do |state, state_attribute|
      error = assert_raises(RuntimeError, "#{state_attribute} #{state}") do
        run_ios_draft([app_store_version("2.6.0", "READY_FOR_DISTRIBUTION"),
                       app_store_version("2.7.0", state, state_attribute: state_attribute)])
      end
      assert_includes error.message, "unreleased iOS version 2.7.0 (#{state})"
      assert_includes error.message, "until it is out"
      assert_nil @dsl.app_store_uploads
    end
  end

  # The live version and replaced or removed ones never hold the next draft.
  def test_ios_draft_ignores_live_replaced_and_removed_versions
    [
      ["READY_FOR_DISTRIBUTION", "appVersionState"], ["REPLACED_WITH_NEW_VERSION", "appVersionState"],
      ["READY_FOR_SALE", "appStoreState"], ["REPLACED_WITH_NEW_VERSION", "appStoreState"],
      ["REMOVED_FROM_SALE", "appStoreState"], ["DEVELOPER_REMOVED_FROM_SALE", "appStoreState"]
    ].each do |state, state_attribute|
      @dsl.app_store_uploads&.clear
      run_ios_draft([app_store_version("2.7.0", state, state_attribute: state_attribute)])
      assert_equal ["2.7.1"], @dsl.app_store_uploads.map { |options| options.fetch(:app_version) }, "#{state_attribute} #{state}"
    end
  end

  def test_ios_draft_updates_its_own_open_version_and_attaches_the_build
    edit_version = FakeEditVersion.new("2.7.1")
    run_ios_draft(
      [app_store_version("2.6.0", "READY_FOR_DISTRIBUTION"), app_store_version("2.7.1", "PREPARE_FOR_SUBMISSION"),
       app_store_version("2.7.0", "PREPARE_FOR_SUBMISSION", platform: "MAC_OS")],
      edit_version: edit_version
    )
    assert_equal ["2.7.1"], @dsl.app_store_uploads.map { |options| options.fetch(:app_version) }
    assert_equal false, @dsl.app_store_uploads.first.fetch(:submit_for_review)
    assert_equal "build-4", edit_version.selected_build_id
  end

  def test_ios_draft_creates_the_version_when_nothing_is_open
    run_ios_draft([app_store_version("2.6.0", "READY_FOR_DISTRIBUTION"), app_store_version("2.5.0", "REPLACED_WITH_NEW_VERSION")])
    assert_equal ["2.7.1"], @dsl.app_store_uploads.map { |options| options.fetch(:app_version) }
  end

  def test_android_upload_uses_workflow_environment_from_fastlane_directory
    aab = File.join(@root, "packages/mobile/android/app/build/outputs/bundle/release/app-release.aab")
    FileUtils.mkdir_p(File.dirname(aab))
    File.write(aab, "fake AAB")
    ENV["ANDROID_AAB_PATH"] = File.join(File.dirname(aab), "*.aab")
    ENV["ANDROID_VERSION_CODE"] = "2001311"
    ENV["BOARDSESH_MOBILE_VERSION"] = "2.6.0"
    ENV["GOOGLE_PLAY_SERVICE_ACCOUNT_JSON"] = "unused fake credential"

    Dir.chdir(@fastlane_directory) { @dsl.lanes.fetch([:android, :upload_beta]).call({}) }

    received = BoardseshAndroidRelease::Runner.received
    assert_equal aab, received.fetch(:aab)
    assert_equal "2001311", received.fetch(:version_code)
    assert_equal "2.6.0", received.fetch(:version)
    assert_equal File.join(@root, "fastlane/metadata/android"), received.fetch(:metadata_path)
    assert_respond_to received.fetch(:service), :call
    assert_nil @dsl.commands
  end

  def run_ios_metadata(edit_version, options = {})
    @dsl.extend(@dsl)
    ENV["APP_STORE_CONNECT_API_KEY_ID"] = "FAKEKEY123"
    ENV["APP_STORE_CONNECT_ISSUER_ID"] = "fake-issuer"
    ENV["ASC_KEY_PATH"] = "/nonexistent/AuthKey_FAKEKEY123.p8"
    Spaceship::ConnectAPI::App.current = FakeApp.new("app-1", edit_version)
    Dir.chdir(@fastlane_directory) { @dsl.lanes.fetch([:ios, :metadata]).call(options) }
  end

  def test_ios_metadata_pushes_onto_the_editable_version
    run_ios_metadata(FakeEditableVersion.new("2.7.0", "PREPARE_FOR_SUBMISSION", nil))
    assert_equal 1, @dsl.app_store_uploads.length
    assert_equal true, @dsl.app_store_uploads.first.fetch(:skip_app_version_update)
    assert_equal false, @dsl.app_store_uploads.first.fetch(:submit_for_review)
  end

  # Spaceship's editable-version lookup also returns a version waiting for review.
  # After a merge-back submits one, a listing push must leave it alone.
  def test_ios_listing_pushes_skip_a_version_waiting_for_review
    run_ios_metadata(FakeEditableVersion.new("2.7.0", "WAITING_FOR_REVIEW", nil))
    run_ios_metadata(FakeEditableVersion.new("2.7.0", nil, "WAITING_FOR_REVIEW"))
    assert_nil @dsl.app_store_uploads
  end

  # The merge-back submission names the version it is about to submit.
  def test_ios_metadata_with_an_expected_version_pushes_only_onto_that_version
    error = assert_raises(RuntimeError) do
      run_ios_metadata(FakeEditableVersion.new("2.7.1", "PREPARE_FOR_SUBMISSION", nil), { expected_version: "2.7.0" })
    end
    assert_includes error.message, "is 2.7.1, expected 2.7.0"
    assert_raises(RuntimeError) { run_ios_metadata(FakeEditableVersion.new("2.7.0", "PREPARE_FOR_SUBMISSION", nil), { expected_version: "2.7" }) }
    # Already submitted (waiting for review) or nothing editable: a skip, so a rerun stays green.
    run_ios_metadata(FakeEditableVersion.new("2.7.0", "WAITING_FOR_REVIEW", nil), { expected_version: "2.7.0" })
    run_ios_metadata(nil, { expected_version: "2.7.0" })
    assert_nil @dsl.app_store_uploads
    run_ios_metadata(FakeEditableVersion.new("2.7.0", "PREPARE_FOR_SUBMISSION", nil), { expected_version: "2.7.0" })
    assert_equal 1, @dsl.app_store_uploads.length
  end

  # A check that cannot read App Store Connect must not let deliver run blind:
  # deliver's own lookup includes a version waiting for review.
  def test_ios_listing_pushes_skip_when_the_editable_version_cannot_be_read
    broken_app = Object.new
    def broken_app.get_edit_app_store_version(platform: nil)
      raise "App Store Connect is down"
    end
    @dsl.extend(@dsl)
    ENV["APP_STORE_CONNECT_API_KEY_ID"] = "FAKEKEY123"
    ENV["APP_STORE_CONNECT_ISSUER_ID"] = "fake-issuer"
    ENV["ASC_KEY_PATH"] = "/nonexistent/AuthKey_FAKEKEY123.p8"
    Spaceship::ConnectAPI::App.current = broken_app
    Dir.chdir(@fastlane_directory) { @dsl.lanes.fetch([:ios, :metadata]).call({}) }
    assert_nil @dsl.app_store_uploads
    error = assert_raises(RuntimeError) do
      Dir.chdir(@fastlane_directory) { @dsl.lanes.fetch([:ios, :metadata]).call({ expected_version: "2.7.0" }) }
    end
    assert_includes error.message, "Could not read the editable App Store version"
    assert_nil @dsl.app_store_uploads
  end

  # supply's commit used the API default, which cancels a release in review. The
  # listing lanes now commit through BoardseshPlayListing (ERROR_IF_IN_REVIEW).
  def test_play_listing_lanes_commit_through_the_review_protected_runner
    @dsl.extend(@dsl)
    ENV["GOOGLE_PLAY_SERVICE_ACCOUNT_JSON"] = "unused fake credential"
    { metadata: ["listing"], images: ["images"] }.each do |lane, parts|
      Dir.chdir(@fastlane_directory) { @dsl.lanes.fetch([:android, lane]).call }
      received = BoardseshPlayListing::Runner.received
      assert_equal parts, received.fetch(:parts), lane.to_s
      assert_equal File.join(@root, "fastlane/metadata/android"), received.fetch(:metadata_path)
      assert_respond_to received.fetch(:service), :call
    end
    refute_includes File.read(File.expand_path("../Fastfile", __dir__)), "upload_to_play_store"
    assert_nil @dsl.commands
  end

  def test_play_screenshots_lane_stages_the_phone_set_for_the_runner
    shots = File.join(@root, "app-stores", "google", "screenshots", "pixel-2")
    FileUtils.mkdir_p(shots)
    %w[01-home.png 02-board.png].each { |name| File.write(File.join(shots, name), name) }
    @dsl.extend(@dsl)
    ENV["GOOGLE_PLAY_SERVICE_ACCOUNT_JSON"] = "unused fake credential"
    Dir.chdir(@fastlane_directory) { @dsl.lanes.fetch([:android, :screenshots]).call }
    received = BoardseshPlayListing::Runner.received
    assert_equal ["screenshots"], received.fetch(:parts)
    assert_equal %w[en-US/images/phoneScreenshots/01-home.png en-US/images/phoneScreenshots/02-board.png],
      BoardseshPlayListing::Runner.staged_files
    refute Dir.exist?(received.fetch(:metadata_path)), "the staging folder is removed afterwards"
  end

  def test_android_draft_lane_runs_the_review_protected_draft_script
    ENV["RELEASE_VERSION"] = "2.7.0"
    ENV["ANDROID_VERSION_CODE"] = "2001310"
    ENV["GOOGLE_PLAY_SERVICE_ACCOUNT_JSON"] = "unused fake credential"
    Dir.chdir(@fastlane_directory) { @dsl.lanes.fetch([:android, :draft_submission]).call }
    assert_equal [["vp", "exec", "node", "--import", "tsx", File.join(@root, "scripts", "mobile-store-android-draft.ts")]], @dsl.commands
    { "RELEASE_VERSION" => "2.7", "ANDROID_VERSION_CODE" => "0" }.each do |name, invalid|
      ENV["RELEASE_VERSION"], ENV["ANDROID_VERSION_CODE"] = "2.7.0", "2001310"
      ENV[name] = invalid
      assert_raises(RuntimeError, name) { Dir.chdir(@fastlane_directory) { @dsl.lanes.fetch([:android, :draft_submission]).call } }
    end
    assert_equal 1, @dsl.commands.length
  end

  def test_ios_upload_resolves_repo_relative_workflow_paths_from_fastlane_directory
    ENV["ARCHIVE_PATH"] = "packages/mobile/ios/build/Boardsesh.xcarchive"
    ENV["EXPORT_OPTIONS_PLIST"] = "packages/mobile/ExportOptions.plist"
    ENV["EXPORT_PATH"] = "packages/mobile/ios/build/export"
    ENV["APP_STORE_CONNECT_API_KEY_ID"] = "FAKEKEY123"
    ENV["APP_STORE_CONNECT_ISSUER_ID"] = "fake-issuer"
    archive = File.join(@root, ENV.fetch("ARCHIVE_PATH"))
    options = File.join(@root, ENV.fetch("EXPORT_OPTIONS_PLIST"))
    key_path = File.expand_path("~/.private_keys/AuthKey_FAKEKEY123.p8")
    FileUtils.mkdir_p(archive)
    File.write(options, "fake export options")

    # The private key check is stubbed; no real credential is read or created.
    original_file_check = File.method(:file?)
    File.define_singleton_method(:file?) { |path| path == key_path || original_file_check.call(path) }
    begin
      Dir.chdir(@fastlane_directory) { @dsl.lanes.fetch([:ios, :testflight]).call }
    ensure
      File.define_singleton_method(:file?, original_file_check)
    end

    assert_equal [[
      "xcodebuild", "-exportArchive", "-archivePath", archive,
      "-exportOptionsPlist", options, "-exportPath", File.join(@root, ENV.fetch("EXPORT_PATH")),
      "-allowProvisioningUpdates", "-authenticationKeyPath", key_path,
      "-authenticationKeyID", "FAKEKEY123", "-authenticationKeyIssuerID", "fake-issuer"
    ]], @dsl.commands
  end

  def write_default_screenshot_campaign
    phone_names = %w[00-your-boards.png 01-spray-wall.png 02-more-boards.png 03-your-crew.png
                     04-on-the-wall.png 05-one-logbook.png 06-session-plan.png 07-live-activity.png 08-next-project.png]
    ipad_names = %w[00-wall-kiosk.png 01-wall-status.png 02-home.png 03-discover.png 04-workout-generator.png 05-profile.png]
    devices = %w[iphone-16-pro-max iphone-16-pro ipad-pro-13-inch-m5 ipad-pro-11-inch-m5]
    @dsl.const_get(:EXPECTED_DELIVER_LOCALES).each do |locale|
      devices.each do |device|
        directory = File.join(@dsl.const_get(:APPLE_SCREENSHOTS_ROOT), locale, device)
        FileUtils.mkdir_p(directory)
        names = device.start_with?("iphone-") ? phone_names : ipad_names
        names.each do |name|
          filename = locale == "it" && device.start_with?("iphone-") && name == "07-live-activity.png" ? "07-session-detail.png" : name
          File.write(File.join(directory, filename), "native screenshot bytes")
        end
      end
    end
    @dsl.extend(@dsl)
  end

  def campaign_screenshot(locale, device, name)
    File.join(@dsl.const_get(:APPLE_SCREENSHOTS_ROOT), locale, device, name)
  end

  def test_screenshot_manifest_accepts_the_exact_six_locale_campaign_with_italian_session_slots
    write_default_screenshot_campaign
    manifest = @dsl.screenshot_manifest
    assert_equal %w[de-DE en-US es-ES es-MX fr-FR it], manifest.keys.sort
    assert_equal 180, manifest.values.sum { |devices| devices.values.sum(&:length) }
    %w[iphone-16-pro-max iphone-16-pro].each do |device|
      filenames = manifest.fetch("it").fetch(device).map { |path| File.basename(path) }
      assert_includes filenames, "07-session-detail.png"
      refute_includes filenames, "07-live-activity.png"
      assert_equal 9, filenames.length
    end
    assert_equal 6, manifest.fetch("it").fetch("ipad-pro-13-inch-m5").length
  end

  def test_screenshot_manifest_rejects_a_missing_italian_session_capture
    write_default_screenshot_campaign
    FileUtils.rm(campaign_screenshot("it", "iphone-16-pro", "07-session-detail.png"))
    error = assert_raises(RuntimeError) { @dsl.screenshot_manifest }
    assert_includes error.message, "Screenshot files for it/iphone-16-pro do not match"
  end

  def test_screenshot_manifest_rejects_the_old_live_activity_in_the_italian_slot
    write_default_screenshot_campaign
    FileUtils.mv(campaign_screenshot("it", "iphone-16-pro", "07-session-detail.png"),
      campaign_screenshot("it", "iphone-16-pro", "07-live-activity.png"))
    error = assert_raises(RuntimeError) { @dsl.screenshot_manifest }
    assert_includes error.message, "Screenshot files for it/iphone-16-pro do not match"
  end

  def test_screenshot_manifest_rejects_an_additional_italian_session_capture
    write_default_screenshot_campaign
    File.write(campaign_screenshot("it", "iphone-16-pro", "09-session-detail.png"), "unexpected capture")
    error = assert_raises(RuntimeError) { @dsl.screenshot_manifest }
    assert_includes error.message, "Screenshot files for it/iphone-16-pro do not match"
  end

  def test_screenshot_manifest_rejects_the_session_substitution_in_french
    write_default_screenshot_campaign
    FileUtils.mv(campaign_screenshot("fr-FR", "iphone-16-pro", "07-live-activity.png"),
      campaign_screenshot("fr-FR", "iphone-16-pro", "07-session-detail.png"))
    error = assert_raises(RuntimeError) { @dsl.screenshot_manifest }
    assert_includes error.message, "Screenshot files for fr-FR/iphone-16-pro do not match"
  end

  def test_screenshot_manifest_rejects_the_session_substitution_on_italian_ipad
    write_default_screenshot_campaign
    FileUtils.mv(campaign_screenshot("it", "ipad-pro-13-inch-m5", "05-profile.png"),
      campaign_screenshot("it", "ipad-pro-13-inch-m5", "07-session-detail.png"))
    error = assert_raises(RuntimeError) { @dsl.screenshot_manifest }
    assert_includes error.message, "Screenshot files for it/ipad-pro-13-inch-m5 do not match"
  end
end
