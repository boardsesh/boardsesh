# frozen_string_literal: true

require "minitest/autorun"
require "tmpdir"
require "fileutils"
require_relative "../lib/store_review_submission"

class StoreReviewSubmissionTest < Minitest::Test
  class FakeApple
    attr_reader :writes, :submissions
    attr_accessor :keywords, :context_version, :after_write, :attached_build_id, :new_cpp_version

    def initialize(report)
      @report, @writes, @submissions, @keywords = report, [], {}, ["keyword-1"]
      @context_version = "app-version"
    end

    def list(path)
      case path
      when /\/reviewSubmissions\?/
        @submissions.map { |id, entry| { "id" => id, "attributes" => { "platform" => "IOS", "state" => entry.fetch("state") } } }
      when %r{/reviewSubmissions/([^/]+)/items\?}
        @submissions.fetch(Regexp.last_match(1)).fetch("items")
      when /\/searchKeywords\?/ then @keywords.map { |id| { "id" => id } }
      when %r{/appCustomProductPages/([^/]+)/appCustomProductPageVersions\?}
        page = @report.fetch("customProductPages").find { |entry| entry.fetch("id") == Regexp.last_match(1) }
        versions = page.fetch("versions").map { |version| { "id" => version.fetch("id"), "attributes" => version.slice("version", "state") } }
        versions << { "id" => "newer-cpp-version", "attributes" => { "version" => "2", "state" => "PREPARE_FOR_SUBMISSION" } } if @new_cpp_version
        versions
      else raise "Unexpected GET collection #{path}"
      end
    end

    def request(method, path)
      raise "Only reads belong here" unless method == "GET"
      case path
      when "/v1/appStoreVersions/app-version?include=app,build"
        { "data" => { "id" => "app-version", "attributes" => @report.fetch("version").reject { |key, _entry| key == "id" }, "relationships" => {
          "app" => { "data" => { "type" => "apps", "id" => "app" } },
          "build" => { "data" => { "type" => "builds", "id" => @attached_build_id || @report.fetch("build").fetch("id") } }
        } } }
      when %r{/reviewSubmissions/([^?]+)\?}
        id = Regexp.last_match(1)
        { "data" => { "id" => id, "attributes" => { "platform" => "IOS", "state" => @submissions.fetch(id).fetch("state") }, "relationships" => {
          "app" => { "data" => { "type" => "apps", "id" => "app" } },
          "appStoreVersionForReview" => { "data" => { "type" => "appStoreVersions", "id" => @context_version } }
        } } }
      when %r{/appCustomProductPages/([^?]+)\?}
        page = @report.fetch("customProductPages").find { |entry| entry.fetch("id") == Regexp.last_match(1) }
        { "data" => { "id" => page.fetch("id"), "attributes" => { "name" => page.fetch("referenceName"), "visible" => page.fetch("visible") }, "relationships" => { "app" => { "data" => { "type" => "apps", "id" => "app" } } } } }
      when %r{/appCustomProductPageVersions/([^?]+)\?}
        id = Regexp.last_match(1)
        page = @report.fetch("customProductPages").find { |entry| entry.fetch("versions").any? { |version| version.fetch("id") == id } }
        version = page.fetch("versions").find { |entry| entry.fetch("id") == id }
        { "data" => { "id" => id, "attributes" => version.slice("version", "state").merge("deepLink" => "https://www.boardsesh.com/board"), "relationships" => { "appCustomProductPage" => { "data" => { "type" => "appCustomProductPages", "id" => page.fetch("id") } } } } }
      else raise "Unexpected GET #{path}"
      end
    end

    def item(relationship, id, state = "READY_FOR_REVIEW")
      type = relationship == "appStoreVersion" ? "appStoreVersions" : "appCustomProductPageVersions"
      { "id" => "item-#{id}", "attributes" => { "state" => state }, "relationships" => { relationship => { "data" => { "type" => type, "id" => id } } } }
    end

    def request_once(method, path, body)
      @writes << [method, path, body]
      payload = body.fetch("data")
      result = if path == "/v1/reviewSubmissions" && method == "POST"
        id = "submission-#{@submissions.length + 1}"
        @submissions[id] = { "state" => "READY_FOR_REVIEW", "items" => [] }
        { "id" => id, "attributes" => { "state" => "READY_FOR_REVIEW" } }
      elsif path == "/v1/reviewSubmissionItems" && method == "POST"
        relationships = payload.fetch("relationships")
        id = relationships.dig("reviewSubmission", "data", "id")
        relationship = (relationships.keys - ["reviewSubmission"]).first
        resource = item(relationship, relationships.dig(relationship, "data", "id"))
        @submissions.fetch(id).fetch("items") << resource
        resource
      elsif method == "PATCH" && path.start_with?("/v1/reviewSubmissions/")
        raise "Unexpected mutation attributes" unless payload.fetch("attributes") == { "submitted" => true }
        submission = @submissions.fetch(payload.fetch("id"))
        submission["state"] = "WAITING_FOR_REVIEW"
        submission.fetch("items").each do |entry|
          if entry.dig("relationships", "appStoreVersion")
            @report["version"]["appStoreState"] = "WAITING_FOR_REVIEW"
          else
            id = entry.dig("relationships", "appCustomProductPageVersion", "data", "id")
            @report.fetch("customProductPages").flat_map { |page| page.fetch("versions") }.find { |version| version.fetch("id") == id }["state"] = "WAITING_FOR_REVIEW"
          end
        end
        { "id" => payload.fetch("id"), "attributes" => { "state" => submission.fetch("state") } }
      else raise "Unexpected mutation #{method} #{path}"
      end
      @after_write&.call(method, path)
      { "data" => result }
    end
  end

  def setup
    @directory = Dir.mktmpdir("store-review-test")
    @manifest = {
      "locales" => { "en-US" => ["en-US"], "es" => %w[es-ES es-MX], "fr" => ["fr-FR"], "de" => ["de-DE"] },
      "targets" => %w[kilter tension moonboard spray].to_h { |target| [target, { "localizations" => %w[en-US es fr de].to_h { |locale| [locale, { "promotionalText" => "#{target} #{locale}" }] } }] }
    }
    @manifest.fetch("locales").values.flatten.each do |locale|
      FileUtils.mkdir_p(File.join(@directory, locale))
      BoardseshStoreReview::METADATA_FILES.each { |field, filename| File.write(File.join(@directory, locale, filename), "#{locale}: #{field}\n") }
    end
    @report = {
      "appId" => "app", "identityErrors" => [], "auditedAt" => "earlier",
      "version" => { "id" => "app-version", "versionString" => "2.6.0", "platform" => "IOS", "appStoreState" => "PREPARE_FOR_SUBMISSION", "releaseType" => "MANUAL" },
      "build" => { "id" => "build", "version" => "17", "processingState" => "VALID", "expired" => false, "uploadedDate" => "earlier", "preReleaseVersion" => { "version" => "2.6.0", "platform" => "IOS" } },
      "localizations" => localizations("default"),
      "customProductPages" => @manifest.fetch("targets").keys.map do |target|
        { "target" => target, "id" => "page-#{target}", "referenceName" => "Boardsesh #{target}", "visible" => true,
          "versions" => [{ "id" => "version-#{target}", "version" => "1", "state" => "PREPARE_FOR_SUBMISSION", "localizations" => localizations(target) }] }
      end
    }
    @client = FakeApple.new(@report)
    @audit_calls = 0
  end

  def teardown
    FileUtils.remove_entry(@directory)
  end

  def localizations(target)
    @manifest.fetch("locales").flat_map do |app_locale, locales|
      locales.map do |locale|
        metadata = BoardseshStoreReview::METADATA_FILES.to_h { |field, _file| [field, { "text" => "#{locale}: #{field}", "sha256" => Digest::SHA256.hexdigest("#{locale}: #{field}") }] }
        if target != "default"
          metadata["promotionalText"] = { "text" => "#{target} #{app_locale}", "sha256" => Digest::SHA256.hexdigest("#{target} #{app_locale}") }
        end
        { "id" => "#{target}-#{locale}", "locale" => locale, "metadata" => metadata,
          "screenshotSets" => BoardseshStoreReview::DEFAULT_COUNTS.map do |display, count|
            count = 9 if target != "default"
            width, height = BoardseshCPP::Runner::DISPLAY_DIMENSIONS.fetch(display).first
            { "id" => "#{target}-#{locale}-#{display}", "displayType" => display, "count" => count,
              "screenshots" => (1..count).map do |position|
                { "id" => "#{target}-#{locale}-#{display}-#{position}", "position" => position, "fileName" => "#{position}.png", "fileSize" => 123456,
                  "sourceFileChecksum" => Digest::MD5.hexdigest("#{target}-#{locale}-#{display}-#{position}"), "processingState" => "COMPLETE",
                  "imageAsset" => { "templateUrl" => "https://example.com/transient", "width" => width, "height" => height } }
              end }
          end }
      end
    end
  end

  def runner(selected = ["default"])
    BoardseshStoreReview::Runner.new(client: @client, audit: -> { @audit_calls += 1; Marshal.load(Marshal.dump(@report)) }, manifest: @manifest, metadata_root: @directory, selected: selected)
  end

  def plan(selected = ["default"])
    runner(selected).run(action: "plan")
  end

  def submit(hash, selected = ["default"])
    runner(selected).run(action: "submit", expected_sha256: hash)
  end

  def test_default_plan_ignores_unselected_incomplete_cpp_and_preserves_screenshot_order
    @report["customProductPages"] = []
    result = plan
    images = result.fetch("snapshot").fetch("surfaces").first.fetch("localizations").flat_map { |locale| locale.fetch("screenshotSets").flat_map { |set| set.fetch("screenshots") } }
    assert_equal 150, images.length
    assert_empty @client.writes
    assert_equal (1..6).to_a, result.dig("snapshot", "surfaces", 0, "localizations", 0, "screenshotSets", 0, "screenshots").map { |image| image.fetch("position") }
  end

  def test_default_submission_has_only_allowed_writes_and_idempotent_retry
    digest = plan.fetch("snapshotSha256")
    result = submit(digest)
    assert_equal "submitted", result.fetch("action")
    assert_equal %w[POST POST PATCH], @client.writes.map(&:first)
    assert_equal "MANUAL", @report.dig("version", "releaseType")
    writes = @client.writes.length
    assert_equal "already-submitted", submit(digest).fetch("action")
    assert_equal writes, @client.writes.length
  end

  def test_cpp_snapshot_binds_keywords_and_has_180_images
    result = plan(["kilter"])
    locale = result.dig("snapshot", "surfaces", 0, "localizations", 0)
    assert_equal ["keyword-1"], locale.fetch("keywordIds")
    assert_equal 180, result.dig("snapshot", "surfaces", 0, "localizations").sum { |entry| entry.fetch("screenshotSets").sum { |set| set.fetch("count") } }
    @client.keywords = ["keyword-2"]
    assert_raises(BoardseshStoreReview::Error) { submit(result.fetch("snapshotSha256"), ["kilter"]) }
    assert_empty @client.writes
  end

  def test_cpp_only_submission_and_retry_bind_exact_app_version
    digest = plan(["kilter"]).fetch("snapshotSha256")
    assert_equal "submitted", submit(digest, ["kilter"]).fetch("action")
    writes = @client.writes.length
    assert_equal "already-submitted", submit(digest, ["kilter"]).fetch("action")
    assert_equal writes, @client.writes.length
    @client.context_version = "old-2.5-version"
    assert_raises(BoardseshStoreReview::Error) { submit(digest, ["kilter"]) }
    assert_equal writes, @client.writes.length
  end

  def test_fresh_build_swap_after_asset_scan_blocks_submission
    digest = plan.fetch("snapshotSha256")
    @client.after_write = ->(_method, path) { @client.attached_build_id = "unexpected-build" if path == "/v1/reviewSubmissionItems" }
    error = assert_raises(BoardseshStoreReview::Error) { submit(digest) }
    assert_match(/Current release\/build binding/, error.message)
    refute @client.writes.any? { |method, _path, _body| method == "PATCH" }
  end

  def test_fresh_build_swap_prevents_successful_noop
    digest = plan.fetch("snapshotSha256")
    submit(digest)
    writes = @client.writes.length
    @client.attached_build_id = "unexpected-build"
    assert_raises(BoardseshStoreReview::Error) { submit(digest) }
    assert_equal writes, @client.writes.length
  end

  def test_newer_cpp_after_asset_scan_blocks_submission
    digest = plan(["kilter"]).fetch("snapshotSha256")
    @client.after_write = ->(_method, path) { @client.new_cpp_version = true if path == "/v1/reviewSubmissionItems" }
    error = assert_raises(BoardseshStoreReview::Error) { submit(digest, ["kilter"]) }
    assert_match(/Current CPP version/, error.message)
    refute @client.writes.any? { |method, _path, _body| method == "PATCH" }
  end

  def test_newer_cpp_prevents_successful_noop
    digest = plan(["kilter"]).fetch("snapshotSha256")
    submit(digest, ["kilter"])
    writes = @client.writes.length
    @client.new_cpp_version = true
    assert_raises(BoardseshStoreReview::Error) { submit(digest, ["kilter"]) }
    assert_equal writes, @client.writes.length
  end

  def test_unrelated_historical_rejected_and_unknown_items_do_not_block
    @client.submissions["old-app"] = { "state" => "COMPLETE", "items" => [@client.item("appStoreVersion", "old-version", "REJECTED")] }
    @client.submissions["old-event"] = { "state" => "COMPLETE", "items" => [{ "id" => "old-event", "attributes" => { "state" => "REMOVED" }, "relationships" => { "appEvent" => { "data" => { "type" => "appEvents", "id" => "event" } } } }] }
    digest = plan.fetch("snapshotSha256")
    assert_equal "submitted", submit(digest).fetch("action")
  end

  def test_historical_removed_membership_of_selected_version_requires_inspection
    @client.submissions["old-app"] = { "state" => "COMPLETE", "items" => [@client.item("appStoreVersion", "app-version", "REMOVED")] }
    digest = plan.fetch("snapshotSha256")
    error = assert_raises(BoardseshStoreReview::Error) { submit(digest) }
    assert_match(/incompatible review submission/, error.message)
    assert_empty @client.writes
  end

  def test_rejected_app_versions_require_resolution_before_any_write
    digest = plan.fetch("snapshotSha256")
    %w[REJECTED METADATA_REJECTED DEVELOPER_REJECTED].each do |state|
      @report["version"]["appStoreState"] = state
      error = assert_raises(BoardseshStoreReview::Error) { submit(digest) }
      assert_match(/requires rejection resolution in App Store Connect/, error.message)
      assert_empty @client.writes
    end
  end

  def test_rejected_cpp_requires_resolution_before_any_write
    digest = plan(["kilter"]).fetch("snapshotSha256")
    @report.fetch("customProductPages").first.fetch("versions").first["state"] = "REJECTED"
    @client.submissions["rejected"] = { "state" => "UNRESOLVED_ISSUES", "items" => [@client.item("appCustomProductPageVersion", "version-kilter", "REJECTED")] }
    error = assert_raises(BoardseshStoreReview::Error) { submit(digest, ["kilter"]) }
    assert_match(/requires rejection resolution in App Store Connect/, error.message)
    assert_empty @client.writes
  end

  def test_selected_membership_with_unresolved_issues_cannot_create_a_new_draft
    digest = plan.fetch("snapshotSha256")
    @client.submissions["unresolved"] = { "state" => "UNRESOLVED_ISSUES", "items" => [@client.item("appStoreVersion", "app-version", "REJECTED")] }
    assert_raises(BoardseshStoreReview::Error) { submit(digest) }
    assert_empty @client.writes
  end

  def test_changed_text_or_unfinished_screenshot_prevents_all_writes
    digest = plan.fetch("snapshotSha256")
    @report.dig("localizations", 0, "metadata", "whatsNew")["text"] = "Old notes"
    assert_raises(BoardseshStoreReview::Error) { submit(digest) }
    assert_empty @client.writes
  end

  def test_incomplete_counts_and_duplicate_locales_prevent_writes
    @report.dig("localizations", 0, "screenshotSets", 0, "screenshots").pop
    assert_raises(BoardseshStoreReview::Error) { plan }
    @report["localizations"] << @report.fetch("localizations").first
    assert_raises(BoardseshStoreReview::Error) { plan }
    assert_empty @client.writes
  end

  def test_processing_and_invalid_dimensions_prevent_writes
    image = @report.dig("localizations", 0, "screenshotSets", 0, "screenshots", 0)
    image["processingState"] = "UPLOAD_COMPLETE"
    assert_raises(BoardseshStoreReview::Error) { plan }
    image["processingState"] = "COMPLETE"
    image["imageAsset"]["width"] = 1
    assert_raises(BoardseshStoreReview::Error) { plan }
    assert_empty @client.writes
  end

  def test_stale_hash_and_automatic_rollout_are_rejected_without_writes
    assert_raises(BoardseshStoreReview::Error) { submit("0" * 64) }
    @report["version"]["releaseType"] = "AFTER_APPROVAL"
    assert_raises(BoardseshStoreReview::Error) { plan }
    assert_empty @client.writes
  end

  def test_incidental_timestamps_and_cdn_url_do_not_change_hash
    before = plan.fetch("snapshotSha256")
    @report["auditedAt"] = "later"
    @report["build"]["uploadedDate"] = "later"
    @report.dig("localizations", 0, "screenshotSets", 0, "screenshots", 0, "imageAsset")["templateUrl"] = "https://different.example.com"
    assert_equal before, plan.fetch("snapshotSha256")
  end

  def test_an_owned_nonempty_subset_draft_resumes_without_duplicate_items
    @client.submissions["owned"] = { "state" => "READY_FOR_REVIEW", "items" => [@client.item("appStoreVersion", "app-version")] }
    selected = %w[default kilter]
    digest = plan(selected).fetch("snapshotSha256")
    assert_equal "submitted", submit(digest, selected).fetch("action")
    assert_equal ["/v1/reviewSubmissionItems", "/v1/reviewSubmissions/owned"], @client.writes.map { |write| write[1] }
  end

  def test_mixed_or_empty_unowned_draft_is_not_reused
    digest = plan.fetch("snapshotSha256")
    @client.submissions["mixed"] = { "state" => "READY_FOR_REVIEW", "items" => [@client.item("appStoreVersion", "app-version"), @client.item("appCustomProductPageVersion", "other")] }
    assert_raises(BoardseshStoreReview::Error) { submit(digest) }
    @client.submissions.clear
    @client.submissions["empty"] = { "state" => "READY_FOR_REVIEW", "items" => [] }
    assert_raises(BoardseshStoreReview::Error) { submit(digest) }
    assert_empty @client.writes
  end

  def test_cpp_review_context_must_be_exact_app_version
    @client.context_version = "old-2.5-version"
    digest = plan(["kilter"]).fetch("snapshotSha256")
    assert_raises(BoardseshStoreReview::Error) { submit(digest, ["kilter"]) }
    refute @client.writes.any? { |method, _path, _body| method == "PATCH" }
  end

  def test_content_change_after_draft_creation_prevents_irreversible_submit
    digest = plan.fetch("snapshotSha256")
    @client.after_write = ->(_method, path) { @report.dig("localizations", 0, "screenshotSets", 0, "screenshots", 0)["fileSize"] += 1 if path == "/v1/reviewSubmissionItems" }
    assert_raises(BoardseshStoreReview::Error) { submit(digest) }
    refute @client.writes.any? { |method, _path, _body| method == "PATCH" }
  end

  def test_keyword_change_after_item_creation_is_never_overwritten_or_submitted
    digest = plan(["kilter"]).fetch("snapshotSha256")
    @client.after_write = ->(_method, path) { @client.keywords = ["changed"] if path == "/v1/reviewSubmissionItems" }
    assert_raises(BoardseshStoreReview::Error) { submit(digest, ["kilter"]) }
    assert_equal ["changed"], @client.keywords
    refute @client.writes.any? { |method, _path, _body| method == "PATCH" }
  end

  def test_unknown_review_item_or_duplicate_items_fail_closed
    digest = plan.fetch("snapshotSha256")
    item = @client.item("appStoreVersion", "app-version")
    @client.submissions["bad"] = { "state" => "READY_FOR_REVIEW", "items" => [item, item] }
    assert_raises(BoardseshStoreReview::Error) { submit(digest) }
    @client.submissions["bad"]["items"] = [item.merge("relationships" => item.fetch("relationships").merge("appEvent" => { "data" => { "type" => "appEvents", "id" => "event" } }))]
    assert_raises(BoardseshStoreReview::Error) { submit(digest) }
    assert_empty @client.writes
  end

  class TimeoutTransport
    attr_accessor :use_ssl, :open_timeout, :read_timeout
    attr_reader :attempts
    def initialize
      @attempts = 0
    end
    def request(_request)
      @attempts += 1
      raise Net::ReadTimeout
    end
  end

  def test_ambiguous_post_and_patch_are_never_retried
    %w[POST PATCH].each do |method|
      transport = TimeoutTransport.new
      client = BoardseshStoreReview::Client.new(token: -> { "secret" }, transport: ->(_uri) { transport })
      path = method == "POST" ? "/v1/reviewSubmissions" : "/v1/reviewSubmissions/submission-1"
      error = assert_raises(BoardseshStoreReview::Error) { client.request_once(method, path, { "data" => {} }) }
      assert_match(/ambiguous/, error.message)
      assert_equal 1, transport.attempts
      refute_match(/secret/, error.message)
    end
  end
end
