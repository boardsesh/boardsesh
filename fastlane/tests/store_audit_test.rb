# frozen_string_literal: true

require "minitest/autorun"
require "tmpdir"
require_relative "../lib/store_audit"

class StoreAuditTest < Minitest::Test
  class FakeApple
    attr_reader :requests
    attr_accessor :build_number, :prerelease_version, :screenshots, :order, :versions, :cpp_pages

    def initialize
      @requests = []
      @build_number, @prerelease_version = "17", "2.6.0"
      @versions = [{ "id" => "release", "attributes" => { "versionString" => "2.6.0", "platform" => "IOS", "appStoreState" => "PREPARE_FOR_SUBMISSION", "releaseType" => "MANUAL", "reviewContactEmail" => "private@example.com" } }]
      @cpp_pages = [{ "id" => "cpp", "attributes" => { "name" => "Boardsesh Kilter", "visible" => true } }]
      @screenshots = %w[first second].map do |id|
        { "id" => id, "attributes" => {
          "fileName" => "#{id}.png", "fileSize" => 1234, "sourceFileChecksum" => "#{id}-checksum",
          "assetDeliveryState" => { "state" => "COMPLETE" }, "imageAsset" => { "templateUrl" => "https://example.com/#{id}/{w}x{h}.png", "width" => 1320, "height" => 2868 },
          "uploadOperations" => [{ "url" => "https://secret-upload.example.com/token" }]
        } }
      end
      @order = %w[second first]
    end

    def list(path)
      @requests << ["GET", path]
      case path
      when /\/apps\/app\/appStoreVersions\?/ then @versions
      when /\/apps\/app\/appCustomProductPages\?/ then @cpp_pages
      when /\/appCustomProductPages\/cpp\/appCustomProductPageVersions\?/
        [{ "id" => "cpp-version", "attributes" => { "version" => "1", "state" => "PREPARE_FOR_SUBMISSION" } }]
      when /\/(appStoreVersionLocalizations|appCustomProductPageLocalizations)\?/
        [{ "id" => "locale", "attributes" => { "locale" => "en-US", "whatsNew" => "New climbs.\n", "description" => "Climb together.", "reviewNotes" => "secret" } }]
      when /\/appScreenshotSets\?/
        [{ "id" => "screenshots", "attributes" => { "screenshotDisplayType" => "APP_IPHONE_67" } }]
      when /\/relationships\/appScreenshots\?/ then @order.map { |id| { "id" => id, "type" => "appScreenshots" } }
      when /\/appScreenshots\?/ then @screenshots
      else raise "Unexpected list #{path}"
      end
    end

    def request(method, path)
      @requests << [method, path]
      raise "Audit attempted a write" unless method == "GET"
      case path
      when "/v1/appStoreVersions/release/build"
        { "data" => { "id" => "build", "attributes" => { "version" => @build_number, "processingState" => "VALID", "expired" => false } } }
      when "/v1/builds/build/preReleaseVersion"
        { "data" => { "attributes" => { "version" => @prerelease_version, "platform" => "IOS" } } }
      else raise "Unexpected request #{path}"
      end
    end
  end

  def apple(client)
    BoardseshStoreAudit::Apple.new(
      client: client, app_id: "app", version: "2.6.0", build_number: "17",
      cpp_targets: { "kilter" => { "referenceName" => "Boardsesh Kilter" } },
      locales: %w[en-US de-DE], display_types: %w[APP_IPHONE_67 APP_IPHONE_61]
    )
  end

  def test_apple_preserves_remote_order_hashes_exact_text_and_excludes_private_fields
    client = FakeApple.new
    report = apple(client).run
    assert_empty report.fetch("identityErrors")
    assert client.requests.all? { |method, _path| method == "GET" }
    locale = report.fetch("localizations").first
    assert_equal Digest::SHA256.hexdigest("New climbs.\n"), locale.dig("metadata", "whatsNew", "sha256")
    screenshots = locale.fetch("screenshotSets").first.fetch("screenshots")
    assert_equal %w[second first], screenshots.map { |image| image.fetch("id") }
    assert_equal [1, 2], screenshots.map { |image| image.fetch("position") }
    assert_equal "second-checksum", screenshots.first.fetch("sourceFileChecksum")
    assert_equal "https://example.com/second/{w}x{h}.png", screenshots.first.dig("imageAsset", "templateUrl")
    refute_match(/secret|private@example|uploadOperations/, JSON.generate(report))
    assert report.fetch("readinessIssues").any? { |issue| issue.include?("missing locale de-DE") }
    assert report.fetch("readinessIssues").any? { |issue| issue.include?("APP_IPHONE_61") }
  end

  def test_missing_cpp_assets_are_reported_without_hiding_release_identity
    client = FakeApple.new
    client.cpp_pages = []
    report = apple(client).run
    assert_empty report.fetch("identityErrors")
    assert_includes report.fetch("readinessIssues"), "CPP kilter: expected one page, found 0"
  end

  def test_processing_and_missing_checksum_are_reported
    client = FakeApple.new
    client.screenshots.first["attributes"]["assetDeliveryState"] = { "state" => "FAILED" }
    client.screenshots.first["attributes"]["sourceFileChecksum"] = nil
    report = apple(client).run
    assert report.fetch("readinessIssues").any? { |issue| issue.include?("not COMPLETE") }
    assert report.fetch("readinessIssues").any? { |issue| issue.include?("missing source checksum") }
  end

  def test_wrong_build_is_a_failure_but_report_is_retained
    client = FakeApple.new
    client.build_number = "16"
    report = apple(client).run
    Dir.mktmpdir do |directory|
      path = File.join(directory, "audit.json")
      assert_raises(BoardseshStoreAudit::Error) { BoardseshStoreAudit.write_report(path, report) }
      assert_equal "16", JSON.parse(File.read(path)).dig("build", "version")
    end
  end

  def test_wrong_prerelease_version_fails_even_if_build_number_matches
    client = FakeApple.new
    client.prerelease_version = "2.5.0"
    assert_includes apple(client).run.fetch("identityErrors"), "Attached iOS build belongs to a different prerelease version"
  end

  def test_wrong_or_ambiguous_store_versions_fail
    client = FakeApple.new
    client.versions.first["attributes"]["versionString"] = "2.5.0"
    assert_equal 1, apple(client).run.fetch("identityErrors").length
    client = FakeApple.new
    client.versions *= 2
    assert_equal 1, apple(client).run.fetch("identityErrors").length
  end

  def test_changing_screenshot_relationship_fails_instead_of_reporting_invented_order
    client = FakeApple.new
    client.order = %w[first third]
    assert_raises(BoardseshStoreAudit::Error) { apple(client).run }
  end

end
