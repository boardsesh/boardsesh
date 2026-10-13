# frozen_string_literal: true

require "minitest/autorun"
require "tmpdir"
require "fileutils"
require_relative "../lib/custom_product_pages"

class CustomProductPagesTest < Minitest::Test
  class FakeTransport
    attr_accessor :use_ssl, :open_timeout, :read_timeout
    attr_reader :requests
    Response = Struct.new(:code, :body)

    def initialize(responses)
      @responses, @requests = responses, []
    end

    def request(request)
      @requests << request
      result = @responses.shift
      raise result if result.is_a?(Exception)
      result
    end
  end

  class FakeApple
    attr_reader :writes, :uploads, :resources

    def initialize
      @writes, @uploads = [], []
      @resources = Hash.new { |hash, key| hash[key] = {} }
      seed("appStoreVersions", "approved", { "platform" => "IOS", "appStoreState" => "READY_FOR_DISTRIBUTION", "createdDate" => "2026-10-01" }, "app" => link("apps", "app"))
      seed("appStoreVersionLocalizations", "approved-en", { "locale" => "en-US", "keywords" => "Kilter,Tension" }, "appStoreVersion" => link("appStoreVersions", "approved"))
      @keyword_ids = ["opaque-kilter", "opaque-tension"]
    end

    def link(type, id)
      { "data" => { "type" => type, "id" => id } }
    end

    def seed(type, id, attributes, relationships = {})
      @resources[type][id] = { "type" => type, "id" => id, "attributes" => attributes, "relationships" => relationships }
    end

    def list(path)
      route = path.split("?").first.split("/").reject(&:empty?)
      _, owner_type, owner_id, related = route
      if related == "searchKeywords"
        ids = owner_type == "appStoreVersionLocalizations" ? @keyword_ids : @resources.fetch(owner_type).fetch(owner_id).fetch("keywords", [])
        return ids.map { |id| { "type" => "appKeywords", "id" => id } }
      end
      if related == "appScreenshots"
        set = @resources.fetch(owner_type).fetch(owner_id)
        return set.fetch("orderedIds", []).map { |id| @resources["appScreenshots"].fetch(id) } if set.key?("orderedIds")
      end
      type = related == "items" ? "reviewSubmissionItems" : related
      relation = { "apps" => "app", "appCustomProductPages" => "appCustomProductPage", "appCustomProductPageVersions" => "appCustomProductPageVersion", "appCustomProductPageLocalizations" => "appCustomProductPageLocalization", "appScreenshotSets" => "appScreenshotSet", "appStoreVersions" => "appStoreVersion", "reviewSubmissions" => "reviewSubmission" }.fetch(owner_type)
      @resources[type].values.select { |resource| resource.dig("relationships", relation, "data", "id") == owner_id }
    end

    def request(method, path, body = nil)
      _, type, id, *tail = path.split("?").first.split("/").reject(&:empty?)
      return { "data" => @resources.fetch(type).fetch(id) } if method == "GET"
      @writes << [method, path, body]
      raise "Deletion is prohibited" if method == "DELETE"
      if tail == ["relationships", "searchKeywords"]
        @resources[type][id]["keywords"] ||= []
        @resources[type][id]["keywords"].concat(body.fetch("data").map { |keyword| keyword.fetch("id") }).uniq!
        return {}
      end
      if tail == ["relationships", "appScreenshots"]
        @resources[type][id]["orderedIds"] = body.fetch("data").map { |image| image.fetch("id") }
        return {}
      end
      payload = body.fetch("data")
      if method == "POST"
        if type == "appCustomProductPages" && body["included"]
          inline = body.fetch("included").first
          inline_id = inline.fetch("id")
          linked_id = payload.dig("relationships", "appCustomProductPageVersions", "data").first.fetch("id")
          unless inline_id.match?(/\A\$\{[^{}]+\}\z/) && linked_id == inline_id
            raise BoardseshCPP::Error, "Apple API POST failed (HTTP 409; ENTITY_ERROR.INCLUDED.INVALID_ID)"
          end
        end
        id = "#{type}-#{@resources[type].length + 1}"
        attributes = payload.fetch("attributes", {}).dup
        attributes.merge!("version" => (@resources[type].length + 1).to_s, "state" => "PREPARE_FOR_SUBMISSION") if type == "appCustomProductPageVersions"
        attributes.merge!("state" => "READY_FOR_REVIEW") if type == "reviewSubmissions"
        attributes.merge!("url" => "https://apps.apple.com/app/id1?ppid=#{id}", "visible" => true) if type == "appCustomProductPages"
        if type == "appScreenshots"
          attributes.merge!("assetDeliveryState" => { "state" => "AWAITING_UPLOAD" }, "uploadOperations" => [{ "url" => "https://upload.apple.com/secret", "offset" => 0, "length" => attributes.fetch("fileSize") }])
        end
        seed(type, id, attributes, payload.fetch("relationships", {}))
        if type == "appCustomProductPages" && body["included"]
          body.fetch("included").each do |inline|
            raise "Only one empty initial version is permitted" unless inline.fetch("type") == "appCustomProductPageVersions" && !inline.key?("attributes") && inline.fetch("relationships") == { "appCustomProductPage" => {} }
            version_id = "appCustomProductPageVersions-#{@resources['appCustomProductPageVersions'].length + 1}"
            seed("appCustomProductPageVersions", version_id, { "version" => "1", "state" => "PREPARE_FOR_SUBMISSION" }, "appCustomProductPage" => link("appCustomProductPages", id))
          end
        end
      else
        resource = @resources.fetch(type).fetch(id)
        resource.fetch("attributes").merge!(payload.fetch("attributes"))
        resource["attributes"]["assetDeliveryState"] = { "state" => "COMPLETE" } if type == "appScreenshots" && payload.dig("attributes", "uploaded")
        if type == "reviewSubmissions" && payload.dig("attributes", "submitted")
          resource["attributes"]["state"] = "WAITING_FOR_REVIEW"
          list("/v1/reviewSubmissions/#{id}/items").each do |item|
            version_id = item.dig("relationships", "appCustomProductPageVersion", "data", "id")
            @resources["appCustomProductPageVersions"][version_id]["attributes"]["state"] = "WAITING_FOR_REVIEW"
          end
        end
      end
      { "data" => @resources[type][id] }
    end

    def upload(_operation, path)
      @uploads << path
    end
  end

  def setup
    @root = Dir.mktmpdir("boardsesh-cpp-test")
    @client = FakeApple.new
    recipes = 9.times.map { |index| { "output" => format("%02d-image.png", index) } }
    @manifest = { "locales" => { "en-US" => ["en-US"] }, "devices" => { "iphone-16-pro-max" => "APP_IPHONE_67" }, "targets" => { "kilter" => { "referenceName" => "Boardsesh Kilter", "screenshotsRoot" => "app-stores/apple/cpp/kilter/screenshots", "recipes" => { "phone" => recipes }, "localizations" => { "en-US" => { "promotionalText" => "Find your next Kilter climb.", "keywords" => ["Kilter"] } } } } }
    folder = File.join(@root, "app-stores/apple/cpp/kilter/screenshots/en-US/iphone-16-pro-max")
    FileUtils.mkdir_p(folder)
    recipes.each do |recipe|
      File.binwrite(File.join(folder, recipe.fetch("output")), "\x89PNG\r\n\x1a\n".b + [13].pack("N") + "IHDR" + [1320, 2868].pack("NN"))
    end
    @keyword_ids = { "en-US" => { "Kilter" => "opaque-kilter" } }
    @manifest.fetch("targets").fetch("kilter")["fixtureReference"] = "fixtures.json"
    File.write(File.join(@root, "fixtures.json"), JSON.generate({ "sha256" => "a" * 64 }))
  end

  def teardown
    FileUtils.remove_entry(@root)
  end

  def runner(keyword_ids: @keyword_ids)
    Dir.glob(File.join(@root, "app-stores/apple/cpp/kilter/screenshots/en-US/*")).each do |folder|
      files = Dir.glob(File.join(folder, "*.png")).to_h do |path|
        [File.basename(path), { "rawBytes" => 100_000, "rawSha256" => "b" * 64, "framedSha256" => Digest::SHA256.file(path).hexdigest }]
      end
      File.write(File.join(folder, "presentation.json"), JSON.generate({ "version" => 1, "locale" => "en-US", "cpp" => { "target" => "kilter", "manifestSha256" => Digest::SHA256.hexdigest(JSON.generate(@manifest)), "fixtureSha256" => "a" * 64 }, "files" => files }))
    end
    BoardseshCPP::Runner.new(client: @client, repo_root: @root, manifest: @manifest, app_id: "app", keyword_ids: keyword_ids, sleeper: ->(_seconds) {})
  end

  def test_plan_is_read_only_and_allows_unmapped_opaque_ids
    result = runner(keyword_ids: {}).run(action: "plan").first
    assert_equal "planned", result.fetch("action")
    assert result.fetch("diagnostics").any? { |diagnostic| diagnostic.include?("ID mappings") }
    assert_empty @client.writes
  end

  def test_plan_queries_real_keyword_catalog_without_fixtures_or_captures
    @manifest.fetch("targets").fetch("kilter").delete("fixtureReference")
    FileUtils.remove_entry(File.join(@root, "app-stores/apple/cpp/kilter/screenshots"))
    instance = BoardseshCPP::Runner.new(client: @client, repo_root: @root, manifest: @manifest, app_id: "app")
    result = instance.run(action: "plan").first
    assert_equal "planned", result.fetch("action")
    assert result.fetch("diagnostics").any? { |diagnostic| diagnostic.include?("fixtureReference") }
    assert result.fetch("diagnostics").any? { |diagnostic| diagnostic.include?("screenshot sets") }
    catalog = result.fetch("keywordCatalog").first
    assert_equal ["Kilter", "Tension"], catalog.fetch("approvedTerms")
    assert_equal ["opaque-kilter", "opaque-tension"], catalog.fetch("eligibleIds")
    assert_equal ["Kilter"], catalog.fetch("requestedTerms")
    assert_empty @client.writes
    assert_empty @client.uploads
  end

  def test_plan_catalog_reports_keyword_owner_without_writing
    @client.seed("appCustomProductPages", "other-page", { "name" => "Other page" }, "app" => @client.link("apps", "app"))
    @client.seed("appCustomProductPageVersions", "other-version", { "version" => "1", "state" => "APPROVED" }, "appCustomProductPage" => @client.link("appCustomProductPages", "other-page"))
    @client.seed("appCustomProductPageLocalizations", "other-en", { "locale" => "en-US" }, "appCustomProductPageVersion" => @client.link("appCustomProductPageVersions", "other-version"))
    @client.resources["appCustomProductPageLocalizations"]["other-en"]["keywords"] = ["opaque-kilter"]
    assignment = runner.run(action: "plan").first.fetch("keywordCatalog").first.fetch("currentAssignments").first
    assert_equal "opaque-kilter", assignment.fetch("keywordId")
    assert_equal "other-page", assignment.fetch("pageId")
    assert_equal "Other page", assignment.fetch("referenceName")
    assert_empty @client.writes
  end

  def test_upload_is_ordered_and_idempotent
    result = runner.run(action: "upload").first
    assert_equal "upload", result.fetch("action")
    assert_equal 9, @client.uploads.length
    count = @client.writes.length
    assert_equal "unchanged", runner.run(action: "upload").first.fetch("action")
    assert_equal count, @client.writes.length
    ordered = @client.resources["appScreenshotSets"].values.first.fetch("orderedIds")
    filenames = ordered.map { |id| @client.resources["appScreenshots"].fetch(id).dig("attributes", "fileName") }
    assert_equal @manifest.dig("targets", "kilter", "recipes", "phone").map { |recipe| recipe.fetch("output") }, filenames
  end

  def test_submit_creates_cpp_only_review_and_repeated_submission_skips
    result = runner.run(action: "submit").first
    assert_equal "WAITING_FOR_REVIEW", result.fetch("state")
    assert result.fetch("reviewSubmissionId")
    items = @client.resources["reviewSubmissionItems"].values
    assert_equal 1, items.length
    assert items.first.dig("relationships", "appCustomProductPageVersion")
    refute items.first.dig("relationships", "appStoreVersion")
    count = @client.writes.length
    assert_equal "unchanged", runner.run(action: "submit").first.fetch("action")
    assert_equal count, @client.writes.length
  end

  def test_missing_keyword_mapping_fails_before_writing
    assert_raises(BoardseshCPP::Error) { runner(keyword_ids: {}).run(action: "upload") }
    assert_empty @client.writes
  end

  def test_unapproved_keyword_fails_before_writing
    @manifest.dig("targets", "kilter", "localizations", "en-US")["keywords"] = ["MoonBoard"]
    assert_raises(BoardseshCPP::Error) { runner.run(action: "upload") }
    assert_empty @client.writes
  end

  def test_under_review_change_fails_before_writing
    runner.run(action: "submit")
    count = @client.writes.length
    @manifest.dig("targets", "kilter", "localizations", "en-US")["promotionalText"] = "Changed text"
    error = assert_raises(BoardseshCPP::Error) { runner.run(action: "upload") }
    assert_includes error.message, "under review"
    assert_equal count, @client.writes.length
  end

  def test_conflicting_draft_screenshot_is_never_deleted
    runner.run(action: "upload")
    count = @client.writes.length
    image = @client.resources["appScreenshots"].values.first
    image["attributes"]["sourceFileChecksum"] = "different"
    error = assert_raises(BoardseshCPP::Error) { runner.run(action: "upload") }
    assert_includes error.message, "no assets were deleted"
    assert_equal count, @client.writes.length
  end

  def test_incomplete_capture_fails_before_remote_writes
    FileUtils.rm(File.join(@root, "app-stores/apple/cpp/kilter/screenshots/en-US/iphone-16-pro-max/00-image.png"))
    assert_raises(BoardseshCPP::Error) { runner.run(action: "upload") }
    assert_empty @client.writes
  end

  def test_default_landscape_ipad_capture_dimensions_are_accepted
    device = "ipad-pro-13-inch-m5"
    @manifest["devices"][device] = "APP_IPAD_PRO_3GEN_129"
    config = @manifest.fetch("targets").fetch("kilter")
    config["recipes"]["ipad"] = config.fetch("recipes").fetch("phone")
    folder = File.join(@root, "app-stores/apple/cpp/kilter/screenshots/en-US", device)
    FileUtils.mkdir_p(folder)
    config.fetch("recipes").fetch("ipad").each do |recipe|
      File.binwrite(File.join(folder, recipe.fetch("output")), "\x89PNG\r\n\x1a\n".b + [13].pack("N") + "IHDR" + [2752, 2064].pack("NN"))
    end
    result = runner.run(action: "plan").first
    assert_equal "planned", result.fetch("action")
    assert_empty result.fetch("diagnostics")
    assert_includes BoardseshCPP::Runner::DISPLAY_DIMENSIONS.fetch("APP_IPAD_PRO_3GEN_11"), [2420, 1668]
  end

  def test_processing_failure_never_submits
    @client.define_singleton_method(:upload) do |_operation, _path|
      raise BoardseshCPP::Error, "Processing failed"
    end
    assert_raises(BoardseshCPP::Error) { runner.run(action: "submit") }
    assert_empty @client.resources["reviewSubmissions"]
  end

  def test_keyword_assignment_to_another_cpp_blocks_all_mutations
    @client.seed("appCustomProductPages", "other-page", { "name" => "Someone else's CPP" }, "app" => @client.link("apps", "app"))
    @client.seed("appCustomProductPageVersions", "other-version", { "version" => "1", "state" => "APPROVED" }, "appCustomProductPage" => @client.link("appCustomProductPages", "other-page"))
    @client.seed("appCustomProductPageLocalizations", "other-en", { "locale" => "en-US" }, "appCustomProductPageVersion" => @client.link("appCustomProductPageVersions", "other-version"))
    @client.resources["appCustomProductPageLocalizations"]["other-en"]["keywords"] = ["opaque-kilter"]
    error = assert_raises(BoardseshCPP::Error) { runner.run(action: "upload") }
    assert_includes error.message, "another CPP"
    assert_empty @client.writes
  end

  def test_approved_changed_content_creates_fresh_version_without_deletion
    runner.run(action: "upload")
    old_version = @client.resources["appCustomProductPageVersions"].values.first
    old_version["attributes"]["state"] = "APPROVED"
    @manifest.dig("targets", "kilter", "localizations", "en-US")["promotionalText"] = "New promotional copy"
    runner.run(action: "upload")
    assert_equal 2, @client.resources["appCustomProductPageVersions"].length
    assert_equal "APPROVED", old_version.dig("attributes", "state")
    assert_equal 18, @client.resources["appScreenshots"].length
  end

  def test_partial_upload_reconciles_existing_reservations
    uploads = 0
    @client.define_singleton_method(:upload) do |_operation, path|
      uploads += 1
      raise BoardseshCPP::Error, "Transient interrupted upload" if uploads == 4
      @uploads << path
    end
    assert_raises(BoardseshCPP::Error) { runner.run(action: "upload") }
    assert_equal 4, @client.resources["appScreenshots"].length
    runner.run(action: "upload")
    assert_equal 9, @client.resources["appScreenshots"].length
    assert_equal 9, @client.uploads.length
  end

  def test_submit_resumes_existing_cpp_only_review_draft
    runner.run(action: "upload")
    version = @client.resources["appCustomProductPageVersions"].values.first
    @client.seed("reviewSubmissions", "draft", { "state" => "READY_FOR_REVIEW", "platform" => "IOS" }, "app" => @client.link("apps", "app"))
    @client.seed("reviewSubmissionItems", "draft-item", {}, "reviewSubmission" => @client.link("reviewSubmissions", "draft"), "appCustomProductPageVersion" => @client.link("appCustomProductPageVersions", version.fetch("id")))
    result = runner.run(action: "submit").first
    assert_equal "draft", result.fetch("reviewSubmissionId")
    assert_equal 1, @client.resources["reviewSubmissions"].length
    assert_equal 1, @client.resources["reviewSubmissionItems"].length
  end

  def test_submit_enables_existing_approved_page_without_new_review
    runner.run(action: "upload")
    @client.resources["appCustomProductPages"].values.first["attributes"]["visible"] = false
    @client.resources["appCustomProductPageVersions"].values.first["attributes"]["state"] = "APPROVED"
    runner.run(action: "submit")
    assert @client.resources["appCustomProductPages"].values.first.dig("attributes", "visible")
    assert_empty @client.resources["reviewSubmissions"]
  end

  def test_stale_target_provenance_fails_before_writes
    instance = runner
    path = File.join(@root, "app-stores/apple/cpp/kilter/screenshots/en-US/iphone-16-pro-max/presentation.json")
    presentation = JSON.parse(File.read(path))
    presentation["cpp"]["target"] = "moonboard"
    File.write(path, JSON.generate(presentation))
    assert_raises(BoardseshCPP::Error) { instance.run(action: "upload") }
    assert_empty @client.writes
  end

  def test_blank_raw_provenance_fails_before_writes
    instance = runner
    path = File.join(@root, "app-stores/apple/cpp/kilter/screenshots/en-US/iphone-16-pro-max/presentation.json")
    presentation = JSON.parse(File.read(path))
    presentation.fetch("files").values.first["rawBytes"] = 24
    File.write(path, JSON.generate(presentation))
    assert_raises(BoardseshCPP::Error) { instance.run(action: "upload") }
    assert_empty @client.writes
  end

  def test_client_retries_transient_reads_with_bounded_delay
    transport = FakeTransport.new([FakeTransport::Response.new("500", ""), FakeTransport::Response.new("429", ""), FakeTransport::Response.new("200", '{"data":[]}')])
    delays = []
    client = BoardseshCPP::Client.new(token: -> { "test" }, transport: ->(_uri) { transport }, sleeper: ->(seconds) { delays << seconds })
    assert_empty client.list("/v1/apps")
    assert_equal [5, 10], delays
    assert_equal 3, transport.requests.length
  end

  def test_client_never_retries_ambiguous_post_creation
    transport = FakeTransport.new([Net::ReadTimeout.new("secret signed URL")])
    client = BoardseshCPP::Client.new(token: -> { "test" }, transport: ->(_uri) { transport }, sleeper: ->(_seconds) { flunk "POST retried" })
    error = assert_raises(BoardseshCPP::Error) { client.request("POST", "/v1/appCustomProductPages", {}) }
    refute_includes error.message, "secret"
    assert_equal 1, transport.requests.length
  end

  def test_client_rejects_external_pagination_url_before_credentials_sent
    client = BoardseshCPP::Client.new(token: -> { flunk "token accessed" })
    assert_raises(BoardseshCPP::Error) { client.request("GET", "https://example.com/v1/apps") }
  end

  def create_runner
    BoardseshCPP::Runner.new(client: @client, repo_root: @root, manifest: @manifest, app_id: "app")
  end

  def set_four_create_targets
    @manifest["targets"] = %w[kilter tension moonboard spray].to_h do |target|
      [target, { "referenceName" => "Boardsesh #{target}" }]
    end
  end

  def test_create_four_empty_drafts_without_captures_keywords_or_approved_version
    set_four_create_targets
    FileUtils.remove_entry(File.join(@root, "app-stores"))
    @client.resources["appStoreVersions"].clear
    results = create_runner.run(action: "create")
    assert_equal %w[kilter tension moonboard spray], results.map { |result| result.fetch("target") }
    assert results.all? { |result| result.fetch("action") == "created" && result.fetch("state") == "PREPARE_FOR_SUBMISSION" && result.fetch("appId") == "app" }
    assert results.all? { |result| result.fetch("url").include?("ppid=#{result.fetch('pageId')}") && result.fetch("versions").length == 1 }
    assert_equal 4, @client.writes.length
    assert @client.writes.all? { |method, path, _body| method == "POST" && path == "/v1/appCustomProductPages" }
    @client.writes.each do |_method, _path, body|
      assert_equal ["name"], body.fetch("data").fetch("attributes").keys
      assert_equal "app", body.dig("data", "relationships", "app", "data", "id")
      assert_equal ["app", "appCustomProductPageVersions"], body.fetch("data").fetch("relationships").keys
      assert_equal 1, body.fetch("included").length
      assert_equal body.dig("data", "relationships", "appCustomProductPageVersions", "data").first.fetch("id"), body.fetch("included").first.fetch("id")
    end
    assert_empty @client.resources["appCustomProductPageLocalizations"]
    assert_empty @client.resources["appScreenshots"]
    assert_empty @client.resources["reviewSubmissions"]
    assert_empty @client.uploads
  end

  def test_create_reuses_all_four_page_names_without_writes
    set_four_create_targets
    create_runner.run(action: "create")
    before = JSON.generate(@client.resources)
    count = @client.writes.length
    results = create_runner.run(action: "create")
    assert results.all? { |result| result.fetch("action") == "reused" }
    assert_equal count, @client.writes.length
    assert_equal before, JSON.generate(@client.resources)
  end

  def test_create_reuses_live_invisible_page_without_changing_it
    create_runner.run(action: "create")
    page = @client.resources["appCustomProductPages"].values.first
    page["attributes"]["visible"] = false
    approved_version = @client.resources["appCustomProductPageVersions"].values.first
    approved_version["attributes"]["state"] = "APPROVED"
    @client.seed("appCustomProductPageVersions", "replaced-version", { "version" => "99", "state" => "REPLACED_WITH_NEW_VERSION" }, "appCustomProductPage" => @client.link("appCustomProductPages", page.fetch("id")))
    before = JSON.generate(@client.resources)
    count = @client.writes.length
    result = create_runner.run(action: "create").first
    assert_equal "reused", result.fetch("action")
    assert_equal "APPROVED", result.fetch("state")
    assert_equal approved_version.fetch("id"), result.fetch("versionId")
    assert_equal false, result.fetch("visible")
    assert_equal before, JSON.generate(@client.resources)
    assert_equal count, @client.writes.length
  end

  def test_create_rejects_existing_page_without_versions_before_creating_other_targets
    set_four_create_targets
    @client.seed("appCustomProductPages", "existing-tension", { "name" => "Boardsesh tension", "url" => "https://apps.apple.com/app/id1?ppid=existing-tension" }, "app" => @client.link("apps", "app"))
    # Materialize the empty collection before comparing resources so a read
    # through the mock's default hash cannot look like a store mutation.
    @client.resources["appCustomProductPageVersions"]
    before = JSON.generate(@client.resources)

    error = assert_raises(BoardseshCPP::Error) { create_runner.run(action: "create") }

    assert_includes error.message, "Boardsesh tension has no current version"
    assert_empty @client.writes
    assert_empty @client.uploads
    assert_equal before, JSON.generate(@client.resources)
  end

  def test_create_rejects_replaced_only_existing_page_before_creating_other_targets
    set_four_create_targets
    @client.seed("appCustomProductPages", "existing-tension", { "name" => "Boardsesh tension", "url" => "https://apps.apple.com/app/id1?ppid=existing-tension" }, "app" => @client.link("apps", "app"))
    @client.seed("appCustomProductPageVersions", "replaced-version", { "version" => "1", "state" => "REPLACED_WITH_NEW_VERSION" }, "appCustomProductPage" => @client.link("appCustomProductPages", "existing-tension"))
    before = JSON.generate(@client.resources)

    error = assert_raises(BoardseshCPP::Error) { create_runner.run(action: "create") }

    assert_includes error.message, "Boardsesh tension has no current version"
    assert_empty @client.writes
    assert_empty @client.uploads
    assert_equal before, JSON.generate(@client.resources)
  end

  def test_create_rejects_ambiguous_existing_name_before_creating_any_pages
    set_four_create_targets
    2.times { |index| @client.seed("appCustomProductPages", "duplicate-#{index}", { "name" => "Boardsesh tension" }, "app" => @client.link("apps", "app")) }
    assert_raises(BoardseshCPP::Error) { create_runner.run(action: "create") }
    assert_empty @client.writes
  end

  def test_create_rejects_duplicate_manifest_reference_names_before_writing
    set_four_create_targets
    @manifest.fetch("targets").fetch("spray")["referenceName"] = "Boardsesh kilter"
    assert_raises(BoardseshCPP::Error) { create_runner.run(action: "create") }
    assert_empty @client.writes
  end

  def test_create_rejects_wrong_app_identity_without_store_changes
    @client.seed("appCustomProductPages", "existing", { "name" => "Boardsesh Kilter", "url" => "https://apps.apple.com/app/id1?ppid=existing" }, "app" => @client.link("apps", "app"))
    original_request = @client.method(:request)
    @client.define_singleton_method(:request) do |method, path, body = nil|
      response = original_request.call(method, path, body)
      if method == "GET" && path.start_with?("/v1/appCustomProductPages/")
        response = Marshal.load(Marshal.dump(response))
        response.fetch("data").fetch("relationships").fetch("app").fetch("data")["id"] = "different-app"
      end
      response
    end
    assert_raises(BoardseshCPP::Error) { create_runner.run(action: "create") }
    assert_empty @client.writes
  end

  def test_create_does_not_retry_ambiguous_creation_and_rerun_reuses_created_page
    original_request = @client.method(:request)
    fail_once = true
    @client.define_singleton_method(:request) do |method, path, body = nil|
      response = original_request.call(method, path, body)
      if fail_once && method == "POST" && path == "/v1/appCustomProductPages"
        fail_once = false
        raise BoardseshCPP::Error, "Creation response interrupted"
      end
      response
    end
    assert_raises(BoardseshCPP::Error) { create_runner.run(action: "create") }
    assert_equal 1, @client.writes.length
    assert_equal "reused", create_runner.run(action: "create").first.fetch("action")
    assert_equal 1, @client.resources["appCustomProductPages"].length
    assert_equal 1, @client.writes.length
  end

  def test_create_rejects_wrong_page_url_before_any_store_write
    @client.seed("appCustomProductPages", "existing", { "name" => "Boardsesh Kilter", "url" => "https://apps.apple.com/app/id1?ppid=another-page" }, "app" => @client.link("apps", "app"))
    assert_raises(BoardseshCPP::Error) { create_runner.run(action: "create") }
    assert_empty @client.writes
  end

  def test_create_stops_after_unexpected_new_version_state_without_further_pages
    set_four_create_targets
    original_request = @client.method(:request)
    @client.define_singleton_method(:request) do |method, path, body = nil|
      response = original_request.call(method, path, body)
      if method == "POST" && path == "/v1/appCustomProductPages"
        @resources["appCustomProductPageVersions"].values.last["attributes"]["state"] = "APPROVED"
      end
      response
    end
    assert_raises(BoardseshCPP::Error) { create_runner.run(action: "create") }
    assert_equal 1, @client.writes.length
    assert_equal 1, @client.resources["appCustomProductPages"].length
    assert_empty @client.resources["reviewSubmissions"]
  end
end
