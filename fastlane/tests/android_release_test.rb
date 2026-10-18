# frozen_string_literal: true

require "minitest/autorun"
require "tmpdir"
require "fileutils"
require_relative "../lib/android_release"

class AndroidReleaseTest < Minitest::Test
  VERSION_CODE = 2_001_311
  def self.model(attributes)
    Struct.new(*attributes.keys, keyword_init: true).new(**attributes)
  end

  class FakePlay
    attr_accessor :uploaded_code, :existing_codes, :fail_at, :fail_track, :fail_error, :extra_tracks
    attr_reader :calls
    def initialize
      @calls, @uploaded_code, @existing_codes, @extra_tracks = [], VERSION_CODE, [2_001_310], []
    end
    def invoke(name, *arguments)
      @calls << [name, *arguments]
      raise(@fail_error || "secret private credential diagnostic") if @fail_at == name
    end
    def insert_edit(package)
      invoke(:insert_edit, package)
      AndroidReleaseTest.model(id: "edit-123")
    end
    def list_edit_tracks(package, edit)
      invoke(:list_edit_tracks, package, edit)
      AndroidReleaseTest.model(tracks: [AndroidReleaseTest.model(track: "production", releases: [
        AndroidReleaseTest.model(version_codes: @existing_codes)
      ])] + @extra_tracks)
    end
    def upload_edit_bundle(package, edit, upload_source:, content_type:)
      invoke(:upload_edit_bundle, package, edit, upload_source, content_type)
      AndroidReleaseTest.model(version_code: @uploaded_code)
    end
    def update_edit_track(package, edit, track, body)
      invoke(:update_edit_track, package, edit, track, body)
      raise "secret beta diagnostic" if @fail_track == track
    end
    def validate_edit(package, edit)
      invoke(:validate_edit, package, edit)
    end
    def commit_edit(package, edit, changes_in_review_behavior: nil, changes_not_sent_for_review: nil)
      invoke(:commit_edit, package, edit, { changes_in_review_behavior: changes_in_review_behavior,
        changes_not_sent_for_review: changes_not_sent_for_review })
    end
  end

  def setup
    @directory = Dir.mktmpdir("play-release-test-")
    @aab = File.join(@directory, "app-release.aab")
    File.write(@aab, "built-aab-fixture")
    %w[en-US es-ES].each do |locale|
      directory = File.join(@directory, locale, "changelogs")
      FileUtils.mkdir_p(directory)
      File.write(File.join(directory, "default.txt"), "Climb with your crew\n")
    end
    @play = FakePlay.new
  end

  def teardown
    FileUtils.remove_entry(@directory)
  end

  def runner(**overrides)
    options = { service: @play, aab: @aab, version_code: VERSION_CODE, version: "2.6.0",
      metadata_path: @directory, model_factory: ->(_name, attributes) { self.class.model(attributes) } }
    BoardseshAndroidRelease::Runner.new(**options.merge(overrides))
  end

  def test_uploads_once_and_updates_only_internal_and_beta_in_one_edit
    receipt = runner.run
    calls = @play.calls
    assert_equal [:insert_edit, :list_edit_tracks, :upload_edit_bundle, :update_edit_track,
      :update_edit_track, :validate_edit, :commit_edit], calls.map(&:first)
    assert calls.all? { |call| call[1] == "com.boardsesh.app" }
    updates = calls.select { |call| call.first == :update_edit_track }
    assert_equal %w[internal beta], updates.map { |call| call[3] }
    updates.each do |call|
      assert_equal "edit-123", call[2]
      release = call[4].releases.fetch(0)
      assert_equal [VERSION_CODE.to_s], release.version_codes
      assert_equal "2.6.0", release.name
      assert_equal "completed", release.status
      assert_equal %w[en-US es-ES], release.release_notes.map(&:language)
      assert_equal ["Climb with your crew"], release.release_notes.map(&:text).uniq
    end
    assert_equal({ changes_in_review_behavior: "ERROR_IF_IN_REVIEW", changes_not_sent_for_review: false }, calls.last[3])
    assert_equal "committed", receipt.fetch("action")
    assert_equal false, receipt.fetch("publicationVerified")
    assert_includes receipt.fetch("limitations").join(" "), "versionName is not independently verified"
  end

  def test_fails_before_authentication_on_invalid_labels_or_artifacts
    authenticated = false
    service = -> { authenticated = true; @play }
    ["0", "-1", "2001311x", "2100000001"].each do |code|
      assert_raises(BoardseshAndroidRelease::Error) { runner(service: service, version_code: code) }
    end
    assert_raises(BoardseshAndroidRelease::Error) { runner(service: service, version: "main") }
    assert_raises(BoardseshAndroidRelease::Error) { runner(service: service, aab: "missing.aab") }
    refute authenticated
    assert_empty @play.calls
  end

  def test_rejects_empty_and_oversized_localized_notes_before_network
    path = File.join(@directory, "en-US", "changelogs", "default.txt")
    [" ", "a" * 501].each do |text|
      File.write(path, text)
      assert_raises(BoardseshAndroidRelease::Error) { runner }
    end
    assert_empty @play.calls
  end

  def test_rejects_missing_notes
    assert_raises(BoardseshAndroidRelease::Error) { runner(metadata_path: File.join(@directory, "missing")) }
    assert_empty @play.calls
  end

  def test_refuses_existing_or_newer_version_codes_before_upload
    [VERSION_CODE, VERSION_CODE + 1].each do |code|
      @play = FakePlay.new
      @play.existing_codes = [code]
      error = assert_raises(BoardseshAndroidRelease::Error) { runner.run }
      assert_includes error.message, "refusing a stale upload"
      assert_equal [:insert_edit, :list_edit_tracks], @play.calls.map(&:first)
    end
  end

  # Play lists releases that hold no build (a draft with no bundle, a release whose
  # bundle moved to another track). They cannot make an upload stale.
  def test_skips_releases_that_hold_no_build
    @play.extra_tracks = [
      self.class.model(track: "internal", releases: [self.class.model(version_codes: nil)]),
      self.class.model(track: "beta", releases: [self.class.model(version_codes: [])])
    ]
    assert_equal "committed", runner.run["action"]
    assert_includes @play.calls.map(&:first), :upload_edit_bundle
  end

  def test_still_refuses_a_newer_build_beside_a_release_without_one
    @play.extra_tracks = [self.class.model(track: "beta", releases: [
      self.class.model(version_codes: nil), self.class.model(version_codes: [VERSION_CODE + 1])
    ])]
    error = assert_raises(BoardseshAndroidRelease::Error) { runner.run }
    assert_includes error.message, "on the beta track; refusing a stale upload"
    assert_equal [:insert_edit, :list_edit_tracks], @play.calls.map(&:first)
  end

  def test_refuses_malformed_track_codes_before_upload
    @play.existing_codes = ["bad"]
    assert_raises(BoardseshAndroidRelease::Error) { runner.run }
    assert_equal [:insert_edit, :list_edit_tracks], @play.calls.map(&:first)
  end

  def test_uploaded_code_must_match_before_either_track_is_written
    @play.uploaded_code = VERSION_CODE - 1
    error = assert_raises(BoardseshAndroidRelease::Error) { runner.run }
    assert_includes error.message, "differs from expected"
    assert_equal [:insert_edit, :list_edit_tracks, :upload_edit_bundle], @play.calls.map(&:first)
  end

  def test_beta_or_validation_failure_cannot_commit_or_delete_an_edit
    [:update_edit_track, :validate_edit].each do |operation|
      @play = FakePlay.new
      @play.fail_at = operation
      error = assert_raises(BoardseshAndroidRelease::Error) { runner.run }
      refute_includes error.message, "secret"
      refute_includes @play.calls.map(&:first), :commit_edit
      refute_includes @play.calls.map(&:first), :delete_edit
    end
  end

  def test_beta_failure_after_internal_assignment_leaves_both_uncommitted
    @play.fail_track = "beta"
    assert_raises(BoardseshAndroidRelease::Error) { runner.run }
    updates = @play.calls.select { |call| call.first == :update_edit_track }
    assert_equal %w[internal beta], updates.map { |call| call[3] }
    refute_includes @play.calls.map(&:first), :validate_edit
    refute_includes @play.calls.map(&:first), :commit_edit
  end

  def test_http_errors_retain_only_status_without_body_or_credentials
    error_class = Class.new(StandardError) { def status_code; 409; end }
    @play.fail_at = :commit_edit
    @play.fail_error = error_class.new("secret service-account response")
    error = assert_raises(BoardseshAndroidRelease::Error) { runner.run }
    assert_includes error.message, "HTTP 409"
    refute_includes error.message, "secret"
    assert_equal 1, @play.calls.count { |call| call.first == :commit_edit }
  end

  def test_commit_failure_does_not_retry_or_bypass_review_protection
    @play.fail_at = :commit_edit
    error = assert_raises(BoardseshAndroidRelease::Error) { runner.run }
    assert_includes error.message, "audit before retrying"
    assert_equal 1, @play.calls.count { |call| call.first == :commit_edit }
    refute_includes @play.calls.map(&:first), :delete_edit
  end

  def test_fails_before_opening_edit_if_client_cannot_protect_current_review
    incompatible = Object.new
    def incompatible.commit_edit(package_name, edit_id, changes_not_sent_for_review: nil); end
    error = assert_raises(BoardseshAndroidRelease::Error) { runner(service: incompatible).run }
    assert_includes error.message, "lacks strict review protection"
  end
end
