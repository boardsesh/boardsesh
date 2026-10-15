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
    attr_reader :lanes, :commands

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
