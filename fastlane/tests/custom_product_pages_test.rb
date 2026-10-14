# frozen_string_literal: true

require "minitest/autorun"
require "tmpdir"
require "fileutils"
require_relative "../lib/custom_product_pages"

class RetainedCppSourceTest < Minitest::Test
  MANIFEST_PATH = "app-stores/apple/custom-product-pages.json"

  def git(*args)
    output, status = Open3.capture2e("git", "-C", @root, *args)
    raise output unless status.success?
    output.strip
  end

  def put(path, bytes)
    full = File.join(@root, path)
    FileUtils.mkdir_p(File.dirname(full))
    File.binwrite(full, bytes)
  end

  def canonical(value)
    case value
    when Hash then value.keys.sort.to_h { |key| [key, canonical(value.fetch(key))] }
    when Array then value.map { |entry| canonical(entry) }
    else value
    end
  end

  def semantic_hash(value)
    Digest::SHA256.hexdigest(JSON.generate(canonical(value)))
  end

  def commit
    git("add", ".")
    git("-c", "user.name=CPP Test", "-c", "user.email=cpp@example.test", "commit", "-qm", "Test source")
    git("rev-parse", "HEAD")
  end

  def setup
    @root = Dir.mktmpdir("cpp-retained-source-")
    repository = File.expand_path("../..", __dir__)
    @manifest_bytes = File.read(File.join(repository, MANIFEST_PATH))
    @manifest = JSON.parse(@manifest_bytes)
    original = JSON.parse(@manifest_bytes)
    original.fetch("targets").fetch("kilter")["referenceName"] = "Earlier unrelated Kilter page"
    @original_bytes = JSON.generate(original)
    put(MANIFEST_PATH, @original_bytes)
    @captions = %w[en-US es fr de].to_h do |locale|
      path = "app-stores/presentation/#{locale}.json"
      bytes = File.read(File.join(repository, path))
      put(path, bytes)
      [locale, bytes]
    end
    git("init", "-q")
    @pin = commit
    put(MANIFEST_PATH, @manifest_bytes)
    @head = commit
    @environment = %w[GITHUB_EVENT_NAME GITHUB_REF GITHUB_SHA].to_h { |key| [key, ENV[key]] }
    ENV.update("GITHUB_EVENT_NAME" => "workflow_dispatch", "GITHUB_REF" => "refs/heads/main", "GITHUB_SHA" => @head)
    page = @manifest.fetch("targets").fetch("tension")
    fixture = { "version" => 1, "url" => "https://example.test/fixture.json.gz", "sha256" => "a" * 64, "bytes" => 1, "files" => 1 }
    put(page.fetch("fixtureReference"), JSON.generate(fixture))
    @manifest.fetch("locales").each do |locale, store_locales|
      store_locales.each do |store_locale|
        @manifest.fetch("devices").each do |device, display|
          recipes = page.fetch("recipes").fetch(device.start_with?("ipad") ? "ipad" : "phone")
          folder = "app-stores/apple/cpp/tension/screenshots/#{store_locale}/#{device}"
          width, height = BoardseshCPP::Runner::DISPLAY_DIMENSIONS.fetch(display).first
          png = "\x89PNG\r\n\x1a\n".b + [13].pack("N") + "IHDR" + [width, height].pack("NN")
          files = recipes.to_h do |recipe|
            put("#{folder}/#{recipe.fetch('output')}", png)
            metadata = { "rawBytes" => 100_000, "rawSha256" => "b" * 64, "framedSha256" => Digest::SHA256.hexdigest(png) }
            if recipe.fetch("sources").length > 1
              metadata["sources"] = recipe.fetch("sources").to_h { |source| [source, { "rawBytes" => 100_000, "rawSha256" => "b" * 64 }] }
            end
            [recipe.fetch("output"), metadata]
          end
          put("#{folder}/presentation.json", JSON.generate({ "version" => 1, "locale" => locale, "cpp" => { "target" => "tension", "fixtureSha256" => fixture.fetch("sha256"), "manifestSha256" => Digest::SHA256.hexdigest(@original_bytes) }, "files" => files }))
        end
      end
    end
    base = File.join(@root, "app-stores/apple/cpp/tension")
    inventory = Dir.glob(File.join(base, "**", "*")).select { |path| File.file?(path) }.to_h do |path|
      metadata = { "sha256" => Digest::SHA256.file(path).hexdigest, "bytes" => File.size(path) }
      metadata["md5"] = Digest::MD5.file(path).hexdigest if path.end_with?(".png")
      [path.delete_prefix("#{base}/"), metadata]
    end
    caption_ids = page.fetch("recipes").values.flatten.map { |recipe| recipe.fetch("caption") }.uniq
    used_captions = @captions.to_h { |locale, bytes| [locale, JSON.parse(bytes).select { |caption, _copy| caption_ids.include?(caption) }] }
    @receipt = {
      "version" => 2, "repository" => "boardsesh/boardsesh", "target" => "tension", "runId" => 1234, "producerSha" => @pin, "verifierSha" => @head, "screenshots" => 180,
      "manifestSha256" => Digest::SHA256.hexdigest(@original_bytes), "fixture" => fixture, "inventory" => inventory,
      "captureSource" => { "version" => 1, "target" => "tension", "sourceSha" => @pin, "manifest" => @original_bytes, "captions" => @captions },
      "compatibility" => { "version" => 1, "target" => "tension", "sourceSha" => @pin, "sourceManifestSha256" => Digest::SHA256.hexdigest(@original_bytes), "currentManifestSha256" => Digest::SHA256.hexdigest(@manifest_bytes), "targetSha256" => semantic_hash(page), "globalsSha256" => semantic_hash(@manifest.reject { |key, _value| key == "targets" }), "captionsSha256" => semantic_hash(used_captions) }
    }
  end

  def teardown
    @environment.each { |key, value| value.nil? ? ENV.delete(key) : ENV[key] = value }
    FileUtils.remove_entry(@root)
  end

  def source_options
    bytes = JSON.generate(@receipt) + "\n"
    path = File.join(@root, "receipt.json")
    File.write(path, bytes)
    { receipt_path: path, expected_sha256: Digest::SHA256.hexdigest(bytes), capture_contract_ref: @pin, replay_run_id: "1234" }
  end

  def verify(**options)
    BoardseshCPP.verify_retained_source(repo_root: @root, manifest: @manifest, target: "tension", **source_options.merge(options))
  end

  def test_accepts_exact_git_context_and_all_180_original_images_without_rewriting_sidecars
    before = Dir.glob(File.join(@root, "app-stores/apple/cpp/tension/**/presentation.json")).to_h { |path| [path, File.binread(path)] }
    assert_equal Digest::SHA256.hexdigest(@original_bytes), verify
    before.each { |path, bytes| assert_equal bytes, File.binread(path) }
    instance = BoardseshCPP::Runner.new(client: CustomProductPagesTest::FakeApple.new, repo_root: @root, manifest: @manifest, app_id: "app", retained_source: source_options)
    # All local inputs pass; the absent draft stops before any write.
    error = assert_raises(BoardseshCPP::Error) { instance.run(target: "tension", action: "stage-assets") }
    assert_match(/exactly one existing page/, error.message)
  end

  def test_rejects_changed_review_digest_run_target_and_main_context
    assert_raises(BoardseshCPP::Error) { verify(expected_sha256: "e" * 64) }
    assert_raises(BoardseshCPP::Error) { verify(replay_run_id: "999") }
    @receipt["target"] = "kilter"
    assert_raises(BoardseshCPP::Error) { verify }
    @receipt["target"] = "tension"
    ENV["GITHUB_REF"] = "refs/heads/other"
    assert_raises(BoardseshCPP::Error) { verify }
    ENV["GITHUB_REF"] = "refs/heads/main"
    ENV["GITHUB_SHA"] = @pin
    assert_raises(BoardseshCPP::Error) { verify }
  end

  def test_rejects_fabricated_original_bytes_unknown_context_and_missing_caption
    @receipt["captureSource"]["manifest"] += "\n"
    assert_raises(BoardseshCPP::Error) { verify }
    @receipt["captureSource"]["manifest"] = @original_bytes
    @receipt["captureSource"]["unverifiedHash"] = "a" * 64
    assert_raises(BoardseshCPP::Error) { verify }
    @receipt["captureSource"].delete("unverifiedHash")
    @receipt["captureSource"]["version"] = 2
    assert_raises(BoardseshCPP::Error) { verify }
    @receipt["captureSource"]["version"] = 1
    @receipt["captureSource"]["captions"].delete("de")
    assert_raises(BoardseshCPP::Error) { verify }
  end

  def test_rejects_annotated_tag_objects_and_newer_pin
    git("-c", "user.name=CPP Test", "-c", "user.email=cpp@example.test", "tag", "-a", "accepted", @pin, "-m", "Tag is not a commit")
    tag = git("rev-parse", "accepted")
    @receipt["captureSource"]["sourceSha"] = tag
    assert_raises(BoardseshCPP::Error) { verify(capture_contract_ref: tag) }
    @receipt["captureSource"]["sourceSha"] = @head
    @receipt["verifierSha"] = @pin
    ENV["GITHUB_SHA"] = @pin
    assert_raises(BoardseshCPP::Error) { verify(capture_contract_ref: @head) }
  end

  def test_rejects_producer_newer_than_the_accepted_pin
    @receipt["producerSha"] = @head
    assert_raises(BoardseshCPP::Error) { verify }
  end

  def test_rejects_partial_handoff_and_nonstaging_actions_before_remote_reads
    assert_raises(BoardseshCPP::Error) { verify(capture_contract_ref: "") }
    assert_raises(BoardseshCPP::Error) { verify(expected_sha256: "") }
    assert_raises(BoardseshCPP::Error) { verify(replay_run_id: "") }
    client = CustomProductPagesTest::FakeApple.new
    instance = BoardseshCPP::Runner.new(client: client, repo_root: @root, manifest: @manifest, app_id: "app", retained_source: source_options)
    %w[plan create upload submit].each do |action|
      assert_raises(BoardseshCPP::Error) { instance.run(target: "tension", action: action) }
    end
    assert_raises(BoardseshCPP::Error) { instance.run(target: "all", action: "stage-assets") }
    assert_empty client.reads
    assert_empty client.writes
  end

  def test_rejects_current_semantic_drift_even_when_committed_and_receipt_head_refreshed
    @manifest.fetch("targets").fetch("tension").fetch("recipes").fetch("phone").reverse!
    put(MANIFEST_PATH, JSON.generate(@manifest))
    @receipt["verifierSha"] = commit
    ENV["GITHUB_SHA"] = @receipt["verifierSha"]
    assert_raises(BoardseshCPP::Error) { verify }
  end

  def test_rejects_current_caption_drift_after_genuine_commit
    path = "app-stores/presentation/fr.json"
    captions = JSON.parse(File.read(File.join(@root, path)))
    captions.fetch("cppTensionLayouts")["headline"] = "Different promise"
    put(path, JSON.generate(captions))
    @receipt["verifierSha"] = commit
    ENV["GITHUB_SHA"] = @receipt["verifierSha"]
    assert_raises(BoardseshCPP::Error) { verify }
  end

  def test_rejects_current_global_drift_after_genuine_commit
    @manifest.fetch("locales")["es"].reverse!
    put(MANIFEST_PATH, JSON.generate(@manifest))
    @receipt["verifierSha"] = commit
    ENV["GITHUB_SHA"] = @receipt["verifierSha"]
    assert_raises(BoardseshCPP::Error) { verify }
  end

  def test_rejects_altered_image_inventory_fixture_or_compatibility
    fixture_path = @manifest.fetch("targets").fetch("tension").fetch("fixtureReference")
    put(fixture_path, JSON.generate(@receipt.fetch("fixture").merge("sha256" => "e" * 64)))
    assert_raises(BoardseshCPP::Error) { verify }
    put(fixture_path, JSON.generate(@receipt.fetch("fixture")))
    @receipt["inventory"]["extra.png"] = { "bytes" => 1 }
    assert_raises(BoardseshCPP::Error) { verify }
    @receipt["inventory"].delete("extra.png")
    @receipt["compatibility"]["captionsSha256"] = "e" * 64
    assert_raises(BoardseshCPP::Error) { verify }
    @receipt["compatibility"]["captionsSha256"] = semantic_hash(@captions.to_h do |locale, bytes|
      ids = @manifest.fetch("targets").fetch("tension").fetch("recipes").values.flatten.map { |recipe| recipe.fetch("caption") }
      [locale, JSON.parse(bytes).select { |key, _value| ids.include?(key) }]
    end)
    path = @receipt.fetch("inventory").keys.find { |entry| entry.end_with?(".png") }
    put("app-stores/apple/cpp/tension/#{path}", "changed")
    assert_raises(BoardseshCPP::Error) { verify }
  end
end

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
    attr_reader :writes, :uploads, :resources, :reads

    def initialize
      @writes, @uploads, @reads = [], [], []
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
      @reads << path
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
      @reads << path if method == "GET"
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
          localization_links = inline.dig("relationships", "appCustomProductPageLocalizations", "data")
          localization = body.fetch("included").find { |resource| resource["type"] == "appCustomProductPageLocalizations" }
          unless localization_links.is_a?(Array) && localization_links.length == 1 && localization && localization_links.first["type"] == "appCustomProductPageLocalizations" && localization_links.first["id"] == localization["id"]
            raise BoardseshCPP::Error, "Apple API POST failed (HTTP 409; ENTITY_ERROR.RELATIONSHIP.REQUIRED at /data/relationships/appCustomProductPageLocalizations)"
          end
          unless localization.fetch("id").match?(/\A\$\{[^{}]+\}\z/) && localization.fetch("attributes").keys == ["locale"] && localization.fetch("relationships") == { "appCustomProductPageVersion" => {} }
            raise "Initial localization must be an inline locale-only resource"
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
          version = body.fetch("included").find { |resource| resource["type"] == "appCustomProductPageVersions" }
          raise "Only one blank initial version is permitted" unless body.fetch("included").length == 2 && !version.key?("attributes") && version.fetch("relationships").fetch("appCustomProductPage") == {}
          version_id = "appCustomProductPageVersions-#{@resources['appCustomProductPageVersions'].length + 1}"
          seed("appCustomProductPageVersions", version_id, { "version" => "1", "state" => "PREPARE_FOR_SUBMISSION" }, "appCustomProductPage" => link("appCustomProductPages", id))
          localization = body.fetch("included").find { |resource| resource["type"] == "appCustomProductPageLocalizations" }
          localization_id = "appCustomProductPageLocalizations-#{@resources['appCustomProductPageLocalizations'].length + 1}"
          seed("appCustomProductPageLocalizations", localization_id, localization.fetch("attributes").dup, "appCustomProductPageVersion" => link("appCustomProductPageVersions", version_id))
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

  def seed_staging_draft(target = "kilter", state: "PREPARE_FOR_SUBMISSION", page_id: "#{target}-page", version_id: "#{target}-version")
    @client.seed("appCustomProductPages", page_id, { "name" => @manifest.fetch("targets").fetch(target).fetch("referenceName"), "url" => "https://apps.apple.com/app/id1?ppid=#{page_id}", "visible" => false }, "app" => @client.link("apps", "app"))
    @client.seed("appCustomProductPageVersions", version_id, { "version" => "1", "state" => state }, "appCustomProductPage" => @client.link("appCustomProductPages", page_id)) if state
    { "page" => @client.resources["appCustomProductPages"][page_id], "version" => @client.resources["appCustomProductPageVersions"][version_id] }
  end

  def test_stage_assets_does_not_require_approved_keywords_or_write_listing_review_visibility_or_keywords
    seed_staging_draft
    @client.resources["appStoreVersions"].clear
    @manifest.dig("targets", "kilter", "localizations", "en-US")["keywords"] = ["Not approved"]
    result = runner(keyword_ids: {}).run(action: "stage-assets").first
    assert_equal "stage-assets", result.fetch("action")
    assert_includes result.fetch("publication"), "keyword assignments unchanged"
    assert_equal 9, @client.uploads.length
    assert_equal 1, @client.resources["appCustomProductPages"].length
    assert_equal 1, @client.resources["appCustomProductPageVersions"].length
    assert_equal false, @client.resources["appCustomProductPages"].values.first.dig("attributes", "visible")
    assert_empty @client.resources["reviewSubmissions"]
    assert @client.resources["appCustomProductPageLocalizations"].values.all? { |localization| localization.fetch("keywords", []).empty? }
    assert @client.writes.all? { |method, path, _body| %w[POST PATCH].include?(method) && path.match?(%r{\A/v1/(?:appCustomProductPageLocalizations|appScreenshotSets|appScreenshots)(?:/|\z)}) && !path.include?("searchKeywords") }
    refute @client.reads.any? { |path| path.include?("appStoreVersions") || path.include?("reviewSubmissions") }
  end

  def test_stage_assets_preserves_existing_keyword_membership_and_is_idempotent
    seed_staging_draft
    @client.seed("appCustomProductPageLocalizations", "existing-en", { "locale" => "en-US", "promotionalText" => "Old copy" }, "appCustomProductPageVersion" => @client.link("appCustomProductPageVersions", "kilter-version"))
    @client.resources["appCustomProductPageLocalizations"]["existing-en"]["keywords"] = ["keep-this-opaque-keyword"]
    instance = runner(keyword_ids: {})
    instance.run(action: "stage-assets")
    assert_equal ["keep-this-opaque-keyword"], @client.resources["appCustomProductPageLocalizations"]["existing-en"].fetch("keywords")
    write_count = @client.writes.length
    assert_equal "unchanged", instance.run(action: "stage-assets").first.fetch("action")
    assert_equal write_count, @client.writes.length
    filenames = @client.resources["appScreenshotSets"].values.first.fetch("orderedIds").map { |id| @client.resources["appScreenshots"].fetch(id).dig("attributes", "fileName") }
    assert_equal @manifest.dig("targets", "kilter", "recipes", "phone").map { |recipe| recipe.fetch("output") }, filenames
  end

  def test_stage_assets_requires_one_verified_existing_page_and_current_editable_draft
    error = assert_raises(BoardseshCPP::Error) { runner.run(action: "stage-assets") }
    assert_includes error.message, "exactly one existing page"
    [nil, "APPROVED", "WAITING_FOR_REVIEW", "IN_REVIEW", "ACCEPTED", "REPLACED_WITH_NEW_VERSION", "UNKNOWN"].each do |state|
      @client = FakeApple.new
      seed_staging_draft(state: state)
      error = assert_raises(BoardseshCPP::Error) { runner.run(action: "stage-assets") }
      assert_includes error.message, "existing current editable draft"
      assert_empty @client.writes
      assert_empty @client.uploads
    end
  end

  def test_stage_assets_does_not_select_an_older_editable_version
    seed_staging_draft
    @client.seed("appCustomProductPageVersions", "newest", { "version" => "2", "state" => "APPROVED" }, "appCustomProductPage" => @client.link("appCustomProductPages", "kilter-page"))
    assert_raises(BoardseshCPP::Error) { runner.run(action: "stage-assets") }
    assert_empty @client.writes
  end

  def test_stage_assets_rejects_ambiguous_names_and_wrong_page_ownership_before_writes
    seed_staging_draft
    seed_staging_draft(page_id: "duplicate", version_id: "duplicate-version")
    assert_raises(BoardseshCPP::Error) { runner.run(action: "stage-assets") }
    assert_empty @client.writes
    @client.resources["appCustomProductPages"].delete("duplicate")
    original_request = @client.method(:request)
    @client.define_singleton_method(:request) do |method, path, body = nil|
      response = original_request.call(method, path, body)
      response.fetch("data").fetch("relationships").fetch("app").fetch("data")["id"] = "another-app" if method == "GET" && path.start_with?("/v1/appCustomProductPages/")
      response
    end
    error = assert_raises(BoardseshCPP::Error) { runner.run(action: "stage-assets") }
    assert_includes error.message, "unexpected identity or app ownership"
    assert_empty @client.writes
  end

  def test_stage_assets_preflights_every_selected_target_before_any_write
    config = JSON.parse(JSON.generate(@manifest.fetch("targets").fetch("kilter")))
    config["referenceName"] = "Boardsesh Tension"
    config["screenshotsRoot"] = "app-stores/apple/cpp/tension/screenshots"
    @manifest.fetch("targets")["tension"] = config
    FileUtils.mkdir_p(File.join(@root, "app-stores/apple/cpp/tension"))
    FileUtils.cp_r(File.join(@root, "app-stores/apple/cpp/kilter/screenshots"), File.join(@root, config.fetch("screenshotsRoot")))
    instance = runner
    source_presentation = JSON.parse(File.read(File.join(@root, "app-stores/apple/cpp/kilter/screenshots/en-US/iphone-16-pro-max/presentation.json")))
    source_presentation.fetch("cpp")["target"] = "tension"
    File.write(File.join(@root, config.fetch("screenshotsRoot"), "en-US/iphone-16-pro-max/presentation.json"), JSON.generate(source_presentation))
    seed_staging_draft
    seed_staging_draft("tension", state: "IN_REVIEW")
    assert_raises(BoardseshCPP::Error) { instance.run(target: "all", action: "stage-assets") }
    assert_empty @client.writes
    assert_empty @client.uploads
  end

  def test_stage_assets_preserves_conflicting_existing_screenshots_without_deletion
    seed_staging_draft
    instance = runner(keyword_ids: {})
    instance.run(action: "stage-assets")
    @client.resources["appScreenshots"].values.first.fetch("attributes")["sourceFileChecksum"] = "conflicting"
    write_count = @client.writes.length
    error = assert_raises(BoardseshCPP::Error) { instance.run(action: "stage-assets") }
    assert_includes error.message, "no assets were deleted"
    assert_equal write_count, @client.writes.length
    assert_equal 9, @client.resources["appScreenshots"].length
  end

  def test_stage_assets_rejects_stale_fixture_provenance_and_bad_dimensions_before_writes
    seed_staging_draft
    File.write(File.join(@root, "fixtures.json"), JSON.generate("sha256" => "f" * 64))
    error = assert_raises(BoardseshCPP::Error) { runner.run(action: "stage-assets") }
    assert_includes error.message, "stale target, manifest, or fixture provenance"
    assert_empty @client.writes
    File.write(File.join(@root, "fixtures.json"), JSON.generate("sha256" => "a" * 64))
    screenshot = File.join(@root, "app-stores/apple/cpp/kilter/screenshots/en-US/iphone-16-pro-max/00-image.png")
    File.binwrite(screenshot, "\x89PNG\r\n\x1a\n".b + [13].pack("N") + "IHDR" + [1, 1].pack("NN"))
    error = assert_raises(BoardseshCPP::Error) { runner.run(action: "stage-assets") }
    assert_includes error.message, "invalid PNG dimensions"
    assert_empty @client.writes
  end

  def test_stage_assets_rejects_keyword_membership_changes_before_its_first_write
    seed_staging_draft
    @client.seed("appCustomProductPageLocalizations", "existing-en", { "locale" => "en-US" }, "appCustomProductPageVersion" => @client.link("appCustomProductPageVersions", "kilter-version"))
    @client.resources["appCustomProductPageLocalizations"]["existing-en"]["keywords"] = ["original-keyword"]
    original_list = @client.method(:list)
    keyword_reads = 0
    @client.define_singleton_method(:list) do |path|
      if path.include?("/searchKeywords?")
        keyword_reads += 1
        @resources["appCustomProductPageLocalizations"]["existing-en"]["keywords"] = ["changed-elsewhere"] if keyword_reads == 2
      end
      original_list.call(path)
    end
    error = assert_raises(BoardseshCPP::Error) { runner.run(action: "stage-assets") }
    assert_includes error.message, "keyword memberships changed before"
    assert_empty @client.writes
  end

  def test_stage_assets_detects_keyword_membership_changes_during_upload_without_reverting_them
    seed_staging_draft
    @client.seed("appCustomProductPageLocalizations", "existing-en", { "locale" => "en-US" }, "appCustomProductPageVersion" => @client.link("appCustomProductPageVersions", "kilter-version"))
    @client.resources["appCustomProductPageLocalizations"]["existing-en"]["keywords"] = ["original-keyword"]
    @client.define_singleton_method(:upload) do |_operation, path|
      @uploads << path
      @resources["appCustomProductPageLocalizations"]["existing-en"]["keywords"] = ["changed-elsewhere"]
    end
    error = assert_raises(BoardseshCPP::Error) { runner.run(action: "stage-assets") }
    assert_includes error.message, "keyword memberships changed during"
    assert_equal ["changed-elsewhere"], @client.resources["appCustomProductPageLocalizations"]["existing-en"].fetch("keywords")
    refute @client.writes.any? { |_method, path, _body| path.include?("searchKeywords") }
  end

  def test_stage_assets_rejects_automatic_keyword_assignment_to_new_localizations
    seed_staging_draft
    original_request = @client.method(:request)
    @client.define_singleton_method(:request) do |method, path, body = nil|
      response = original_request.call(method, path, body)
      response.fetch("data")["keywords"] = ["automatically-assigned"] if method == "POST" && path == "/v1/appCustomProductPageLocalizations"
      response
    end
    error = assert_raises(BoardseshCPP::Error) { runner.run(action: "stage-assets") }
    assert_includes error.message, "keyword memberships changed during"
    refute @client.writes.any? { |_method, path, _body| path.include?("searchKeywords") }
    assert_equal ["automatically-assigned"], @client.resources["appCustomProductPageLocalizations"].values.first.fetch("keywords")
  end

  def test_stage_assets_rechecks_editability_and_preserves_visibility
    seed_staging_draft
    original_list = @client.method(:list)
    version_reads = 0
    @client.define_singleton_method(:list) do |path|
      if path.include?("/appCustomProductPageVersions?")
        version_reads += 1
        @resources["appCustomProductPageVersions"]["kilter-version"].fetch("attributes")["state"] = "IN_REVIEW" if version_reads == 2
      end
      original_list.call(path)
    end
    assert_raises(BoardseshCPP::Error) { runner.run(action: "stage-assets") }
    assert_empty @client.writes
    @client.define_singleton_method(:list) { |path| original_list.call(path) }
    @client.resources["appCustomProductPageVersions"]["kilter-version"].fetch("attributes")["state"] = "PREPARE_FOR_SUBMISSION"
    @client.define_singleton_method(:upload) do |_operation, path|
      @uploads << path
      @resources["appCustomProductPages"]["kilter-page"].fetch("attributes")["visible"] = true
    end
    error = assert_raises(BoardseshCPP::Error) { runner.run(action: "stage-assets") }
    assert_includes error.message, "visibility changed during"
    refute @client.writes.any? { |_method, path, _body| path.start_with?("/v1/appCustomProductPages/") }
  end

  def test_stage_assets_resumes_partial_reservations_without_touching_keywords
    seed_staging_draft
    upload_attempts = 0
    @client.define_singleton_method(:upload) do |_operation, path|
      upload_attempts += 1
      raise BoardseshCPP::Error, "Interrupted upload" if upload_attempts == 4
      @uploads << path
    end
    instance = runner(keyword_ids: {})
    assert_raises(BoardseshCPP::Error) { instance.run(action: "stage-assets") }
    instance.run(action: "stage-assets")
    assert_equal 9, @client.resources["appScreenshots"].length
    assert_equal 9, @client.uploads.length
    refute @client.writes.any? { |_method, path, _body| path.include?("searchKeywords") }
    write_count = @client.writes.length
    assert_raises(BoardseshCPP::Error) { instance.run(action: "upload") }
    assert_equal write_count, @client.writes.length
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

  def test_client_retains_required_relationship_code_and_known_source_pointer
    response_body = JSON.generate("errors" => [{ "code" => "ENTITY_ERROR.RELATIONSHIP.REQUIRED", "source" => { "pointer" => "/data/relationships/appStoreVersionTemplate" }, "detail" => "Do not log this detail" }])
    error = apple_response_error(response_body)
    assert_equal "Apple API POST failed (HTTP 409; ENTITY_ERROR.RELATIONSHIP.REQUIRED at /data/relationships/appStoreVersionTemplate). Re-run to reconcile after checking App Store Connect.", error.message
  end

  def test_client_retains_only_known_structural_relationship_pointer_shapes
    pointers = [
      "/data/relationships/app",
      "/data/relationships/customProductPageTemplate/data/id",
      "/data/relationships/appCustomProductPageVersions/data/0/type",
      "/included/0/relationships/appCustomProductPage",
      "/included/0/relationships/appCustomProductPageLocalizations/data/0/id",
      "/included/999/relationships/appCustomProductPageVersion/data/999/type"
    ]
    pointers.each do |pointer|
      error = apple_response_error(JSON.generate("errors" => [{ "code" => "ENTITY_ERROR.RELATIONSHIP.REQUIRED", "source" => { "pointer" => pointer } }]))
      assert_includes error.message, "ENTITY_ERROR.RELATIONSHIP.REQUIRED at #{pointer}"
    end
  end

  def test_client_redacts_urls_credentials_and_ids_in_error_codes
    unsafe_codes = [
      "https://upload.apple.com/private?signature=credential",
      "12345678-1234-1234-1234-123456789abc",
      "ENTITY_ERROR.RELATIONSHIP.REQUIRED\nAuthorization: Bearer credential",
      "ENTITY_ERROR.AUTH_TOKEN=credential",
      "A" * 129,
      { "token" => "credential" },
      123,
      nil
    ]
    unsafe_codes.each do |unsafe_code|
      response_body = JSON.generate("errors" => [{ "code" => unsafe_code, "source" => { "pointer" => "/data/relationships/credential" }, "detail" => "Authorization: Bearer credential https://upload.apple.com/private?signature=credential", "id" => "private-resource-id", "links" => { "about" => "https://private.example" } }])
      error = apple_response_error(response_body)
      assert_equal "Apple API POST failed (HTTP 409; UNKNOWN_ERROR). Re-run to reconcile after checking App Store Connect.", error.message
    end
  end

  def test_client_redacts_unknown_relationships_resource_ids_and_unbounded_indexes
    unsafe_pointers = [
      "https://upload.apple.com/private?signature=credential",
      "/data/relationships/credential",
      "/data/relationships/appCustomProductPageVersions/data/private-resource-id/id",
      "/data/relationships/appCustomProductPageVersions/data/1000/id",
      "/data/relationships/appCustomProductPageVersions/data/00/id",
      "/included/1000/relationships/appCustomProductPage",
      "/included/-1/relationships/appCustomProductPage",
      "/included/00/relationships/appCustomProductPage",
      "/included/0/relationships/appCustomProductPage/data/id/private-resource-id",
      "/included/0/relationships/appCustomProductPage~1credential",
      "/included/0/relationships/appCustomProductPage\ncredential",
      { "token" => "credential" },
      123,
      nil
    ]
    unsafe_pointers.each do |unsafe_pointer|
      error = apple_response_error(JSON.generate("errors" => [{ "code" => "ENTITY_ERROR.RELATIONSHIP.REQUIRED", "source" => { "pointer" => unsafe_pointer }, "detail" => "Authorization: Bearer credential" }]))
      assert_equal "Apple API POST failed (HTTP 409; ENTITY_ERROR.RELATIONSHIP.REQUIRED). Re-run to reconcile after checking App Store Connect.", error.message
    end
  end

  def test_client_handles_malformed_error_shapes_without_logging_the_body
    malformed_documents = [nil, [], "credential", { "errors" => "credential" }, { "errors" => [nil] }, { "errors" => ["credential"] }]
    malformed_documents.each do |document|
      error = apple_response_error(JSON.generate(document))
      assert_equal "Apple API POST failed (HTTP 409; malformed error response). Re-run to reconcile after checking App Store Connect.", error.message
    end
    error = apple_response_error(JSON.generate("errors" => [{ "code" => "ENTITY_ERROR.RELATIONSHIP.REQUIRED", "source" => "credential" }]))
    refute_includes error.message, "credential"
    assert_includes error.message, "ENTITY_ERROR.RELATIONSHIP.REQUIRED"
  end

  def test_client_retains_safe_non_json_response_diagnostics
    error = apple_response_error("<html>Authorization: Bearer credential https://upload.apple.com/private</html>")
    assert_equal "Apple API POST failed (HTTP 409; non-JSON response). Re-run to reconcile after checking App Store Connect.", error.message
  end

  def apple_response_error(response_body)
    transport = FakeTransport.new([FakeTransport::Response.new("409", response_body)])
    client = BoardseshCPP::Client.new(token: -> { "test" }, transport: ->(_uri) { transport }, sleeper: ->(_seconds) { flunk "POST retried" })
    error = assert_raises(BoardseshCPP::Error) { client.request("POST", "/v1/appCustomProductPages", {}) }
    assert_equal 1, transport.requests.length
    error
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
      [target, { "referenceName" => "Boardsesh #{target}", "localizations" => { "en-US" => {} } }]
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
      assert_equal 2, body.fetch("included").length
      assert_equal body.dig("data", "relationships", "appCustomProductPageVersions", "data").first.fetch("id"), body.fetch("included").first.fetch("id")
      version, localization = body.fetch("included")
      assert_equal ["appCustomProductPage", "appCustomProductPageLocalizations"], version.fetch("relationships").keys
      assert_empty version.fetch("relationships").fetch("appCustomProductPage")
      assert_equal 2, [version.fetch("id"), localization.fetch("id")].uniq.length
      assert_equal localization.fetch("id"), version.dig("relationships", "appCustomProductPageLocalizations", "data").first.fetch("id")
      assert_equal({ "locale" => "en-US" }, localization.fetch("attributes"))
      assert_equal({ "appCustomProductPageVersion" => {} }, localization.fetch("relationships"))
    end
    assert_equal 4, @client.resources["appCustomProductPageLocalizations"].length
    assert @client.resources["appCustomProductPageLocalizations"].values.all? { |localization| localization.fetch("attributes") == { "locale" => "en-US" } && localization.fetch("keywords", []).empty? }
    assert_empty @client.resources["appScreenshots"]
    assert_empty @client.resources["reviewSubmissions"]
    assert_empty @client.uploads
  end

  def test_create_selects_one_initial_store_locale_from_the_target_configuration
    @manifest["locales"] = { "es" => ["es-ES", "es-MX"] }
    @manifest.fetch("targets").fetch("kilter")["localizations"] = { "es" => {} }
    create_runner.run(action: "create")
    localization = @client.resources["appCustomProductPageLocalizations"].values.first
    assert_equal({ "locale" => "es-ES" }, localization.fetch("attributes"))
    assert_equal 1, @client.resources["appCustomProductPageLocalizations"].length
    assert_equal 1, @client.writes.length
    refute @client.reads.any? { |path| path.include?("appStoreVersions") }
  end

  def test_create_validates_every_missing_target_locale_before_the_first_post
    set_four_create_targets
    @manifest.fetch("targets").fetch("spray")["localizations"] = {}
    error = assert_raises(BoardseshCPP::Error) { create_runner.run(action: "create") }
    assert_includes error.message, "configured initial localization"
    assert_empty @client.writes
    assert_empty @client.uploads
  end

  def test_create_rejects_missing_and_invalid_store_locale_mappings_before_writing
    [nil, {}, { "en-US" => nil }, { "en-US" => [] }, { "en-US" => [nil] }, { "en-US" => ["invalid"] }].each do |mapping|
      @manifest["locales"] = mapping
      assert_raises(BoardseshCPP::Error) { create_runner.run(action: "create") }
      assert_empty @client.writes
    end
  end

  def test_create_stops_after_invalid_initial_localization_readback_without_creating_more_pages
    set_four_create_targets
    %w[missing duplicate locale owner copy screenshots previews keywords].each do |problem|
      @client = FakeApple.new
      original_request = @client.method(:request)
      @client.define_singleton_method(:request) do |method, path, body = nil|
        response = original_request.call(method, path, body)
        if method == "POST" && path == "/v1/appCustomProductPages"
          localization = @resources["appCustomProductPageLocalizations"].values.last
          case problem
          when "missing"
            @resources["appCustomProductPageLocalizations"].delete(localization.fetch("id"))
          when "duplicate"
            seed("appCustomProductPageLocalizations", "duplicate-locale", localization.fetch("attributes").dup, localization.fetch("relationships"))
          when "locale"
            localization.fetch("attributes")["locale"] = "fr-FR"
          when "owner"
            localization.fetch("relationships").fetch("appCustomProductPageVersion").fetch("data")["id"] = "another-version"
          when "copy"
            localization.fetch("attributes")["promotionalText"] = "Unexpected template copy"
          when "screenshots", "previews"
            seed(problem == "screenshots" ? "appScreenshotSets" : "appPreviewSets", "unexpected-assets", {}, "appCustomProductPageLocalization" => link("appCustomProductPageLocalizations", localization.fetch("id")))
          when "keywords"
            localization["keywords"] = ["unexpected-keyword"]
          end
        end
        response
      end
      error = assert_raises(BoardseshCPP::Error) { create_runner.run(action: "create") }
      assert_includes error.message, "initial localization"
      assert_equal 1, @client.writes.length
      assert_equal 1, @client.resources["appCustomProductPages"].length
      assert @client.writes.all? { |method, path, _body| method == "POST" && path == "/v1/appCustomProductPages" }
      assert_empty @client.uploads
      assert_empty @client.resources["reviewSubmissions"]
    end
  end

  def test_create_reuses_existing_pages_without_requiring_or_rewriting_initial_locale_configuration
    create_runner.run(action: "create")
    @manifest.fetch("targets").fetch("kilter").delete("localizations")
    before = JSON.generate(@client.resources)
    write_count = @client.writes.length
    assert_equal "reused", create_runner.run(action: "create").first.fetch("action")
    assert_equal before, JSON.generate(@client.resources)
    assert_equal write_count, @client.writes.length
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
