# frozen_string_literal: true

require "minitest/autorun"
require_relative "../lib/store_release_control"

class StoreReleaseControlTest < Minitest::Test
  class FakeApple
    attr_accessor :bundle_id, :build_number, :prerelease_version, :processing_state, :expired,
      :state, :release_type, :app_id, :build_id, :version_id, :version_number, :platform,
      :duplicate_apps, :duplicate_versions, :before_binding, :after_write, :write_error
    attr_reader :writes, :binding_reads

    def initialize
      @bundle_id, @build_number, @prerelease_version = "com.boardsesh.app", "17", "2.6.0"
      @processing_state, @expired, @state, @release_type = "VALID", false, "PREPARE_FOR_SUBMISSION", "AFTER_APPROVAL"
      @app_id, @build_id, @version_id, @version_number, @platform = "app", "build", "version", "2.6.0", "IOS"
      @writes, @binding_reads = [], 0
    end

    def app
      { "type" => "apps", "id" => @app_id, "attributes" => { "bundleId" => @bundle_id } }
    end

    def version
      { "type" => "appStoreVersions", "id" => @version_id,
        "attributes" => { "versionString" => @version_number, "platform" => @platform, "appVersionState" => @state, "appStoreState" => @state,
          "releaseType" => @release_type, "earliestReleaseDate" => nil },
        "relationships" => {
          "app" => { "data" => { "type" => "apps", "id" => @app_id } },
          "build" => { "data" => { "type" => "builds", "id" => @build_id } }
        } }
    end

    def list(path)
      case path
      when %r{\A/v1/apps\?filter\[bundleId\]=com.boardsesh.app&limit=200\z}
        @duplicate_apps ? [app, app] : [app]
      when %r{\A/v1/apps/[^/]+/appStoreVersions\?filter\[platform\]=IOS&filter\[versionString\]=2.6.0&limit=200\z}
        @duplicate_versions ? [version, version] : [version]
      else raise "Unexpected list"
      end
    end

    def request(method, path)
      raise "Read attempted a mutation" unless method == "GET"
      case path
      when %r{\A/v1/appStoreVersions/[^/]+\?include=app,build\z}
        @binding_reads += 1
        @before_binding&.call(@binding_reads)
        build = { "type" => "builds", "id" => @build_id,
          "attributes" => { "version" => @build_number, "processingState" => @processing_state, "expired" => @expired } }
        { "data" => version, "included" => [app, build] }
      when %r{\A/v1/builds/[^/]+/preReleaseVersion\z}
        { "data" => { "type" => "preReleaseVersions", "id" => "prerelease", "attributes" => { "version" => @prerelease_version, "platform" => "IOS" } } }
      else raise "Unexpected GET"
      end
    end

    def make_manual(version_id)
      @writes << version_id
      raise @write_error if @write_error
      @release_type = "MANUAL"
      @after_write&.call
    end
  end

  def setup
    @client = FakeApple.new
    @runner = BoardseshStoreReleaseControl::Runner.new(client: @client, version: "2.6.0", build_number: "17")
  end

  def test_sets_manual_once_and_independently_reads_back_exact_identity
    receipt = @runner.run
    assert_equal ["version"], @client.writes
    assert_equal "verified", receipt.fetch("status")
    assert_equal "set-manual", receipt.fetch("action")
    assert_equal "AFTER_APPROVAL", receipt.dig("before", "version", "releaseType")
    assert_equal "MANUAL", receipt.dig("readback", "version", "releaseType")
    assert_equal "17", receipt.dig("readback", "build", "version")
    assert_equal "2.6.0", receipt.dig("readback", "preReleaseVersion", "version")
    assert_equal 5, @client.binding_reads
  end

  def test_existing_manual_is_a_fresh_checked_noop
    @client.release_type = "MANUAL"
    receipt = @runner.run
    assert_equal "already-manual", receipt.fetch("action")
    assert_equal false, receipt.fetch("writeAttempted")
    assert_equal "MANUAL", receipt.dig("readback", "version", "releaseType")
    assert_equal 3, @client.binding_reads
    assert_empty @client.writes
  end

  def test_wrong_or_ambiguous_identity_never_writes
    { bundle_id: "com.other.app", build_number: "16", prerelease_version: "2.5.0",
      version_number: "2.5.0", platform: "MAC_OS", duplicate_apps: true, duplicate_versions: true,
      processing_state: "PROCESSING", expired: true }.each do |attribute, invalid|
      setup
      @client.public_send("#{attribute}=", invalid)
      assert_raises(BoardseshStoreReleaseControl::Error, attribute.to_s) { @runner.run }
      assert_empty @client.writes
      assert_equal "failed-before-write", @runner.receipt.fetch("status")
    end
  end

  def test_noneditable_and_scheduled_releases_never_write
    %w[WAITING_FOR_REVIEW IN_REVIEW ACCEPTED PENDING_DEVELOPER_RELEASE REJECTED METADATA_REJECTED DEVELOPER_REJECTED].each do |state|
      setup
      @client.state = state
      assert_raises(BoardseshStoreReleaseControl::Error) { @runner.run }
      assert_empty @client.writes
    end
    setup
    @client.release_type = "SCHEDULED"
    assert_raises(BoardseshStoreReleaseControl::Error) { @runner.run }
    assert_empty @client.writes
  end

  def test_ready_for_review_can_set_manual_without_submitting
    @client.state = "READY_FOR_REVIEW"
    assert_equal "verified", @runner.run.fetch("status")
    assert_equal "READY_FOR_REVIEW", @client.state
    assert_equal ["version"], @client.writes
  end

  def test_races_before_final_write_and_noop_are_rejected
    ["AFTER_APPROVAL", "MANUAL"].each do |release_type|
      { app_id: "changed-app", bundle_id: "com.other.app", build_id: "changed-build", build_number: "18",
        version_id: "changed-version", state: "WAITING_FOR_REVIEW", expired: true, processing_state: "INVALID" }.each do |attribute, changed|
        setup
        @client.release_type = release_type
        @client.before_binding = ->(count) { @client.public_send("#{attribute}=", changed) if count == 3 }
        assert_raises(BoardseshStoreReleaseControl::Error, "#{release_type} #{attribute}") { @runner.run }
        assert_empty @client.writes
      end
    end
  end

  def test_release_setting_change_between_snapshots_is_not_overwritten
    @client.before_binding = ->(count) { @client.release_type = "MANUAL" if count == 2 }
    assert_raises(BoardseshStoreReleaseControl::Error) { @runner.run }
    assert_empty @client.writes
  end

  def test_wrong_or_unconfirmed_readback_is_a_failure_after_one_write
    [-> { @client.release_type = "AFTER_APPROVAL" }, -> { @client.build_id = "changed-build" }, -> { @client.prerelease_version = "2.5.0" }].each do |mutation|
      setup
      @client.after_write = mutation
      assert_raises(BoardseshStoreReleaseControl::Error) { @runner.run }
      assert_equal ["version"], @client.writes
      assert_equal "outcome-unconfirmed", @runner.receipt.fetch("status")
      assert_equal true, @runner.receipt.fetch("writeAttempted")
    end
  end

  def test_last_readback_binding_change_never_reports_success
    @client.before_binding = ->(count) { @client.build_id = "changed-build" if count == 5 }
    assert_raises(BoardseshStoreReleaseControl::Error) { @runner.run }
    assert_equal "outcome-unconfirmed", @runner.receipt.fetch("status")
    assert_equal ["version"], @client.writes
  end

  def test_ambiguous_write_is_retained_as_unconfirmed_without_retry
    @client.write_error = BoardseshStoreReleaseControl::Error.new("Ambiguous transport outcome")
    assert_raises(BoardseshStoreReleaseControl::Error) { @runner.run }
    assert_equal ["version"], @client.writes
    assert_equal "outcome-unconfirmed", @runner.receipt.fetch("status")
  end

  class Transport
    attr_accessor :use_ssl, :open_timeout, :read_timeout, :max_retries
    attr_reader :requests
    def initialize(code: "200", timeout: false)
      @code, @timeout, @requests = code, timeout, []
    end
    def request(request)
      @requests << request
      raise Net::ReadTimeout if @timeout
      Struct.new(:code, :body).new(@code, "secret response body")
    end
  end

  def test_transport_payload_can_only_set_manual_and_disables_automatic_retries
    transport = Transport.new
    client = BoardseshStoreReleaseControl::Client.new(token: -> { "secret-token" }, transport: ->(_uri) { transport })
    client.make_manual("version-1")
    request = transport.requests.fetch(0)
    assert_equal "PATCH", request.method
    assert_equal "/v1/appStoreVersions/version-1", request.path
    assert_equal({ "data" => { "type" => "appStoreVersions", "id" => "version-1", "attributes" => { "releaseType" => "MANUAL" } } }, JSON.parse(request.body))
    assert_equal 0, transport.max_retries
    assert_raises(BoardseshStoreReleaseControl::Error) { client.request("PATCH", "/v1/apps/app", {}) }
    assert_raises(BoardseshStoreReleaseControl::Error) { client.make_manual("version-1/relationships/build") }
    assert_equal 1, transport.requests.length
  end

  def test_timeout_and_server_error_each_attempt_one_write_and_hide_response_secrets
    [Transport.new(timeout: true), Transport.new(code: "500")].each do |transport|
      client = BoardseshStoreReleaseControl::Client.new(token: -> { "secret-token" }, transport: ->(_uri) { transport })
      error = assert_raises(BoardseshStoreReleaseControl::Error) { client.make_manual("version-1") }
      assert_equal 1, transport.requests.length
      refute_match(/secret/, error.message)
    end
  end
end
