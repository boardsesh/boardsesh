# frozen_string_literal: true

require "minitest/autorun"
require "tmpdir"
require "fileutils"
require "json"

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
  def get_edit_app_store_version(platform:)
    edit_version if platform == Spaceship::ConnectAPI::Platform::IOS
  end
end

FakeBuild = Struct.new(:id, :app_version, :version)

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
    @dsl = Module.new
    @dsl.extend(LaneDsl)
    @dsl.module_eval(File.read(File.expand_path("../Fastfile", __dir__)), File.join(@fastlane_directory, "Fastfile"))
    BoardseshAndroidRelease::Runner.received = nil
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
end
