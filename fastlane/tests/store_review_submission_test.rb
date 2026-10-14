# frozen_string_literal: true

require "minitest/autorun"
require "tmpdir"
require "fileutils"
require_relative "../lib/store_review_submission"

class StoreReviewSubmissionTest < Minitest::Test
  class FakeApple
    attr_reader :writes, :submissions
    attr_accessor :keywords, :context_version, :after_write, :attached_build_id, :new_cpp_version,
      :approved_version, :approved_build, :approved_prerelease, :context_versions, :before_read

    def initialize(report)
      @report, @writes, @submissions, @keywords = report, [], {}, ["keyword-1"]
      @context_version = "app-version"
      @approved_version = { "type" => "appStoreVersions", "id" => "approved-version", "attributes" => {
        "versionString" => "2.5.0", "platform" => "IOS", "appStoreState" => "READY_FOR_SALE", "appVersionState" => "READY_FOR_DISTRIBUTION", "createdDate" => "2026-09-01T00:00:00Z"
      }, "relationships" => { "app" => { "data" => { "type" => "apps", "id" => "app" } }, "build" => { "data" => { "type" => "builds", "id" => "approved-build" } } } }
      @approved_build = { "type" => "builds", "id" => "approved-build", "attributes" => { "version" => "12", "processingState" => "VALID", "expired" => false, "minOsVersion" => "16.4" } }
      @approved_prerelease = { "type" => "preReleaseVersions", "id" => "approved-prerelease", "attributes" => { "version" => "2.5.0", "platform" => "IOS" } }
      @context_versions = [Marshal.load(Marshal.dump(@approved_version))]
    end

    def list(path)
      @before_read&.call(path)
      case path
      when "/v1/apps/app/appStoreVersions?filter[platform]=IOS&limit=200" then @context_versions
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
      @before_read&.call(path)
      case path
      when "/v1/appStoreVersions/approved-version?include=app,build" then { "data" => @approved_version }
      when "/v1/appStoreVersions/approved-version/build" then { "data" => @approved_build }
      when "/v1/builds/approved-build/preReleaseVersion" then { "data" => @approved_prerelease }
      when "/v1/appStoreVersions/app-version?include=app,build"
        { "data" => { "id" => "app-version", "attributes" => @report.fetch("version").reject { |key, _entry| key == "id" }, "relationships" => {
          "app" => { "data" => { "type" => "apps", "id" => "app" } },
          "build" => { "data" => { "type" => "builds", "id" => @attached_build_id || @report.fetch("build").fetch("id") } }
        } } }
      when %r{/reviewSubmissions/([^?]+)\?}
        id = Regexp.last_match(1)
        { "data" => { "id" => id, "attributes" => { "platform" => "IOS", "state" => @submissions.fetch(id).fetch("state") }, "relationships" => {
          "app" => { "data" => { "type" => "apps", "id" => "app" } },
          "appStoreVersionForReview" => { "data" => @context_version && { "type" => "appStoreVersions", "id" => @context_version } }
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

  def runner(selected = ["default"], context: nil)
    BoardseshStoreReview::Runner.new(client: @client, audit: -> { @audit_calls += 1; Marshal.load(Marshal.dump(@report)) }, manifest: @manifest, metadata_root: @directory, selected: selected, cpp_review_context_version_id: context)
  end

  def plan(selected = ["default"], context: nil)
    runner(selected, context: context).run(action: "plan")
  end

  def submit(hash, selected = ["default"], context: nil)
    runner(selected, context: context).run(action: "submit", expected_sha256: hash)
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
    result = plan(["kilter"], context: "approved-version")
    locale = result.dig("snapshot", "surfaces", 0, "localizations", 0)
    assert_equal ["keyword-1"], locale.fetch("keywordIds")
    assert_equal 180, result.dig("snapshot", "surfaces", 0, "localizations").sum { |entry| entry.fetch("screenshotSets").sum { |set| set.fetch("count") } }
    @client.keywords = ["keyword-2"]
    assert_raises(BoardseshStoreReview::Error) { submit(result.fetch("snapshotSha256"), ["kilter"], context: "approved-version") }
    assert_empty @client.writes
  end

  def test_cpp_only_submission_and_retry_bind_explicit_approved_context
    @client.context_version = "approved-version"
    digest = plan(["kilter"], context: "approved-version").fetch("snapshotSha256")
    assert_equal "submitted", submit(digest, ["kilter"], context: "approved-version").fetch("action")
    writes = @client.writes.length
    assert_equal "already-submitted", submit(digest, ["kilter"], context: "approved-version").fetch("action")
    assert_equal writes, @client.writes.length
    @client.context_version = "old-2.5-version"
    assert_raises(BoardseshStoreReview::Error) { submit(digest, ["kilter"], context: "approved-version") }
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
    @client.context_version = "approved-version"
    digest = plan(["kilter"], context: "approved-version").fetch("snapshotSha256")
    @client.after_write = ->(_method, path) { @client.new_cpp_version = true if path == "/v1/reviewSubmissionItems" }
    error = assert_raises(BoardseshStoreReview::Error) { submit(digest, ["kilter"], context: "approved-version") }
    assert_match(/Current CPP version/, error.message)
    refute @client.writes.any? { |method, _path, _body| method == "PATCH" }
  end

  def test_newer_cpp_prevents_successful_noop
    @client.context_version = "approved-version"
    digest = plan(["kilter"], context: "approved-version").fetch("snapshotSha256")
    submit(digest, ["kilter"], context: "approved-version")
    writes = @client.writes.length
    @client.new_cpp_version = true
    assert_raises(BoardseshStoreReview::Error) { submit(digest, ["kilter"], context: "approved-version") }
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
    digest = plan(["kilter"], context: "approved-version").fetch("snapshotSha256")
    @report.fetch("customProductPages").first.fetch("versions").first["state"] = "REJECTED"
    @client.submissions["rejected"] = { "state" => "UNRESOLVED_ISSUES", "items" => [@client.item("appCustomProductPageVersion", "version-kilter", "REJECTED")] }
    error = assert_raises(BoardseshStoreReview::Error) { submit(digest, ["kilter"], context: "approved-version") }
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

  def test_cpp_review_context_must_match_explicit_approved_version
    @client.context_version = "old-2.5-version"
    digest = plan(["kilter"], context: "approved-version").fetch("snapshotSha256")
    assert_raises(BoardseshStoreReview::Error) { submit(digest, ["kilter"], context: "approved-version") }
    refute @client.writes.any? { |method, _path, _body| method == "PATCH" }
  end

  def test_content_change_after_draft_creation_prevents_irreversible_submit
    digest = plan.fetch("snapshotSha256")
    @client.after_write = ->(_method, path) { @report.dig("localizations", 0, "screenshotSets", 0, "screenshots", 0)["fileSize"] += 1 if path == "/v1/reviewSubmissionItems" }
    assert_raises(BoardseshStoreReview::Error) { submit(digest) }
    refute @client.writes.any? { |method, _path, _body| method == "PATCH" }
  end

  def test_keyword_change_after_item_creation_is_never_overwritten_or_submitted
    @client.context_version = "approved-version"
    digest = plan(["kilter"], context: "approved-version").fetch("snapshotSha256")
    @client.after_write = ->(_method, path) { @client.keywords = ["changed"] if path == "/v1/reviewSubmissionItems" }
    assert_raises(BoardseshStoreReview::Error) { submit(digest, ["kilter"], context: "approved-version") }
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

  def standalone_plan
    plan(["moonboard"], context: "approved-version")
  end

  def standalone_submit(digest)
    submit(digest, ["moonboard"], context: "approved-version")
  end

  def test_explicit_standalone_context_keeps_release_build_and_180_assets_separate
    @report["build"]["version"] = "18"
    strict = plan(%w[default moonboard]).fetch("snapshot")
    strict["surfaces"].reject! { |surface| surface.fetch("target") == "default" }
    result = standalone_plan
    assert_equal strict, result.fetch("snapshot").reject { |key, _entry| key == "cppReviewContext" }
    assert_equal "2.6.0", result.dig("snapshot", "version", "versionString")
    assert_equal "18", result.dig("snapshot", "build", "version")
    assert_equal "2.5.0", result.dig("snapshot", "cppReviewContext", "version", "versionString")
    assert_equal "12", result.dig("snapshot", "cppReviewContext", "build", "version")
    assert_equal "approved-prerelease", result.dig("snapshot", "cppReviewContext", "build", "preReleaseVersion", "id")
    assert_equal 180, result.dig("snapshot", "surfaces", 0, "localizations").sum { |locale| locale.fetch("screenshotSets").sum { |set| set.fetch("count") } }
    refute_equal BoardseshStoreReview.digest(strict), result.fetch("snapshotSha256")
    assert_empty @client.writes
  end

  def test_context_override_is_rejected_for_default_mixed_and_invalid_ids
    [["default"], %w[default moonboard]].each do |selected|
      error = assert_raises(BoardseshStoreReview::Error) { plan(selected, context: "approved-version") }
      assert_match(/CPP-only/, error.message)
    end
    ["../approved-version", "approved?query=1", " ", "x" * 129].each do |id|
      assert_raises(BoardseshStoreReview::Error) { plan(["moonboard"], context: id) }
    end
    assert_equal 0, @audit_calls
    assert_empty @client.writes
    assert_equal plan.fetch("snapshotSha256"), plan(context: "").fetch("snapshotSha256")
  end

  def test_cpp_only_missing_or_blank_context_fails_before_reads_or_writes_for_plan_and_submit
    reads = []
    @client.before_read = ->(path) { reads << path }
    [["moonboard"], %w[kilter moonboard]].each do |selected|
      [nil, "", " ", "\t\n"].each do |context|
        %w[plan submit].each do |action|
          error = assert_raises(BoardseshStoreReview::Error) do
            runner(selected, context: context).run(action: action, expected_sha256: "0" * 64)
          end
          assert_match(/explicit approved review context|Invalid CPP review context/, error.message)
        end
      end
    end
    assert_equal 0, @audit_calls
    assert_empty reads
    assert_empty @client.writes
  end

  def test_public_selection_validator_accepts_only_explicit_cpp_or_exact_release_context
    cases = [
      [["default"], nil], [["default"], ""], [%w[default moonboard], nil],
      [["moonboard"], "approved-version"], [%w[spray kilter], "approved-version"]
    ]
    cases.each do |selected, context|
      original = selected.dup
      assert_equal true, BoardseshStoreReview::Runner.validate_selection!(selected: selected, manifest: @manifest, cpp_review_context_version_id: context)
      assert_equal original, selected
    end
    assert_equal 0, @audit_calls
    assert_empty @client.writes
  end

  def test_public_selection_validator_and_constructor_share_all_failure_rules_before_reads
    reads = []
    @client.before_read = ->(path) { reads << path }
    cases = [
      [[], nil], [["unknown"], nil], [%w[moonboard moonboard], "approved-version"],
      [["moonboard"], nil], [["moonboard"], ""], [["moonboard"], " "],
      [["moonboard"], "../approved"], [["moonboard"], "approved?query=1"], [["moonboard"], "x" * 129],
      [["default"], "approved-version"], [%w[default moonboard], "approved-version"]
    ]
    cases.each do |selected, context|
      early_error = assert_raises(BoardseshStoreReview::Error) do
        BoardseshStoreReview::Runner.validate_selection!(selected: selected, manifest: @manifest, cpp_review_context_version_id: context)
      end
      constructor_error = assert_raises(BoardseshStoreReview::Error) { runner(selected, context: context) }
      assert_equal early_error.message, constructor_error.message
    end
    assert_equal 0, @audit_calls
    assert_empty reads
    assert_empty @client.writes
  end

  def test_expired_testflight_context_can_plan_resume_and_noop_with_unexpired_release
    @client.approved_build["attributes"]["expired"] = true
    @client.context_version = "approved-version"
    @report["build"]["version"] = "18"
    @report["version"]["appStoreState"] = "WAITING_FOR_REVIEW"
    @client.submissions["moon-draft"] = { "state" => "READY_FOR_REVIEW", "items" => [@client.item("appCustomProductPageVersion", "version-moonboard")] }
    result = standalone_plan
    assert_equal true, result.dig("snapshot", "cppReviewContext", "build", "expired")
    assert_equal false, result.dig("snapshot", "build", "expired")
    assert_equal "18", result.dig("snapshot", "build", "version")
    assert_equal "submitted", standalone_submit(result.fetch("snapshotSha256")).fetch("action")
    assert_equal [["PATCH", "/v1/reviewSubmissions/moon-draft"]], @client.writes.map { |method, path, _body| [method, path] }
    assert_equal "already-submitted", standalone_submit(result.fetch("snapshotSha256")).fetch("action")
    assert_equal 1, @client.writes.length
    assert_equal "WAITING_FOR_REVIEW", @report.dig("version", "appStoreState")
    assert_equal "MANUAL", @report.dig("version", "releaseType")
  end

  def test_expired_target_release_is_rejected_even_with_valid_historical_context
    @client.approved_build["attributes"]["expired"] = true
    digest = standalone_plan.fetch("snapshotSha256")
    @report["build"]["expired"] = true
    %w[plan submit].each do |action|
      error = assert_raises(BoardseshStoreReview::Error) do
        runner(["moonboard"], context: "approved-version").run(action: action, expected_sha256: digest)
      end
      assert_match(/Attached release build is not valid/, error.message)
    end
    assert_empty @client.writes
  end

  def test_context_testflight_expiration_change_remains_bound_to_reviewed_snapshot
    digest = standalone_plan.fetch("snapshotSha256")
    @client.approved_build["attributes"]["expired"] = true
    error = assert_raises(BoardseshStoreReview::Error) { standalone_submit(digest) }
    assert_match(/differs from the reviewed snapshot/, error.message)
    assert_empty @client.writes
  end

  def test_standalone_existing_ready_draft_resumes_and_noops_without_touching_default
    @report["version"]["appStoreState"] = "WAITING_FOR_REVIEW"
    @client.context_version = "approved-version"
    @client.submissions["default-review"] = { "state" => "WAITING_FOR_REVIEW", "items" => [@client.item("appStoreVersion", "app-version")] }
    @client.submissions["moon-draft"] = { "state" => "READY_FOR_REVIEW", "items" => [@client.item("appCustomProductPageVersion", "version-moonboard")] }
    original_default = Marshal.load(Marshal.dump(@client.submissions.fetch("default-review")))
    digest = standalone_plan.fetch("snapshotSha256")
    result = standalone_submit(digest)
    assert_equal "submitted", result.fetch("action")
    assert_equal "moon-draft", result.fetch("reviewSubmissionId")
    assert_equal [["PATCH", "/v1/reviewSubmissions/moon-draft"]], @client.writes.map { |method, path, _body| [method, path] }
    assert_equal original_default, @client.submissions.fetch("default-review")
    assert_equal "WAITING_FOR_REVIEW", @report.dig("version", "appStoreState")
    assert_equal "MANUAL", @report.dig("version", "releaseType")
    assert_equal "already-submitted", standalone_submit(digest).fetch("action")
    assert_equal 1, @client.writes.length
  end

  def test_standalone_wrong_or_null_existing_draft_context_stops_before_any_write
    @client.submissions["moon-draft"] = { "state" => "READY_FOR_REVIEW", "items" => [@client.item("appCustomProductPageVersion", "version-moonboard")] }
    digest = standalone_plan.fetch("snapshotSha256")
    [nil, "app-version", "other-approved-version"].each do |context|
      @client.context_version = context
      error = assert_raises(BoardseshStoreReview::Error) { standalone_submit(digest) }
      assert_match(/different or unknown app version/, error.message)
      assert_empty @client.writes
    end
  end

  def test_standalone_wrong_owner_resource_platform_or_unapproved_version_fails_closed
    original = Marshal.load(Marshal.dump(@client.approved_version))
    mutations = [
      ->(version) { version["relationships"]["app"]["data"]["id"] = "another-app" },
      ->(version) { version["id"] = "another-version" },
      ->(version) { version["type"] = "builds" },
      ->(version) { version["attributes"]["platform"] = "MAC_OS" },
      ->(version) { version["attributes"]["versionString"] = "unknown" },
      ->(version) { version["attributes"]["appVersionState"] = "WAITING_FOR_REVIEW" },
      ->(version) { version["relationships"]["build"]["data"] = nil }
    ]
    mutations.each do |mutate|
      @client.approved_version = Marshal.load(Marshal.dump(original))
      mutate.call(@client.approved_version)
      assert_raises(BoardseshStoreReview::Error) { standalone_plan }
      assert_empty @client.writes
    end
    @client.approved_version = nil
    assert_raises(BoardseshStoreReview::Error) { standalone_plan }
  end

  def test_standalone_context_requires_matching_valid_build_and_prerelease
    original = Marshal.load(Marshal.dump(@client.approved_build))
    [nil, original.merge("id" => "wrong-build"), original.merge("type" => "apps"),
      original.merge("attributes" => original.fetch("attributes").merge("expired" => nil)),
      original.merge("attributes" => original.fetch("attributes").merge("expired" => "false")),
      original.merge("attributes" => original.fetch("attributes").merge("processingState" => "PROCESSING")),
      original.merge("attributes" => original.fetch("attributes").merge("version" => ""))].each do |build|
      @client.approved_build = build
      assert_raises(BoardseshStoreReview::Error) { standalone_plan }
      assert_empty @client.writes
    end
    @client.approved_build = original
    prerelease = Marshal.load(Marshal.dump(@client.approved_prerelease))
    [nil, prerelease.merge("id" => nil), prerelease.merge("type" => "builds"),
      prerelease.merge("attributes" => { "version" => "2.6.0", "platform" => "IOS" }),
      prerelease.merge("attributes" => { "version" => "2.5.0", "platform" => "MAC_OS" })].each do |entry|
      @client.approved_prerelease = entry
      assert_raises(BoardseshStoreReview::Error) { standalone_plan }
      assert_empty @client.writes
    end
  end

  def test_stale_context_pin_and_ambiguous_latest_approved_inventory_fail_closed
    original = Marshal.load(Marshal.dump(@client.context_versions))
    newer = Marshal.load(Marshal.dump(original.first))
    newer["id"] = "newer-approved"
    newer["attributes"]["createdDate"] = "2026-10-01T00:00:00Z"
    %w[PENDING_DEVELOPER_RELEASE PENDING_APPLE_RELEASE READY_FOR_DISTRIBUTION].each do |state|
      newer["attributes"]["appVersionState"] = state
      newer["attributes"]["appStoreState"] = state
      @client.context_versions = original + [Marshal.load(Marshal.dump(newer))]
      assert_raises(BoardseshStoreReview::Error) { standalone_plan }
    end
    [original + original, original + [original.first.merge("id" => "tied-approved")], []].each do |versions|
      @client.context_versions = versions
      assert_raises(BoardseshStoreReview::Error) { standalone_plan }
    end
    @client.context_versions = original
    [nil, "invalid"].each do |created|
      @client.context_versions.first["attributes"]["createdDate"] = created
      assert_raises(BoardseshStoreReview::Error) { standalone_plan }
    end
    assert_empty @client.writes
  end

  def test_newer_uncertain_approval_state_never_silently_selects_older_ready_version
    newer = Marshal.load(Marshal.dump(@client.approved_version))
    newer["id"] = "newer-version"
    newer["attributes"]["createdDate"] = "2026-10-01T00:00:00Z"
    %w[ACCEPTED PROCESSING_FOR_DISTRIBUTION WAITING_FOR_EXPORT_COMPLIANCE NEW_APPLE_STATE].each do |state|
      newer["attributes"]["appVersionState"] = state
      newer["attributes"]["appStoreState"] = state
      @client.context_versions = [@client.approved_version, newer]
      error = assert_raises(BoardseshStoreReview::Error) { standalone_plan }
      assert_match(/unresolved approval state/, error.message)
      assert_empty @client.writes
    end
  end

  def test_newer_unapproved_release_does_not_replace_explicit_approved_context
    newer = Marshal.load(Marshal.dump(@client.approved_version))
    newer["id"] = "app-version"
    newer["attributes"].merge!("versionString" => "2.6.0", "createdDate" => "2026-10-01T00:00:00Z", "appStoreState" => "WAITING_FOR_REVIEW", "appVersionState" => "WAITING_FOR_REVIEW")
    @client.context_versions << newer
    assert_equal "approved-version", standalone_plan.dig("snapshot", "cppReviewContext", "version", "id")
    assert_empty @client.writes
  end

  def test_same_release_can_be_explicit_context_once_approved_for_manual_release
    @client.approved_version["attributes"].merge!("versionString" => "2.6.0", "appStoreState" => "PENDING_DEVELOPER_RELEASE", "appVersionState" => "PENDING_DEVELOPER_RELEASE", "releaseType" => "MANUAL")
    @client.context_versions = [Marshal.load(Marshal.dump(@client.approved_version))]
    @client.approved_prerelease["attributes"]["version"] = "2.6.0"
    @report["version"].merge!("id" => "approved-version", "appStoreState" => "PENDING_DEVELOPER_RELEASE")
    @report["build"].merge!("id" => "approved-build", "version" => "12")
    result = standalone_plan
    assert_equal result.dig("snapshot", "version", "id"), result.dig("snapshot", "cppReviewContext", "version", "id")
    assert_equal "MANUAL", result.dig("snapshot", "version", "releaseType")
    assert_empty @client.writes
  end

  def test_context_build_change_after_plan_rejects_stale_snapshot_without_writes
    digest = standalone_plan.fetch("snapshotSha256")
    @client.approved_build["attributes"]["version"] = "13"
    error = assert_raises(BoardseshStoreReview::Error) { standalone_submit(digest) }
    assert_match(/differs from the reviewed snapshot/, error.message)
    assert_empty @client.writes
  end

  def test_final_context_reread_catches_drift_after_last_asset_scan
    @client.context_version = "approved-version"
    @client.submissions["moon-draft"] = { "state" => "READY_FOR_REVIEW", "items" => [@client.item("appCustomProductPageVersion", "version-moonboard")] }
    digest = standalone_plan.fetch("snapshotSha256")
    @client.before_read = ->(path) { @client.approved_build["attributes"]["version"] = "13" if path == "/v1/appCustomProductPages/page-moonboard/appCustomProductPageVersions?limit=200" }
    error = assert_raises(BoardseshStoreReview::Error) { standalone_submit(digest) }
    assert_match(/Current approved CPP review context or build changed/, error.message)
    assert_empty @client.writes
  end

  def test_noop_requires_fresh_context_even_after_matching_asset_snapshot
    @client.context_version = "approved-version"
    digest = standalone_plan.fetch("snapshotSha256")
    standalone_submit(digest)
    writes = @client.writes.length
    @client.before_read = ->(path) { @client.approved_build["attributes"]["version"] = "13" if path == "/v1/appCustomProductPages/page-moonboard/appCustomProductPageVersions?limit=200" }
    assert_raises(BoardseshStoreReview::Error) { standalone_submit(digest) }
    assert_equal writes, @client.writes.length
  end

  def test_context_change_after_submission_is_reported_without_retry
    @client.context_version = "approved-version"
    digest = standalone_plan.fetch("snapshotSha256")
    @client.after_write = ->(method, _path) { @client.context_version = "another-context" if method == "PATCH" }
    error = assert_raises(BoardseshStoreReview::Error) { standalone_submit(digest) }
    assert_match(/different or unknown app version/, error.message)
    assert_equal 1, @client.writes.count { |method, _path, _body| method == "PATCH" }
    assert_equal "WAITING_FOR_REVIEW", @client.submissions.values.first.fetch("state")
  end

  def change_review_context_during_final_context_scan
    reads = 0
    @client.before_read = lambda do |path|
      next unless path == "/v1/apps/app/appStoreVersions?filter[platform]=IOS&limit=200"
      reads += 1
      @client.context_version = "unexpected-context" if reads == 3
    end
  end

  def test_review_context_is_rechecked_after_the_final_context_resource_scan_before_patch
    @client.context_version = "approved-version"
    @client.submissions["moon-draft"] = { "state" => "READY_FOR_REVIEW", "items" => [@client.item("appCustomProductPageVersion", "version-moonboard")] }
    digest = standalone_plan.fetch("snapshotSha256")
    change_review_context_during_final_context_scan
    error = assert_raises(BoardseshStoreReview::Error) { standalone_submit(digest) }
    assert_match(/different or unknown app version/, error.message)
    assert_empty @client.writes
  end

  def test_review_context_is_rechecked_after_the_final_context_resource_scan_before_noop
    @client.context_version = "approved-version"
    digest = standalone_plan.fetch("snapshotSha256")
    standalone_submit(digest)
    writes = @client.writes.length
    change_review_context_during_final_context_scan
    error = assert_raises(BoardseshStoreReview::Error) { standalone_submit(digest) }
    assert_match(/different or unknown app version/, error.message)
    assert_equal writes, @client.writes.length
  end

  def test_context_override_never_bypasses_release_build_or_cpp_current_version_checks
    @client.context_version = "approved-version"
    digest = standalone_plan.fetch("snapshotSha256")
    @client.attached_build_id = "different-release-build"
    assert_raises(BoardseshStoreReview::Error) { standalone_submit(digest) }
    refute @client.writes.any? { |method, _path, _body| method == "PATCH" }
    @client.attached_build_id = nil
    @client.new_cpp_version = true
    assert_raises(BoardseshStoreReview::Error) { standalone_submit(digest) }
    refute @client.writes.any? { |method, _path, _body| method == "PATCH" }
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
