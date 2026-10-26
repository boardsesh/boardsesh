# frozen_string_literal: true

require "minitest/autorun"
require "tmpdir"
require "fileutils"
require_relative "../lib/testflight_distribution"
require_relative "../lib/app_store_version_states"

module UI
  def self.user_error!(message)
    raise message
  end

  def self.success(_message); end
end

module Spaceship
  module ConnectAPI
    class App
      class << self
        attr_accessor :current
      end

      def self.find(_identifier)
        current
      end
    end

    class Build
      class << self
        attr_accessor :current, :queries
      end

      def self.all(**options)
        (self.queries ||= []) << options
        [current]
      end
    end
  end
end

class TestflightDistributionTest < Minitest::Test
  def test_summary_refuses_an_unrecognized_status
    error = assert_raises(BoardseshTestflightDistribution::Error) do
      BoardseshTestflightDistribution.summary({ "version" => "2.7.0", "buildNumber" => "2", "status" => "unknown" })
    end
    assert_includes error.message, "Unknown TestFlight distribution summary status"
  end

  FakeApp = Struct.new(:id, :bundle_id, :groups) do
    def get_beta_groups
      groups
    end
  end
  FakeGroup = Struct.new(:id, :name, :is_internal_group, :builds) do
    def fetch_builds
      builds
    end
  end
  FakeDetails = Struct.new(:external_build_state)
  FakeBuild = Struct.new(:id, :version, :app_version, :app_id, :bundle_id, :platform,
    :expired, :processing_state, :build_beta_detail)

  module LaneDsl
    attr_reader :lanes, :testflight_uploads, :api_key_options

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

    def app_store_connect_api_key(**options)
      @api_key_options = options
      { key_id: options.fetch(:key_id) }
    end

    def upload_to_testflight(**options)
      (@testflight_uploads ||= []) << options
      @after_distribution.call
      "Pilot returns a message, not a build"
    end

    def after_distribution=(callback)
      @after_distribution = callback
    end
  end

  def setup
    @original_env = ENV.to_h
    @root = Dir.mktmpdir("testflight-distribution-")
    @notes = "1. Open Boardsesh → your climbs appear.\n"
    @group = FakeGroup.new("external-1", "Discord Users", false, [])
    @app = FakeApp.new("app-1", "com.boardsesh.app", [@group])
    @build = FakeBuild.new("build-2", "2", "2.7.0", "app-1", "com.boardsesh.app", "IOS",
      false, "VALID", FakeDetails.new("READY_FOR_BETA_SUBMISSION"))
    @builds = [@build]
    @distribution_options = []
    @after_distribution = -> do
      @build.build_beta_detail.external_build_state = "WAITING_FOR_BETA_REVIEW"
      @group.builds = [@build]
    end
    ENV.delete("GITHUB_STEP_SUMMARY")
  end

  def teardown
    ENV.replace(@original_env)
    FileUtils.remove_entry(@root)
  end

  def runner
    BoardseshTestflightDistribution::Runner.new(
      app: @app, version: "2.7.0", build_number: "2", notes: @notes,
      find_builds: -> { @builds },
      distribute: ->(options) { @distribution_options << options; @after_distribution.call }
    )
  end

  def test_distributes_only_the_exact_build_to_the_existing_external_group
    receipt = runner.run
    assert_equal [{
      app_identifier: "com.boardsesh.app", app_platform: "ios", app_version: "2.7.0", build_number: "2",
      changelog: @notes, distribute_only: true, distribute_external: true, groups: ["external-1"],
      submit_beta_review: true, notify_external_testers: true, skip_submission: false,
      skip_waiting_for_build_processing: false, wait_processing_interval: 30,
      wait_processing_timeout_duration: 2700, expire_previous_builds: false, reject_build_waiting_for_review: false
    }], @distribution_options
    assert_equal "build-2", receipt.fetch("buildId")
    assert_equal "external-1", receipt.fetch("groupId")
    assert_equal "Discord Users", receipt.fetch("groupName")
    assert_equal "pending-beta-review", receipt.fetch("status")
    assert_includes BoardseshTestflightDistribution.summary(receipt), "Apple beta review is pending"
    refute_includes BoardseshTestflightDistribution.summary(receipt), "ready for"
  end

  def test_waits_through_pilot_when_the_upload_is_not_visible_yet
    @builds = []
    @after_distribution = -> do
      @builds = [@build]
      @build.build_beta_detail.external_build_state = "IN_BETA_REVIEW"
      @group.builds = [@build]
    end
    assert_equal "pending-beta-review", runner.run.fetch("status")
    assert_equal 1, @distribution_options.length
  end

  def test_ready_and_approved_states_have_distinct_summaries
    { "IN_BETA_TESTING" => "ready-for-testing", "READY_FOR_BETA_TESTING" => "ready-for-testing",
      "BETA_APPROVED" => "approved-awaiting-availability" }.each do |state, status|
      @after_distribution = -> { @build.build_beta_detail.external_build_state = state; @group.builds = [@build] }
      receipt = runner.run
      assert_equal status, receipt.fetch("status")
      assert_includes BoardseshTestflightDistribution.summary(receipt), @group.name
      @group.builds = []
    end
  end

  def test_a_retried_completed_assignment_does_not_write_or_notify_again
    runner.run
    @distribution_options.clear
    receipt = runner.run
    assert_empty @distribution_options
    assert_equal "already-assigned", receipt.fetch("action")
    assert_equal false, receipt.fetch("notificationRequested")
    assert_equal "pending-beta-review", receipt.fetch("status")
    assert_equal "Discord Users", receipt.fetch("groupName")
  end

  def test_repairs_an_existing_unsubmitted_assignment_with_approval_notifications_enabled
    @group.builds = [@build]
    receipt = runner.run
    assert_equal true, @distribution_options.first.fetch(:notify_external_testers)
    assert_equal true, receipt.fetch("notificationRequested")
    assert_equal "pending-beta-review", receipt.fetch("status")
    @distribution_options.clear
    assert_equal "already-assigned", runner.run.fetch("action")
    assert_empty @distribution_options
  end

  def test_group_name_matching_ignores_capitalization_and_preserves_the_actual_name
    ["Discord Users", "discord users", "DISCORD USERS", "DiScOrD uSeRs"].each do |name|
      @group.name = name
      @group.builds = []
      receipt = runner.run
      assert_equal ["external-1"], @distribution_options.last.fetch(:groups)
      assert_equal name, receipt.fetch("groupName")
      assert_includes BoardseshTestflightDistribution.summary(receipt), name

      writes = @distribution_options.length
      repeated = runner.run
      assert_equal writes, @distribution_options.length
      assert_equal false, repeated.fetch("notificationRequested")
      assert_equal name, repeated.fetch("groupName")
    end
  end

  def test_missing_ambiguous_or_internal_group_prevents_all_writes
    [[], [@group, @group], [FakeGroup.new("other", "Other Users", false, [])],
      [FakeGroup.new("internal", "discord users", true, [])],
      [FakeGroup.new("unknown", "Discord Users", nil, [])],
      [@group, FakeGroup.new("other", "discord users", false, [])],
      [@group, FakeGroup.new("internal", "DISCORD USERS", true, [])]].each do |groups|
      @app.groups = groups
      assert_raises(BoardseshTestflightDistribution::Error) { runner.run }
    end
    assert_empty @distribution_options
  end

  def test_lookup_failure_reports_only_available_group_metadata
    @app.groups = [FakeGroup.new("staff-1", "Staff", true, ["tester@example.com"])]
    error = assert_raises(BoardseshTestflightDistribution::Error) { runner.run }
    assert_includes error.message, '"Discord Users"'
    assert_includes error.message, '"Staff"'
    assert_includes error.message, 'id: "staff-1"'
    assert_includes error.message, "internal: true"
    refute_includes error.message, "tester@example.com"
    assert_empty @distribution_options
  end

  def test_empty_group_list_is_explicit_in_lookup_failure
    @app.groups = []
    error = assert_raises(BoardseshTestflightDistribution::Error) { runner.run }
    assert_includes error.message, "Available groups: (none)"
    assert_empty @distribution_options
  end

  def test_ambiguous_case_variants_are_reported_without_selecting_either_group
    @app.groups = [@group, FakeGroup.new("external-2", "discord users", false, [])]
    error = assert_raises(BoardseshTestflightDistribution::Error) { runner.run }
    assert_includes error.message, '"Discord Users" (id: "external-1", internal: false)'
    assert_includes error.message, '"discord users" (id: "external-2", internal: false)'
    assert_empty @distribution_options
  end

  def test_wrong_app_platform_version_build_or_duplicate_result_prevents_writes
    { app_id: "other-app", bundle_id: "other.bundle", platform: "MAC_OS", app_version: "2.7.1", version: "3", id: "" }.each do |attribute, wrong|
      original = @build.public_send(attribute)
      @build.public_send("#{attribute}=", wrong)
      assert_raises(BoardseshTestflightDistribution::Error, attribute.to_s) { runner.run }
      @build.public_send("#{attribute}=", original)
    end
    @builds = [@build, @build]
    assert_raises(BoardseshTestflightDistribution::Error) { runner.run }
    assert_empty @distribution_options
  end

  def test_expired_invalid_or_rejected_build_prevents_writes
    @build.expired = true
    assert_raises(BoardseshTestflightDistribution::Error) { runner.run }
    @build.expired = false
    %w[FAILED INVALID].each do |state|
      @build.processing_state = state
      assert_raises(BoardseshTestflightDistribution::Error) { runner.run }
    end
    @build.processing_state = "VALID"
    @build.build_beta_detail.external_build_state = "BETA_REJECTED"
    assert_raises(BoardseshTestflightDistribution::Error) { runner.run }
    assert_empty @distribution_options
  end

  def test_pilot_success_without_assignment_is_a_failure
    @after_distribution = -> { @build.build_beta_detail.external_build_state = "WAITING_FOR_BETA_REVIEW" }
    error = assert_raises(BoardseshTestflightDistribution::Error) { runner.run }
    assert_includes error.message, "not assigned"
  end

  def test_assignment_without_review_submission_is_a_failure
    @after_distribution = -> { @group.builds = [@build] }
    error = assert_raises(BoardseshTestflightDistribution::Error) { runner.run }
    assert_includes error.message, "READY_FOR_BETA_SUBMISSION"
  end

  def test_an_unknown_apple_state_cannot_verify_review_or_testing_availability
    @group.builds = [@build]
    @build.build_beta_detail.external_build_state = "NEW_APPLE_EXTERNAL_STATE"
    @after_distribution = -> { "Pilot reports success but Apple state is still unknown" }
    error = assert_raises(BoardseshTestflightDistribution::Error) { runner.run }
    assert_includes error.message, "beta review/testing state"
    assert_includes error.message, "NEW_APPLE_EXTERNAL_STATE"
  end

  def test_pilot_success_does_not_hide_unfinished_processing
    @after_distribution = -> do
      @group.builds = [@build]
      @build.processing_state = "PROCESSING"
      @build.build_beta_detail.external_build_state = "WAITING_FOR_BETA_REVIEW"
    end
    error = assert_raises(BoardseshTestflightDistribution::Error) { runner.run }
    assert_includes error.message, "has not finished Apple processing"
  end

  def test_distribution_rechecks_build_identity
    @after_distribution = -> do
      @builds = [@build.dup]
      @builds.first.id = "different-build"
      @group.builds = @builds
    end
    error = assert_raises(BoardseshTestflightDistribution::Error) { runner.run }
    assert_includes error.message, "identity changed"
  end

  def test_validates_version_build_and_utf8_byte_limit_before_any_api_write
    ["2.7", "latest", ""].each do |version|
      assert_raises(BoardseshTestflightDistribution::Error) do
        BoardseshTestflightDistribution.validate_inputs!(version: version, build_number: "2", notes: @notes)
      end
    end
    ["0", "2.0", "-2", ""].each do |build_number|
      assert_raises(BoardseshTestflightDistribution::Error) do
        BoardseshTestflightDistribution.validate_inputs!(version: "2.7.0", build_number: build_number, notes: @notes)
      end
    end
    [" \n", "é" * 2001, "\xFF".dup.force_encoding(Encoding::UTF_8)].each do |notes|
      assert_raises(BoardseshTestflightDistribution::Error) do
        BoardseshTestflightDistribution.validate_inputs!(version: "2.7.0", build_number: "2", notes: notes)
      end
    end
    BoardseshTestflightDistribution.validate_inputs!(version: "2.7.0", build_number: "2", notes: "é" * 2000)
    assert_empty @distribution_options
  end

  def test_reads_relative_notes_from_the_repository_root_and_preserves_text
    File.write(File.join(@root, "notes.txt"), @notes)
    assert_equal @notes, BoardseshTestflightDistribution.read_notes("notes.txt", root: @root)
    assert_raises(BoardseshTestflightDistribution::Error) { BoardseshTestflightDistribution.read_notes("missing.txt", root: @root) }
    assert_raises(BoardseshTestflightDistribution::Error) { BoardseshTestflightDistribution.read_notes(nil, root: @root) }
  end

  def load_lane
    fastlane_directory = File.join(@root, "fastlane")
    lib_directory = File.join(fastlane_directory, "lib")
    FileUtils.mkdir_p(lib_directory)
    %w[app_store_version_states testflight_distribution spaceship].each do |name|
      File.write(File.join(lib_directory, "#{name}.rb"), "# Test doubles are loaded above\n")
    end
    @stub_load_path = lib_directory
    $LOAD_PATH.unshift(@stub_load_path)
    @dsl = Module.new
    @dsl.extend(LaneDsl)
    @dsl.module_eval(File.read(File.expand_path("../Fastfile", __dir__)), File.join(fastlane_directory, "Fastfile"))
    @dsl.extend(@dsl)
    @dsl.after_distribution = @after_distribution
    Spaceship::ConnectAPI::App.current = @app
    Spaceship::ConnectAPI::Build.current = @build
    Spaceship::ConnectAPI::Build.queries = []
    ENV["APP_STORE_CONNECT_API_KEY_ID"] = "FAKEKEY123"
    ENV["APP_STORE_CONNECT_ISSUER_ID"] = "fake-issuer"
    ENV["ASC_KEY_PATH"] = "/nonexistent/fake-key.p8"
    File.write(File.join(@root, "notes.txt"), @notes)
    @dsl.lanes.fetch([:ios, :distribute_testflight])
  end

  def test_actual_lane_passes_explicit_options_and_existing_api_key_to_pilot
    lane = load_lane
    ENV["RELEASE_VERSION"], ENV["IOS_BUILD_NUMBER"], ENV["TESTFLIGHT_NOTES_PATH"] = "wrong", "0", "wrong.txt"
    lane.call(version: "2.7.0", build_number: "2", notes_path: "notes.txt")
    assert_equal "FAKEKEY123", @dsl.testflight_uploads.first.fetch(:api_key).fetch(:key_id)
    assert_equal "/nonexistent/fake-key.p8", @dsl.api_key_options.fetch(:key_filepath)
    assert_equal [{ app_id: "app-1", version: "2.7.0", build_number: "2", platform: "IOS" }] * 2,
      Spaceship::ConnectAPI::Build.queries
  ensure
    $LOAD_PATH.delete(@stub_load_path)
  end

  def test_actual_lane_uses_workflow_environment_and_validates_before_authentication
    lane = load_lane
    ENV["RELEASE_VERSION"], ENV["IOS_BUILD_NUMBER"], ENV["TESTFLIGHT_NOTES_PATH"] = "2.7.0", "2", "notes.txt"
    assert_equal "pending-beta-review", lane.call({}).fetch("status")
    ENV["RELEASE_VERSION"] = "wrong"
    ENV.delete("APP_STORE_CONNECT_API_KEY_ID")
    error = assert_raises(RuntimeError) { lane.call({}) }
    assert_includes error.message, "version must be semver"
    assert_equal 1, @dsl.testflight_uploads.length
  ensure
    $LOAD_PATH.delete(@stub_load_path)
  end
end
