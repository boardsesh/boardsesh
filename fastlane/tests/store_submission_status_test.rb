# frozen_string_literal: true

require "minitest/autorun"
require "tmpdir"
require "fileutils"
require_relative "../lib/store_submission_status"

class StoreSubmissionStatusTest < Minitest::Test
  def version(version_string, state, platform: "IOS", state_attribute: "appVersionState", id: "id-#{version_string}")
    { "type" => "appStoreVersions", "id" => id,
      "attributes" => { "versionString" => version_string, "platform" => platform, state_attribute => state } }
  end

  def status(versions, wanted = "2.7.0")
    BoardseshStoreSubmissionStatus.ios(versions, wanted)
  end

  def test_an_editable_or_missing_version_is_pending
    missing = status([version("2.6.0", "READY_FOR_DISTRIBUTION")])
    assert_equal "pending", missing.fetch("status")
    assert_equal true, missing.fetch("needsDraft")
    %w[PREPARE_FOR_SUBMISSION READY_FOR_REVIEW].each do |state|
      result = status([version("2.6.0", "READY_FOR_DISTRIBUTION"), version("2.7.0", state)])
      assert_equal "pending", result.fetch("status"), state
      assert_equal state, result.fetch("state")
      assert_equal "id-2.7.0", result.fetch("versionId")
    end
  end

  # deliver's editable-version lookup does not include READY_FOR_REVIEW, so the
  # draft lane would try to create the version again. Resume the review draft instead.
  def test_a_version_in_a_review_draft_is_resumed_without_drafting
    result = status([version("2.7.0", "READY_FOR_REVIEW")])
    assert_equal false, result.fetch("needsDraft")
    assert_includes result.fetch("reason"), "resumes it"
    assert_equal true, status([version("2.7.0", "PREPARE_FOR_SUBMISSION")]).fetch("needsDraft")
    assert_equal false, status([version("2.7.0", "WAITING_FOR_REVIEW")]).fetch("needsDraft")
    assert_equal false, status([version("2.7.0", "REJECTED")]).fetch("needsDraft")
  end

  def test_submitted_approved_or_released_is_done
    %w[WAITING_FOR_REVIEW IN_REVIEW ACCEPTED APPROVED PENDING_DEVELOPER_RELEASE PENDING_APPLE_RELEASE
       PROCESSING_FOR_DISTRIBUTION READY_FOR_DISTRIBUTION READY_FOR_SALE REPLACED_WITH_NEW_VERSION].each do |state|
      assert_equal "done", status([version("2.7.0", state)]).fetch("status"), state
    end
  end

  def test_reads_the_legacy_state_attribute_too
    assert_equal "done", status([version("2.7.0", "WAITING_FOR_REVIEW", state_attribute: "appStoreState")]).fetch("status")
  end

  # Resubmitting a rejection, or a version someone pulled from review, every hour
  # would fight whoever is handling it.
  def test_rejected_pulled_or_invalid_versions_need_a_person
    %w[REJECTED METADATA_REJECTED DEVELOPER_REJECTED INVALID_BINARY].each do |state|
      result = status([version("2.7.0", state)])
      assert_equal "blocked", result.fetch("status"), state
      assert_includes result.fetch("reason"), "Fix and resubmit it in App Store Connect"
      refute_includes result.fetch("reason"), "rename"
    end
  end

  def test_another_version_in_review_defers_and_another_open_version_blocks
    %w[WAITING_FOR_REVIEW IN_REVIEW].each do |state|
      result = status([version("2.6.1", state), version("2.7.0", "PREPARE_FOR_SUBMISSION")])
      assert_equal "deferred", result.fetch("status"), state
      assert_includes result.fetch("reason"), "2.6.1 (#{state})"
    end
    %w[PREPARE_FOR_SUBMISSION READY_FOR_REVIEW].each do |state|
      result = status([version("2.6.1", state)])
      assert_equal "blocked", result.fetch("status"), state
      assert_includes result.fetch("reason"), "will not rename"
    end
    %w[REJECTED DEVELOPER_REJECTED METADATA_REJECTED INVALID_BINARY].each do |state|
      result = status([version("2.6.1", state)])
      assert_equal "blocked", result.fetch("status"), state
      assert_includes result.fetch("reason"), "fixed and resubmitted there"
    end
  end

  # An approved, unreleased version holds the next one until it is released; the
  # draft lane refuses meanwhile, so this waits instead of failing every hour.
  def test_another_approved_unreleased_version_defers
    BoardseshAppStoreVersionStates::APPROVED_UNRELEASED.each do |state|
      %w[appVersionState appStoreState].each do |attribute|
        result = status([version("2.6.1", state, state_attribute: attribute), version("2.7.0", "PREPARE_FOR_SUBMISSION")])
        assert_equal "deferred", result.fetch("status"), "#{state} via #{attribute}"
        assert_includes result.fetch("reason"), "approved and not released yet"
      end
    end
  end

  # The draft lane refuses whenever another version is in any open state, so the
  # status check must never call such a version's successor pending.
  def test_no_state_the_draft_lane_refuses_on_is_reported_pending
    BoardseshAppStoreVersionStates::OPEN.each do |state|
      [nil, "PREPARE_FOR_SUBMISSION"].each do |target_state|
        versions = [version("2.6.1", state)]
        versions << version("2.7.0", target_state) if target_state
        refute_equal "pending", status(versions).fetch("status"), "other version #{state}, target #{target_state.inspect}"
      end
    end
  end

  def test_a_newer_version_supersedes_numerically
    assert_equal "superseded", status([version("2.7.1", "PREPARE_FOR_SUBMISSION"), version("2.7.0", "PREPARE_FOR_SUBMISSION")]).fetch("status")
    assert_equal "superseded", status([version("2.10.0", "READY_FOR_SALE")], "2.9.0").fetch("status")
    assert_equal "pending", status([version("2.9.0", "READY_FOR_SALE")], "2.10.0").fetch("status")
    # Done wins: a released version stays done after the next one is created.
    assert_equal "done", status([version("2.7.1", "PREPARE_FOR_SUBMISSION"), version("2.7.0", "READY_FOR_SALE")]).fetch("status")
  end

  def test_other_platforms_and_unknown_states_are_handled_conservatively
    assert_equal "pending", status([version("2.6.1", "IN_REVIEW", platform: "MAC_OS")]).fetch("status")
    assert_equal "blocked", status([version("2.7.0", "SOMETHING_NEW")]).fetch("status")
  end

  def test_ambiguous_or_invalid_input_fails_closed
    assert_raises(BoardseshStoreSubmissionStatus::Error) { status([version("2.7.0", "PREPARE_FOR_SUBMISSION", id: "a"), version("2.7.0", "READY_FOR_SALE", id: "b")]) }
    ["2.7", "v2.7.0", "", nil].each do |wanted|
      assert_raises(BoardseshStoreSubmissionStatus::Error, wanted.inspect) { status([], wanted) }
    end
  end

  def test_exact_build_is_required_for_submitted_and_review_draft_versions
    attached = { "versionId" => "id-2.7.0", "buildNumber" => "9", "marketingVersion" => "2.7.0", "platform" => "IOS" }
    BoardseshStoreSubmissionStatus::BUILD_BOUND_STATES.each do |state|
      versions = [version("2.7.0", state)]
      expected_status = state == "READY_FOR_REVIEW" ? "pending" : "done"
      assert_equal expected_status, BoardseshStoreSubmissionStatus.ios(versions, "2.7.0", expected_build: "9", attached_build: attached).fetch("status"), state
      [nil, attached.merge("buildNumber" => "8"), attached.merge("versionId" => "other-version"),
       attached.merge("marketingVersion" => "2.6.0"), attached.merge("platform" => "MAC_OS")].each do |mismatch|
        result = BoardseshStoreSubmissionStatus.ios(versions, "2.7.0", expected_build: "9", attached_build: mismatch)
        assert_equal "blocked", result.fetch("status"), "#{state}, #{mismatch.inspect}"
        assert_includes result.fetch("reason"), "exact requested build 9"
        assert_equal false, result.fetch("needsDraft")
      end
    end
  end

  def test_editable_draft_can_replace_an_earlier_build
    result = BoardseshStoreSubmissionStatus.ios([version("2.7.0", "PREPARE_FOR_SUBMISSION")], "2.7.0",
      expected_build: "9", attached_build: { "buildNumber" => "8" })
    assert_equal "pending", result.fetch("status")
    assert_equal true, result.fetch("needsDraft")
  end

  def test_exact_build_input_is_validated_even_when_no_version_exists
    ["", "latest", "0", 9].each do |build|
      assert_raises(BoardseshStoreSubmissionStatus::Error) do
        BoardseshStoreSubmissionStatus.ios([], "2.7.0", expected_build: build)
      end
    end
  end
end

class StoreSubmissionStatusLaneTest < Minitest::Test
  class FakeClient
    attr_accessor :versions, :build, :prerelease, :read_failure
    attr_reader :requests

    def initialize
      @requests = []
      @versions = [{ "type" => "appStoreVersions", "id" => "store-version",
        "attributes" => { "versionString" => "2.7.0", "platform" => "IOS", "appVersionState" => "IN_REVIEW" } }]
      @build = { "type" => "builds", "id" => "build-id", "attributes" => { "version" => "9" } }
      @prerelease = { "type" => "preReleaseVersions", "id" => "prerelease-id",
        "attributes" => { "version" => "2.7.0", "platform" => "IOS" } }
    end

    def list(path)
      @requests << ["GET", path]
      @versions
    end

    def request(method, path)
      @requests << [method, path]
      raise BoardseshASC::Error, "Authenticated read failed" if @read_failure
      case path
      when "/v1/appStoreVersions/store-version/build" then { "data" => @build }
      when "/v1/builds/build-id/preReleaseVersion" then { "data" => @prerelease }
      else raise "Unexpected status request #{method} #{path}"
      end
    end
  end

  def setup
    @saved_env = %w[RELEASE_VERSION IOS_BUILD_NUMBER STORE_SUBMISSION_STATUS_OUTPUT].to_h { |key| [key, ENV[key]] }
    @directory = Dir.mktmpdir("store-status-lane-")
    File.write(File.join(@directory, "spaceship.rb"), "# Status lane test supplies its own App model.\n")
    $LOAD_PATH.unshift(@directory)
    ENV["RELEASE_VERSION"] = "2.7.0"
    ENV["IOS_BUILD_NUMBER"] = "9"
    ENV["STORE_SUBMISSION_STATUS_OUTPUT"] = File.join(@directory, "status.json")
    @client = FakeClient.new
    @dsl = Module.new
    @dsl.const_set(:REPO_ROOT, File.expand_path("../..", __dir__))
    @dsl.const_set(:APP_IDENTIFIER, "com.boardsesh.app")
    ui = Module.new
    ui.define_singleton_method(:user_error!) { |message| raise message }
    ui.define_singleton_method(:message) { |_message| }
    @dsl.const_set(:UI, ui)
    app_model = Class.new
    app_model.define_singleton_method(:find) { |_identifier| Struct.new(:id).new("app-id") }
    connect_api = Module.new
    connect_api.const_set(:App, app_model)
    spaceship = Module.new
    spaceship.const_set(:ConnectAPI, connect_api)
    @dsl.const_set(:Spaceship, spaceship)
    status_client = @client
    client_class = Class.new
    client_class.define_singleton_method(:new) { |token:| status_client }
    asc = Module.new
    asc.const_set(:Client, client_class)
    asc.const_set(:Error, BoardseshASC::Error)
    @dsl.const_set(:BoardseshASC, asc)
    @dsl.define_singleton_method(:asc_api_key) { }
    @dsl.define_singleton_method(:lane) { |_name, &block| @status_lane = block }
    @dsl.define_singleton_method(:run_status_lane) { instance_exec(&@status_lane) }
    path = File.expand_path("../Fastfile", __dir__)
    lane_source = File.read(path)[/^  lane :submission_status do\n.*?^  end$/m]
    raise "Missing submission_status lane" unless lane_source
    @dsl.module_eval(lane_source, path)
  end

  def teardown
    @saved_env.each { |key, previous| previous ? ENV[key] = previous : ENV.delete(key) }
    $LOAD_PATH.delete(@directory)
    FileUtils.remove_entry(@directory)
  end

  def run_lane
    @dsl.run_status_lane
    JSON.parse(File.read(ENV.fetch("STORE_SUBMISSION_STATUS_OUTPUT")))
  end

  def test_lane_reads_the_attached_build_and_prerelease_before_reporting_done
    assert_equal "done", run_lane.fetch("status")
    assert_equal [
      ["GET", "/v1/apps/app-id/appStoreVersions?filter[platform]=IOS&limit=200"],
      ["GET", "/v1/appStoreVersions/store-version/build"],
      ["GET", "/v1/builds/build-id/preReleaseVersion"]
    ], @client.requests
  end

  def test_lane_blocks_a_different_or_missing_attached_build
    @client.build["attributes"]["version"] = "8"
    assert_equal "blocked", run_lane.fetch("status")
    @client.build = nil
    assert_equal "blocked", run_lane.fetch("status")
  end

  def test_lane_does_not_resume_a_review_draft_with_a_different_build
    @client.versions.first["attributes"]["appVersionState"] = "READY_FOR_REVIEW"
    @client.build["attributes"]["version"] = "8"
    result = run_lane
    assert_equal "blocked", result.fetch("status")
    assert_equal false, result.fetch("needsDraft")
  end

  def test_lane_allows_a_prepare_for_submission_draft_to_attach_the_requested_build
    @client.versions.first["attributes"]["appVersionState"] = "PREPARE_FOR_SUBMISSION"
    @client.read_failure = true
    result = run_lane
    assert_equal "pending", result.fetch("status")
    assert_equal true, result.fetch("needsDraft")
    assert_equal 1, @client.requests.length
  end

  def test_authenticated_build_read_failure_does_not_become_done_or_deferred
    @client.read_failure = true
    error = assert_raises(RuntimeError) { run_lane }
    assert_includes error.message, "Authenticated read failed"
    refute File.exist?(ENV.fetch("STORE_SUBMISSION_STATUS_OUTPUT"))
  end

  def test_lane_blocks_wrong_marketing_version_and_platform
    @client.prerelease["attributes"]["version"] = "2.6.0"
    assert_equal "blocked", run_lane.fetch("status")
    @client.prerelease["attributes"]["version"] = "2.7.0"
    @client.prerelease["attributes"]["platform"] = "MAC_OS"
    assert_equal "blocked", run_lane.fetch("status")
  end
end
