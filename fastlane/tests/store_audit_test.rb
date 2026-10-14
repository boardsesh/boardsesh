# frozen_string_literal: true

require "minitest/autorun"
require "tmpdir"
require_relative "../lib/store_audit"

class StoreAuditTest < Minitest::Test
  class FakeApple
    attr_reader :requests
    attr_accessor :build_number, :prerelease_version, :screenshots, :order, :versions, :cpp_pages, :review_submissions, :review_items

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
      @review_submissions, @review_items = [], {}
    end

    def list(path)
      @requests << ["GET", path]
      case path
      when /\/apps\/app\/appStoreVersions\?/ then @versions
      when /\/apps\/app\/appCustomProductPages\?/ then @cpp_pages
      when /\/apps\/app\/reviewSubmissions\?/ then @review_submissions
      when %r{\A/v1/reviewSubmissions/([^/]+)/items\?} then @review_items.fetch(Regexp.last_match(1))
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

  def review_submission(id, state, context: "release")
    { "id" => id, "type" => "reviewSubmissions", "attributes" => { "platform" => "IOS", "state" => state, "reviewNotes" => "secret" },
      "relationships" => { "app" => { "data" => { "type" => "apps", "id" => "app" } },
        "appStoreVersionForReview" => { "data" => context && { "type" => "appStoreVersions", "id" => context } },
        "submittedByActor" => { "data" => { "type" => "actors", "id" => "private-actor" } } } }
  end

  def review_item(id, state, relationship = "appStoreVersion", resource_id = "release")
    { "id" => id, "type" => "reviewSubmissionItems", "attributes" => { "state" => state, "reviewNotes" => "secret" },
      "relationships" => { relationship => { "data" => { "type" => BoardseshStoreAudit::Apple::REVIEW_ITEM_TYPES.fetch(relationship), "id" => resource_id } } } }
  end

  def test_review_inventory_keeps_separate_app_cpp_and_removed_history_without_actor_data
    client = FakeApple.new
    client.review_submissions = [review_submission("app-review", "WAITING_FOR_REVIEW"), review_submission("cpp-review", "IN_REVIEW"), review_submission("old-review", "COMPLETE")]
    client.review_items = { "app-review" => [review_item("app-item", "READY_FOR_REVIEW")],
      "cpp-review" => [review_item("cpp-item", "READY_FOR_REVIEW", "appCustomProductPageVersion", "cpp-version")],
      "old-review" => [review_item("old-item", "REMOVED")] }
    report = apple(client).run
    reviews = report.fetch("reviewSubmissions")
    assert_equal %w[WAITING_FOR_REVIEW IN_REVIEW COMPLETE], reviews.map { |review| review.fetch("state") }
    assert_equal "release", reviews[1].dig("appStoreVersionForReview", "id")
    assert_equal "appCustomProductPageVersion", reviews[1].dig("items", 0, "resources", 0, "relationship")
    assert_equal "REMOVED", reviews[2].dig("items", 0, "state")
    assert reviews.none? { |review| review.fetch("membershipAmbiguous") }
    refute_match(/secret|private-actor|submittedByActor/, JSON.generate(report))
    assert client.requests.all? { |method, _path| method == "GET" }
  end

  def test_review_item_inventory_uses_linkage_without_expanding_resources
    client = FakeApple.new
    client.review_submissions = [review_submission("cpp-review", "IN_REVIEW")]
    client.review_items = { "cpp-review" => [review_item("cpp-item", "READY_FOR_REVIEW", "appCustomProductPageVersion", "cpp-version")] }

    report = apple(client).run

    item_requests = client.requests.select { |_method, path| path.start_with?("/v1/reviewSubmissions/") }
    assert_equal [["GET", "/v1/reviewSubmissions/cpp-review/items?limit=200"]], item_requests
    assert_equal "cpp-version", report.dig("reviewSubmissions", 0, "items", 0, "resources", 0, "id")
    refute report.dig("reviewSubmissions", 0, "membershipAmbiguous")
  end

  def test_review_inventory_preserves_other_item_types_and_unknown_states
    client = FakeApple.new
    client.review_submissions = [review_submission("items-review", "FUTURE_STATE", context: nil)]
    client.review_items = { "items-review" => BoardseshStoreAudit::Apple::REVIEW_ITEM_TYPES.keys.each_with_index.map { |relationship, index| review_item("item-#{index}", "READY_FOR_REVIEW", relationship, "resource-#{index}") } }
    review = apple(client).run.fetch("reviewSubmissions").first
    assert_nil review.fetch("appStoreVersionForReview")
    assert_equal "FUTURE_STATE", review.fetch("state")
    assert_equal BoardseshStoreAudit::Apple::REVIEW_ITEM_TYPES.keys, review.fetch("items").flat_map { |item| item.fetch("resources").map { |resource| resource.fetch("relationship") } }
  end

  def test_review_inventory_marks_empty_null_and_mixed_membership_ambiguous
    client = FakeApple.new
    client.review_submissions = [review_submission("draft", "READY_FOR_REVIEW", context: nil)]
    client.review_items = { "draft" => [] }
    assert apple(client).run.fetch("reviewSubmissions").first.fetch("membershipAmbiguous")
    item = review_item("item", "REMOVED")
    item["relationships"]["appStoreVersion"]["data"] = nil
    client.review_items["draft"] = [item]
    assert apple(client).run.fetch("reviewSubmissions").first.dig("items", 0, "bindingAmbiguous")
    item = review_item("item", "READY_FOR_REVIEW")
    item["relationships"].merge!(review_item("other", "READY_FOR_REVIEW", "appEvent", "event").fetch("relationships"))
    client.review_items["draft"] = [item]
    review = apple(client).run.fetch("reviewSubmissions").first
    assert review.fetch("membershipAmbiguous")
    assert_equal 2, review.dig("items", 0, "resources").length
  end

  def test_review_inventory_rejects_duplicate_ids_membership_and_wrong_app
    client = FakeApple.new
    submission = review_submission("review", "WAITING_FOR_REVIEW")
    item = review_item("item", "READY_FOR_REVIEW")
    client.review_submissions = [submission, submission]
    client.review_items = { "review" => [item] }
    assert_raises(BoardseshStoreAudit::Error) { apple(client).run }
    client.review_submissions = [submission]
    client.review_items["review"] = [item, item]
    assert_raises(BoardseshStoreAudit::Error) { apple(client).run }
    client.review_items["review"] = [item, review_item("different-item", "READY_FOR_REVIEW")]
    assert_raises(BoardseshStoreAudit::Error) { apple(client).run }
    client.review_items["review"] = [item]
    submission["relationships"]["app"]["data"]["id"] = "wrong-app"
    assert_raises(BoardseshStoreAudit::Error) { apple(client).run }
  end

  def test_review_inventory_rejects_missing_or_malformed_linkage_and_state
    client = FakeApple.new
    submission = review_submission("review", "WAITING_FOR_REVIEW")
    client.review_submissions = [submission]
    client.review_items = { "review" => [review_item("item", "READY_FOR_REVIEW")] }
    submission["relationships"]["appStoreVersionForReview"] = {}
    assert_raises(BoardseshStoreAudit::Error) { apple(client).run }
    submission["relationships"]["appStoreVersionForReview"] = { "data" => nil }
    client.review_items["review"].first["relationships"]["appStoreVersion"]["data"]["type"] = "actors"
    assert_raises(BoardseshStoreAudit::Error) { apple(client).run }
    client.review_items["review"] = [review_item("item", { "contact" => "secret" })]
    assert_raises(BoardseshStoreAudit::Error) { apple(client).run }
  end

end
