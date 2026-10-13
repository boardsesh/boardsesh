# frozen_string_literal: true

require "json"
require "digest"
require "net/http"
require "uri"

# Wire shapes verified against Apple's App Store Connect OpenAPI (2026-10-06):
# https://developer.apple.com/sample-code/app-store-connect/app-store-connect-openapi-specification.zip
module BoardseshCPP
  class Error < StandardError; end

  # No credentials or signed upload URLs are written to logs. POST is deliberately
  # not retried: after an ambiguous network failure, the next lane run reconciles
  # Apple's resources before creating anything else.
  class Client
    ORIGIN = "https://api.appstoreconnect.apple.com"
    SAFE_ERROR_CODE = /\A[A-Z0-9_]+(?:\.[A-Z0-9_]+)*\z/.freeze
    ERROR_RELATIONSHIPS = %w[
      app appCustomProductPageVersions appCustomProductPage appStoreVersionTemplate
      customProductPageTemplate appCustomProductPageLocalizations appCustomProductPageVersion
      appCustomProductPageLocalization appScreenshotSet appScreenshots searchKeywords
      reviewSubmission appStoreVersion
    ].freeze
    SAFE_ERROR_POINTER = %r{\A/(?:data|included/(?:0|[1-9][0-9]{0,2}))/relationships/(?:#{ERROR_RELATIONSHIPS.join("|")})(?:/data(?:/(?:0|[1-9][0-9]{0,2}))?(?:/(?:id|type))?)?\z}.freeze

    def initialize(token:, sleeper: ->(seconds) { sleep(seconds) }, transport: ->(uri) { Net::HTTP.new(uri.host, uri.port) })
      @token = token
      @sleeper = sleeper
      @transport = transport
    end

    def request(method, path, body = nil)
      uri = URI(path.start_with?("https://") ? path : "#{ORIGIN}#{path}")
      raise Error, "Refusing an App Store Connect URL outside Apple's API" unless uri.scheme == "https" && uri.host == URI(ORIGIN).host
      response = perform(method, uri, body && JSON.generate(body), { "Authorization" => "Bearer #{@token.call}", "Content-Type" => "application/json" })
      response.body.to_s.empty? ? {} : JSON.parse(response.body)
    end

    def list(path)
      resources = []
      100.times do
        response = request("GET", path)
        resources.concat(response.fetch("data"))
        path = response.dig("links", "next")
        return resources unless path
      end
      raise Error, "App Store Connect pagination exceeded 100 pages"
    end

    def upload(operation, path)
      uri = URI(operation.fetch("url"))
      raise Error, "Apple upload operation must use HTTPS" unless uri.scheme == "https"
      offset = operation.fetch("offset")
      length = operation.fetch("length")
      raise Error, "Invalid screenshot upload range" unless offset >= 0 && length > 0 && offset + length <= File.size(path)
      headers = operation.fetch("requestHeaders", []).to_h { |header| [header.fetch("name"), header.fetch("value")] }
      bytes = File.open(path, "rb") { |file| file.seek(offset); file.read(length) }
      perform(operation.fetch("method"), uri, bytes, headers)
    end

    private

    def error_diagnostics(response_body)
      document = JSON.parse(response_body)
      return "malformed error response" unless document.is_a?(Hash)
      errors = document.fetch("errors", [])
      return "malformed error response" unless errors.is_a?(Array) && errors.all? { |error| error.is_a?(Hash) }
      diagnostics = errors.first(10).map do |error|
        error_code = error["code"]
        safe_code = error_code.is_a?(String) && error_code.bytesize <= 128 && SAFE_ERROR_CODE.match?(error_code) ? error_code : "UNKNOWN_ERROR"
        source = error["source"]
        pointer = source.is_a?(Hash) && source["pointer"]
        safe_pointer = pointer.is_a?(String) && pointer.bytesize <= 256 && SAFE_ERROR_POINTER.match?(pointer)
        safe_pointer ? "#{safe_code} at #{pointer}" : safe_code
      end
      diagnostics.empty? ? "UNKNOWN_ERROR" : diagnostics.uniq.join(", ")
    rescue JSON::ParserError
      "non-JSON response"
    end

    def perform(method, uri, body, headers)
      attempts = 0
      begin
        attempts += 1
        http = @transport.call(uri)
        http.use_ssl = true
        http.open_timeout = 30
        http.read_timeout = 120
        request = Net::HTTPGenericRequest.new(method, !body.nil?, method != "HEAD", uri.request_uri, headers)
        request.body = body if body
        response = http.request(request)
        code = response.code.to_i
        return response if code >= 200 && code < 300
        raise Net::ReadTimeout if method != "POST" && (code == 429 || code >= 500) && attempts < 3
        # Error details can contain signed asset URLs. Retain only bounded codes
        # and allowlisted structural relationship pointers, never IDs or details.
        raise Error, "Apple API #{method} failed (HTTP #{code}; #{error_diagnostics(response.body)}). Re-run to reconcile after checking App Store Connect."
      rescue Net::OpenTimeout, Net::ReadTimeout, IOError, SystemCallError => error
        if method != "POST" && attempts < 3
          @sleeper.call(attempts * 5)
          retry
        end
        raise Error, "Apple API #{method} transport failed (#{error.class}); re-run to reconcile."
      end
    end
  end

  class Runner
    EDITABLE = %w[PREPARE_FOR_SUBMISSION READY_FOR_REVIEW REJECTED].freeze
    REVIEWING = %w[WAITING_FOR_REVIEW IN_REVIEW ACCEPTED].freeze
    DISPLAY_DIMENSIONS = {
      "APP_IPHONE_67" => [[1260, 2736], [1290, 2796], [1320, 2868]],
      "APP_IPHONE_61" => [[1170, 2532], [1179, 2556], [1206, 2622]],
      "APP_IPAD_PRO_3GEN_129" => [[2048, 2732], [2064, 2752], [2732, 2048], [2752, 2064]],
      "APP_IPAD_PRO_3GEN_11" => [[1668, 2388], [1668, 2420], [2388, 1668], [2420, 1668]]
    }.freeze

    def initialize(client:, repo_root:, manifest:, app_id:, manifest_sha256: nil, keyword_ids: {}, log: ->(_message) {}, sleeper: ->(seconds) { sleep(seconds) })
      @client, @root, @manifest, @app_id = client, repo_root, manifest, app_id
      @manifest_sha256 = manifest_sha256 || Digest::SHA256.hexdigest(JSON.generate(manifest))
      @keyword_ids, @log, @sleeper = keyword_ids, log, sleeper
    end

    def run(target: "all", action: "plan")
      raise Error, "CPP action must be plan, create, upload, or submit" unless %w[plan create upload submit].include?(action)
      targets = @manifest.fetch("targets")
      selected = target == "all" ? targets.keys : [target]
      raise Error, "Unknown CPP target #{target}" unless selected.all? { |name| targets.key?(name) }
      return read_only_plan(selected, targets) if action == "plan"
      return create_drafts(selected, targets) if action == "create"
      # Validate every selected target and remote conflict before the first write.
      assets = selected.to_h { |name| [name, local_assets(name, targets.fetch(name))] }
      preflight = remote_preflight(selected, targets, assets, action)
      results = preflight.map { |entry| reconcile(entry) }
      submit(results) if action == "submit"
      results.map { |entry| summary(entry, entry.fetch("unchanged") ? "unchanged" : action) }
    end

    private

    # Create only the named page and its empty initial draft in one documented
    # compound request. This never copies a template or writes listing metadata,
    # screenshots, localizations, keywords, visibility, or review submissions.
    # Existing pages are read and returned unchanged, including live pages.
    def create_drafts(selected, targets)
      names = selected.map { |name| targets.fetch(name).fetch("referenceName") }
      raise Error, "CPP reference names must be nonempty and unique" unless names.all? { |name| name.is_a?(String) && !name.strip.empty? } && names.uniq.length == names.length
      pages = @client.list("/v1/apps/#{@app_id}/appCustomProductPages?limit=200")
      # Resolve every existing match before the first POST so an ambiguous or
      # misbound or versionless existing page cannot leave an avoidable partial creation.
      candidates = selected.zip(names).map do |target, name|
        matches = pages.select { |page| page.dig("attributes", "name") == name }
        raise Error, "Multiple CPPs named #{name}; resolve ownership before creation" if matches.length > 1
        page = matches.first && verified_draft_page(matches.first.fetch("id"), name)
        versions = page && verified_page_versions(page)
        if page && versions.none? { |version| version.dig("attributes", "state") != "REPLACED_WITH_NEW_VERSION" }
          raise Error, "CPP #{name} has no current version; inspect the page in App Store Connect before creation"
        end
        { "target" => target, "name" => name, "page" => page, "versions" => versions }
      end
      candidates.map do |candidate|
        created = candidate["page"].nil?
        if created
          # Apple's ${...} syntax marks a request-local resource to create,
          # rather than an existing App Store Connect ID. The linkage and
          # included resource must use the same placeholder within this POST.
          # https://developer.apple.com/videos/play/wwdc2020/10004/
          inline_version_id = '${new-cpp-version}'
          response = @client.request("POST", "/v1/appCustomProductPages", {
            "data" => {
              "type" => "appCustomProductPages",
              "attributes" => { "name" => candidate.fetch("name") },
              "relationships" => {
                "app" => { "data" => { "type" => "apps", "id" => @app_id } },
                "appCustomProductPageVersions" => { "data" => [{ "type" => "appCustomProductPageVersions", "id" => inline_version_id }] }
              }
            },
            "included" => [{ "type" => "appCustomProductPageVersions", "id" => inline_version_id, "relationships" => { "appCustomProductPage" => {} } }]
          })
          page_id = response.fetch("data").fetch("id")
          candidate["page"] = verified_draft_page(page_id, candidate.fetch("name"))
          candidate["versions"] = verified_page_versions(candidate.fetch("page"))
          unless candidate.fetch("versions").length == 1 && candidate.fetch("versions").first.dig("attributes", "state") == "PREPARE_FOR_SUBMISSION"
            raise Error, "Created CPP #{candidate.fetch('name')} did not return one initial draft; inspect the page in App Store Connect before retrying"
          end
        end
        page = candidate.fetch("page")
        versions = candidate.fetch("versions")
        current = versions.reject { |version| version.dig("attributes", "state") == "REPLACED_WITH_NEW_VERSION" }.max_by { |version| version.dig("attributes", "version").to_s.split(".").map(&:to_i) }
        {
          "target" => candidate.fetch("target"), "action" => created ? "created" : "reused",
          "appId" => @app_id, "referenceName" => candidate.fetch("name"), "pageId" => page.fetch("id"),
          "url" => page.dig("attributes", "url"), "visible" => page.dig("attributes", "visible"),
          "versionId" => current && current["id"], "state" => current && current.dig("attributes", "state"),
          "versions" => versions.map { |version| { "id" => version.fetch("id"), "version" => version.dig("attributes", "version"), "state" => version.dig("attributes", "state") } },
          "publication" => created ? "Empty draft: screenshots and organic keywords remain pending; no review was submitted." : "Existing page reused without edits; no review submission was created."
        }
      end
    end

    def verified_draft_page(page_id, expected_name)
      page = @client.request("GET", "/v1/appCustomProductPages/#{page_id}?include=app").fetch("data")
      unless page["type"] == "appCustomProductPages" && page["id"] == page_id && page.dig("attributes", "name") == expected_name && page.dig("relationships", "app", "data", "type") == "apps" && page.dig("relationships", "app", "data", "id") == @app_id
        raise Error, "CPP #{expected_name} has unexpected identity or app ownership; no further pages were created"
      end
      begin
        url = URI(page.dig("attributes", "url").to_s)
        valid_url = url.scheme == "https" && url.host == "apps.apple.com" && URI.decode_www_form(url.query.to_s).to_h["ppid"] == page_id
      rescue URI::InvalidURIError, ArgumentError
        valid_url = false
      end
      raise Error, "CPP #{expected_name} did not return its verified App Store page URL" unless valid_url
      page
    end

    def verified_page_versions(page)
      versions = @client.list("/v1/appCustomProductPages/#{page.fetch('id')}/appCustomProductPageVersions?include=appCustomProductPage&limit=200")
      unless versions.all? { |version| version["type"] == "appCustomProductPageVersions" && version.dig("relationships", "appCustomProductPage", "data", "type") == "appCustomProductPages" && version.dig("relationships", "appCustomProductPage", "data", "id") == page.fetch("id") }
        raise Error, "CPP #{page.dig('attributes', 'name')} version ownership verification failed"
      end
      versions
    end

    # Planning needs credentials, not a native simulator or a completed capture.
    # Keep unresolved local inputs in the report while reading the real approved
    # keyword catalogue. IDs remain opaque; no order/encoding assumptions.
    def read_only_plan(selected, targets)
      versions = @client.list("/v1/apps/#{@app_id}/appStoreVersions?filter[platform]=IOS&limit=200")
      approved = versions.select { |version| %w[READY_FOR_SALE READY_FOR_DISTRIBUTION].include?(version.dig("attributes", "appStoreState")) || version.dig("attributes", "appVersionState") == "READY_FOR_DISTRIBUTION" }.max_by { |version| version.dig("attributes", "createdDate").to_s }
      localized_approved = approved ? @client.list("/v1/appStoreVersions/#{approved.fetch('id')}/appStoreVersionLocalizations?limit=200") : []
      catalog = localized_approved.to_h do |localization|
        terms = localization.dig("attributes", "keywords").to_s.split(",").map(&:strip).reject(&:empty?)
        ids = @client.list("/v1/appStoreVersionLocalizations/#{localization.fetch('id')}/searchKeywords?limit=200").map { |keyword| keyword.fetch("id") }
        [localization.dig("attributes", "locale"), { "approvedTerms" => terms, "eligibleIds" => ids }]
      end
      pages = @client.list("/v1/apps/#{@app_id}/appCustomProductPages?limit=200")
      page_versions = {}
      assignments = Hash.new { |hash, key| hash[key] = [] }
      pages.each do |page|
        versions_for_page = @client.list("/v1/appCustomProductPages/#{page.fetch('id')}/appCustomProductPageVersions?limit=200")
        page_versions[page.fetch("id")] = versions_for_page
        versions_for_page.reject { |version| version.dig("attributes", "state") == "REPLACED_WITH_NEW_VERSION" }.each do |version|
          localizations(version).each do |localized|
            @client.list("/v1/appCustomProductPageLocalizations/#{localized.fetch('id')}/searchKeywords?limit=200").each do |keyword|
              assignments[localized.dig("attributes", "locale")] << { "keywordId" => keyword.fetch("id"), "pageId" => page.fetch("id"), "referenceName" => page.dig("attributes", "name"), "versionId" => version.fetch("id"), "state" => version.dig("attributes", "state") }
            end
          end
        end
      end
      selected.map do |name|
        config = targets.fetch(name)
        diagnostics = []
        begin
          local_assets(name, config)
        rescue Error, JSON::ParserError, KeyError, Errno::ENOENT, Errno::ENOTDIR => error
          diagnostics << "Local publication inputs unresolved: #{error.message}"
        end
        missing_sets = @manifest.fetch("locales").values.flatten.sum do |locale|
          @manifest.fetch("devices").keys.count do |device|
            folder = File.join(@root, "app-stores", "apple", "cpp", name, "screenshots", locale, device)
            !File.file?(File.join(folder, "presentation.json")) || Dir.glob(File.join(folder, "*.png")).length != 9
          end
        end
        diagnostics << "#{missing_sets} locale/device screenshot sets need nine PNGs and presentation.json" if missing_sets.positive?
        diagnostics << "No approved iOS App Store version; keyword assignment requires approval" unless approved
        matching_pages = pages.select { |page| page.dig("attributes", "name") == config.fetch("referenceName") }
        diagnostics << "Multiple pages use this reference name; resolve ownership before upload" if matching_pages.length > 1
        page = matching_pages.length == 1 ? matching_pages.first : nil
        current = page && page_versions.fetch(page.fetch("id")).reject { |version| version.dig("attributes", "state") == "REPLACED_WITH_NEW_VERSION" }.max_by { |version| version.dig("attributes", "version").to_s.split(".").map(&:to_i) }
        localized_catalog = @manifest.fetch("locales").flat_map do |app_locale, store_locales|
          requested = config.fetch("localizations").fetch(app_locale).fetch("keywords")
          store_locales.map do |locale|
            approved_catalog = catalog[locale] || { "approvedTerms" => [], "eligibleIds" => [] }
            approved_terms = approved_catalog.fetch("approvedTerms").map(&:downcase)
            absent_terms = requested.reject { |term| approved_terms.include?(term.downcase) }
            diagnostics << "#{locale}: latest approved version is missing requested keywords #{absent_terms.join(', ')}" unless absent_terms.empty?
            unresolved = requested.filter_map do |term|
              keyword_id = @keyword_ids.dig(locale, term) || @keyword_ids.dig(locale, term.downcase)
              conflicting = assignments[locale].select { |assignment| keyword_id && assignment.fetch("keywordId") == keyword_id && (!page || assignment.fetch("pageId") != page.fetch("id")) }
              diagnostics << "#{locale}: #{term} is already assigned to #{conflicting.map { |assignment| assignment.fetch('referenceName') }.uniq.join(', ')}" unless conflicting.empty?
              term unless keyword_id && approved_catalog.fetch("eligibleIds").include?(keyword_id)
            end
            diagnostics << "#{locale}: verified keyword ID mappings needed for #{unresolved.join(', ')}" unless unresolved.empty?
            approved_catalog.merge("locale" => locale, "requestedTerms" => requested, "currentAssignments" => assignments[locale])
          end
        end
        { "target" => name, "action" => "planned", "pageId" => page && page["id"], "url" => page && page.dig("attributes", "url"), "versionId" => current && current["id"], "state" => current && current.dig("attributes", "state"), "approvedVersionId" => approved && approved["id"], "diagnostics" => diagnostics, "keywordCatalog" => localized_catalog }
      end
    end

    def local_assets(name, config)
      fixture_reference = config["fixtureReference"]
      raise Error, "CPP #{name} needs its own verified fixtureReference before publication" unless fixture_reference
      fixture = JSON.parse(File.read(File.expand_path(fixture_reference, @root)))
      fixture_hash = fixture.fetch("sha256")
      raise Error, "CPP #{name} fixtureReference has no valid SHA256" unless fixture_hash.match?(/\A[a-f0-9]{64}\z/)
      screenshot_root = File.expand_path(config.fetch("screenshotsRoot"), @root)
      expected_root = File.join(@root, "app-stores", "apple", "cpp", name, "screenshots")
      raise Error, "CPP #{name} screenshotRoot must be isolated at #{expected_root}" unless screenshot_root == expected_root
      @manifest.fetch("locales").flat_map do |app_locale, store_locales|
        localized = config.fetch("localizations").fetch(app_locale)
        raise Error, "CPP #{name}/#{app_locale} promotional text exceeds 170 characters" if localized.fetch("promotionalText").length > 170
        raise Error, "CPP #{name}/#{app_locale} needs explicit keywords" if localized.fetch("keywords").empty?
        store_locales.map do |store_locale|
          devices = @manifest.fetch("devices").to_h do |device, display_type|
            recipes = config.fetch("recipes").fetch(device.start_with?("ipad") ? "ipad" : "phone")
            filenames = recipes.map do |recipe|
              recipe.is_a?(String) ? recipe : recipe.fetch("output")
            end
            raise Error, "CPP #{name}/#{device} must contain nine ordered recipes" unless filenames.length == 9 && filenames.uniq.length == 9
            folder = File.join(screenshot_root, store_locale, device)
            presentation_path = File.join(folder, "presentation.json")
            raise Error, "CPP #{name}/#{store_locale}/#{device} needs presentation.json provenance" unless File.file?(presentation_path)
            presentation = JSON.parse(File.read(presentation_path))
            provenance = presentation.fetch("cpp", {})
            unless presentation["version"] == 1 && presentation["locale"] == app_locale && provenance["target"] == name && provenance["manifestSha256"] == @manifest_sha256 && provenance["fixtureSha256"] == fixture_hash
              raise Error, "CPP #{name}/#{store_locale}/#{device} has stale target, manifest, or fixture provenance; recapture and frame this set"
            end
            actual = Dir.glob(File.join(folder, "*.png")).map { |path| File.basename(path) }.sort
            raise Error, "CPP #{name}/#{store_locale}/#{device} needs exactly these screenshots: #{filenames.join(', ')}" unless actual == filenames.sort
            screenshots = filenames.map do |filename|
              path = File.join(folder, filename)
              provenance_file = presentation.fetch("files").fetch(filename)
              unless provenance_file["rawBytes"].is_a?(Integer) && provenance_file["rawBytes"] >= 61_440 && provenance_file["rawSha256"].to_s.match?(/\A[a-f0-9]{64}\z/) && provenance_file["framedSha256"] == Digest::SHA256.file(path).hexdigest
                raise Error, "CPP #{name}/#{device}/#{filename} has stale provenance or a blank raw capture"
              end
              sources = provenance_file["sources"]
              recipe = recipes.find { |candidate| candidate.is_a?(Hash) && candidate["output"] == filename }
              expected_sources = recipe && recipe["sources"]
              if expected_sources && expected_sources.length > 1 && (!sources || sources.keys.sort != expected_sources.sort)
                raise Error, "CPP #{name}/#{device}/#{filename} lacks every composite source hash"
              end
              if sources && (sources.empty? || sources.values.any? { |source| !source["rawBytes"].is_a?(Integer) || source["rawBytes"] < 61_440 || !source["rawSha256"].to_s.match?(/\A[a-f0-9]{64}\z/) } || provenance_file["rawBytes"] != sources.values.map { |source| source.fetch("rawBytes") }.min)
                raise Error, "CPP #{name}/#{device}/#{filename} has invalid composite source provenance"
              end
              header = File.binread(path, 24)
              dimensions = header.byteslice(16, 8)&.unpack("NN")
              valid_png = header.start_with?("\x89PNG\r\n\x1a\n".b) && header.byteslice(12, 4) == "IHDR"
              raise Error, "CPP #{name}/#{device}/#{filename} has invalid PNG dimensions #{dimensions}" unless valid_png && DISPLAY_DIMENSIONS.fetch(display_type).include?(dimensions)
              { "path" => path, "fileName" => filename, "fileSize" => File.size(path), "checksum" => Digest::MD5.file(path).hexdigest }
            end
            [display_type, screenshots]
          end
          { "locale" => store_locale, "promotionalText" => localized.fetch("promotionalText"), "keywords" => localized.fetch("keywords"), "devices" => devices }
        end
      end
    end

    def remote_preflight(selected, targets, assets, action)
      versions = @client.list("/v1/apps/#{@app_id}/appStoreVersions?filter[platform]=IOS&limit=200")
      approved = versions.select { |version| %w[READY_FOR_SALE READY_FOR_DISTRIBUTION].include?(version.dig("attributes", "appStoreState")) || version.dig("attributes", "appVersionState") == "READY_FOR_DISTRIBUTION" }.max_by { |version| version.dig("attributes", "createdDate").to_s }
      raise Error, "CPP keywords require a latest approved iOS App Store version" unless approved
      approved_locales = @client.list("/v1/appStoreVersions/#{approved.fetch('id')}/appStoreVersionLocalizations?limit=200").to_h { |localization| [localization.dig("attributes", "locale"), localization] }
      pages = @client.list("/v1/apps/#{@app_id}/appCustomProductPages?limit=200")
      remote_versions = pages.to_h do |page|
        [page.fetch("id"), @client.list("/v1/appCustomProductPages/#{page.fetch('id')}/appCustomProductPageVersions?limit=200")]
      end
      # Conflicts include pages outside this launch, and all active versions.
      owners = Hash.new { |hash, key| hash[key] = [] }
      remote_versions.each do |page_id, page_versions|
        page_versions.reject { |version| version.dig("attributes", "state") == "REPLACED_WITH_NEW_VERSION" }.each do |version|
          localizations(version).each do |localization|
            @client.list("/v1/appCustomProductPageLocalizations/#{localization.fetch('id')}/searchKeywords?limit=200").each do |keyword|
              owners[[localization.dig("attributes", "locale"), keyword.fetch("id")]] << page_id
            end
          end
        end
      end
      desired_owners = {}
      selected.map do |name|
        config = targets.fetch(name)
        matches = pages.select { |page| page.dig("attributes", "name") == config.fetch("referenceName") }
        raise Error, "Multiple CPPs named #{config.fetch('referenceName')}; resolve ambiguous ownership in App Store Connect" if matches.length > 1
        page = matches.first
        page_versions = page ? remote_versions.fetch(page.fetch("id")) : []
        assets.fetch(name).each do |localization|
          locale = localization.fetch("locale")
          approved_localization = approved_locales[locale]
          raise Error, "Latest approved app version has no #{locale} localization" unless approved_localization
          approved_terms = approved_localization.dig("attributes", "keywords").to_s.split(",").map { |term| term.strip.downcase }
          eligible_ids = @client.list("/v1/appStoreVersionLocalizations/#{approved_localization.fetch('id')}/searchKeywords?limit=200").map { |keyword| keyword.fetch("id") }
          localization["keywordIds"] = localization.fetch("keywords").filter_map do |term|
            raise Error, "CPP #{name}/#{locale} keyword '#{term}' is missing from the latest approved version" unless approved_terms.include?(term.downcase)
            keyword_id = @keyword_ids.dig(locale, term) || @keyword_ids.dig(locale, term.downcase)
            unless keyword_id
              @log.call("CPP #{name}/#{locale}: map '#{term}' using ASC_CPP_KEYWORD_IDS_JSON; eligible opaque IDs: #{eligible_ids.join(', ')}")
              raise Error, "Missing verified keyword ID for #{name}/#{locale}/#{term}; set ASC_CPP_KEYWORD_IDS_JSON" unless action == "plan"
              next
            end
            raise Error, "Keyword ID for #{name}/#{locale}/#{term} is not eligible on the latest approved version" unless eligible_ids.include?(keyword_id)
            key = [locale, keyword_id]
            conflicting = owners[key].uniq.reject { |owner| page && owner == page.fetch("id") }
            raise Error, "Keyword #{locale}/#{term} is assigned to another CPP" unless conflicting.empty?
            raise Error, "Keyword #{locale}/#{term} is requested by two selected CPPs" if desired_owners.key?(key) && desired_owners[key] != name
            desired_owners[key] = name
            keyword_id
          end
        end
        current = page_versions.reject { |version| version.dig("attributes", "state") == "REPLACED_WITH_NEW_VERSION" }.max_by { |version| version.dig("attributes", "version").to_s.split(".").map(&:to_i) }
        entry = { "target" => name, "config" => config, "assets" => assets.fetch(name), "page" => page, "version" => current }
        entry["unchanged"] = current && identical?(current, entry.fetch("assets"))
        if current && REVIEWING.include?(current.dig("attributes", "state")) && !entry["unchanged"]
          raise Error, "CPP #{name} is #{current.dig('attributes', 'state')}; screenshots, text, and keywords cannot be edited under review"
        end
        # Never delete a draft's assets to make room. An unchanged partial upload
        # can resume; a conflicting draft must be resolved by its owner.
        if current && EDITABLE.include?(current.dig("attributes", "state")) && !compatible?(current, entry.fetch("assets"))
          raise Error, "CPP #{name} has conflicting draft assets or keywords; no assets were deleted. Resolve the draft in App Store Connect before retrying."
        end
        entry
      end
    end

    def localizations(version)
      @client.list("/v1/appCustomProductPageVersions/#{version.fetch('id')}/appCustomProductPageLocalizations?limit=200")
    end

    def snapshot(version)
      localizations(version).to_h do |localization|
        sets = @client.list("/v1/appCustomProductPageLocalizations/#{localization.fetch('id')}/appScreenshotSets?limit=200")
        screenshot_sets = sets.to_h do |set|
          [set.dig("attributes", "screenshotDisplayType"), { "set" => set, "screenshots" => @client.list("/v1/appScreenshotSets/#{set.fetch('id')}/appScreenshots?limit=200") }]
        end
        keywords = @client.list("/v1/appCustomProductPageLocalizations/#{localization.fetch('id')}/searchKeywords?limit=200").map { |keyword| keyword.fetch("id") }
        [localization.dig("attributes", "locale"), { "localization" => localization, "sets" => screenshot_sets, "keywords" => keywords }]
      end
    end

    def matching_screenshot?(remote, local)
      remote.dig("attributes", "fileName") == local.fetch("fileName") && remote.dig("attributes", "fileSize") == local.fetch("fileSize") && remote.dig("attributes", "sourceFileChecksum") == local.fetch("checksum")
    end

    def identical?(version, desired)
      remote = snapshot(version)
      return false unless remote.keys.sort == desired.map { |localization| localization.fetch("locale") }.sort
      desired.all? do |localization|
        existing = remote.fetch(localization.fetch("locale"))
        existing.fetch("localization").dig("attributes", "promotionalText") == localization.fetch("promotionalText") &&
          existing.fetch("keywords").sort == localization.fetch("keywordIds").sort &&
          existing.fetch("sets").keys.sort == localization.fetch("devices").keys.sort &&
          localization.fetch("devices").all? do |display_type, screenshots|
            uploaded = existing.fetch("sets").fetch(display_type).fetch("screenshots")
            uploaded.length == screenshots.length && uploaded.zip(screenshots).all? { |image, local| matching_screenshot?(image, local) && image.dig("attributes", "assetDeliveryState", "state") == "COMPLETE" }
          end
      end
    end

    def compatible?(version, desired)
      remote = snapshot(version)
      expected = desired.to_h { |localization| [localization.fetch("locale"), localization] }
      remote.all? do |locale, existing|
        localized = expected[locale]
        next false unless localized && (existing.fetch("keywords") - localized.fetch("keywordIds")).empty?
        existing.fetch("sets").all? do |display_type, set|
          desired_images = localized.fetch("devices")[display_type]
          next false unless desired_images && set.fetch("screenshots").length <= desired_images.length
          set.fetch("screenshots").each_with_index.all? do |image, index|
            local = desired_images[index]
            # Reservations not yet committed do not have a checksum; verify name
            # and byte count and re-upload the exact bytes before committing.
            matching_screenshot?(image, local) || (image.dig("attributes", "sourceFileChecksum").nil? && image.dig("attributes", "fileName") == local.fetch("fileName") && image.dig("attributes", "fileSize") == local.fetch("fileSize"))
          end
        end
      end
    end

    def create(type, attributes, relationships)
      payload = { "data" => { "type" => type, "relationships" => relationships } }
      payload["data"]["attributes"] = attributes unless attributes.empty?
      @client.request("POST", "/v1/#{type}", payload).fetch("data")
    end

    def relationship(type, resource)
      { "data" => { "type" => type, "id" => resource.fetch("id") } }
    end

    def patch(type, resource, attributes)
      @client.request("PATCH", "/v1/#{type}/#{resource.fetch('id')}", { "data" => { "type" => type, "id" => resource.fetch("id"), "attributes" => attributes } })
    end

    def reconcile(entry)
      return entry if entry.fetch("unchanged")
      page = entry["page"] ||= create("appCustomProductPages", { "name" => entry.fetch("config").fetch("referenceName") }, { "app" => { "data" => { "type" => "apps", "id" => @app_id } } })
      current = entry["version"]
      unless current && EDITABLE.include?(current.dig("attributes", "state"))
        current = create("appCustomProductPageVersions", {}, { "appCustomProductPage" => relationship("appCustomProductPages", page) })
        entry["version"] = current
      end
      # A fresh version may inherit Apple's previous assets. Never erase them.
      raise Error, "CPP #{entry.fetch('target')} new version inherited conflicting assets; no assets were deleted" unless compatible?(current, entry.fetch("assets"))
      remote = snapshot(current)
      entry.fetch("assets").each do |desired|
        existing = remote[desired.fetch("locale")]
        localization = existing ? existing.fetch("localization") : create("appCustomProductPageLocalizations", { "locale" => desired.fetch("locale"), "promotionalText" => desired.fetch("promotionalText") }, { "appCustomProductPageVersion" => relationship("appCustomProductPageVersions", current) })
        patch("appCustomProductPageLocalizations", localization, { "promotionalText" => desired.fetch("promotionalText") }) if localization.dig("attributes", "promotionalText") != desired.fetch("promotionalText")
        missing_keywords = desired.fetch("keywordIds") - (existing ? existing.fetch("keywords") : [])
        unless missing_keywords.empty?
          @client.request("POST", "/v1/appCustomProductPageLocalizations/#{localization.fetch('id')}/relationships/searchKeywords", { "data" => missing_keywords.map { |keyword_id| { "type" => "appKeywords", "id" => keyword_id } } })
        end
        desired.fetch("devices").each do |display_type, screenshots|
          existing_set = existing && existing.fetch("sets")[display_type]
          set = existing_set ? existing_set.fetch("set") : create("appScreenshotSets", { "screenshotDisplayType" => display_type }, { "appCustomProductPageLocalization" => relationship("appCustomProductPageLocalizations", localization) })
          uploaded = existing_set ? existing_set.fetch("screenshots") : []
          ordered = screenshots.each_with_index.map { |local, index| upload_screenshot(set, uploaded[index], local) }
          @client.request("PATCH", "/v1/appScreenshotSets/#{set.fetch('id')}/relationships/appScreenshots", { "data" => ordered.map { |image| { "type" => "appScreenshots", "id" => image.fetch("id") } } })
        end
      end
      raise Error, "CPP #{entry.fetch('target')} verification failed after upload" unless identical?(current, entry.fetch("assets"))
      entry
    end

    def upload_screenshot(set, existing, local)
      image = existing || create("appScreenshots", { "fileName" => local.fetch("fileName"), "fileSize" => local.fetch("fileSize") }, { "appScreenshotSet" => relationship("appScreenshotSets", set) })
      state = image.dig("attributes", "assetDeliveryState", "state")
      return image if state == "COMPLETE" && matching_screenshot?(image, local)
      if state == "AWAITING_UPLOAD" || state.nil?
        operations = image.dig("attributes", "uploadOperations")
        raise Error, "Screenshot reservation has no upload operations; resolve it in App Store Connect" unless operations && !operations.empty?
        operations.each { |operation| @client.upload(operation, local.fetch("path")) }
        patch("appScreenshots", image, { "uploaded" => true, "sourceFileChecksum" => local.fetch("checksum") })
      end
      60.times do
        image = @client.request("GET", "/v1/appScreenshots/#{image.fetch('id')}").fetch("data")
        state = image.dig("attributes", "assetDeliveryState", "state")
        return image if state == "COMPLETE" && matching_screenshot?(image, local)
        raise Error, "Screenshot #{local.fetch('fileName')} failed Apple processing (#{state}); no assets were deleted" if %w[FAILED ERROR].include?(state)
        @sleeper.call(5)
      end
      raise Error, "Screenshot #{local.fetch('fileName')} processing exceeded 300 seconds; re-run to resume"
    end

    def submit(entries)
      entries.each do |entry|
        patch("appCustomProductPages", entry.fetch("page"), { "visible" => true }) if entry.fetch("page").dig("attributes", "visible") == false
      end
      pending = entries.reject { |entry| entry.fetch("unchanged") && (REVIEWING + %w[APPROVED]).include?(entry.fetch("version").dig("attributes", "state")) }
      return if pending.empty?
      desired_ids = pending.map { |entry| entry.fetch("version").fetch("id") }
      submissions = @client.list("/v1/apps/#{@app_id}/reviewSubmissions?limit=200")
      # Resume only a nonempty CPP-only draft wholly owned by this selected set.
      candidates = submissions.select { |submission| submission.dig("attributes", "state") == "READY_FOR_REVIEW" && submission.dig("attributes", "platform") == "IOS" }.filter_map do |submission|
        items = @client.list("/v1/reviewSubmissions/#{submission.fetch('id')}/items?include=appCustomProductPageVersion&limit=200")
        ids = items.map { |item| item.dig("relationships", "appCustomProductPageVersion", "data", "id") }
        next unless !ids.empty? && ids.none?(&:nil?) && (ids - desired_ids).empty?
        [submission, ids]
      end
      raise Error, "Multiple matching CPP-only review drafts; resolve ambiguity in App Store Connect" if candidates.length > 1
      submission, existing_ids = candidates.first || [create("reviewSubmissions", { "platform" => "IOS" }, { "app" => { "data" => { "type" => "apps", "id" => @app_id } } }), []]
      pending.each do |entry|
        version = entry.fetch("version")
        next if existing_ids.include?(version.fetch("id"))
        create("reviewSubmissionItems", {}, { "reviewSubmission" => relationship("reviewSubmissions", submission), "appCustomProductPageVersion" => relationship("appCustomProductPageVersions", version) })
      end
      # Re-read final membership immediately before the irreversible submission.
      items = @client.list("/v1/reviewSubmissions/#{submission.fetch('id')}/items?include=appCustomProductPageVersion&limit=200")
      actual = items.map { |item| item.dig("relationships", "appCustomProductPageVersion", "data", "id") }
      raise Error, "Review draft includes unexpected items; refusing submission" unless actual.sort == desired_ids.sort
      pending.each do |entry|
        raise Error, "CPP changed before review submission" unless identical?(entry.fetch("version"), entry.fetch("assets"))
      end
      patch("reviewSubmissions", submission, { "submitted" => true })
      pending.each { |entry| entry["reviewSubmissionId"] = submission.fetch("id") }
    end

    def summary(entry, action)
      page = entry["page"]
      version = entry["version"]
      state = version && @client.request("GET", "/v1/appCustomProductPageVersions/#{version.fetch('id')}").dig("data", "attributes", "state")
      { "target" => entry.fetch("target"), "action" => action, "pageId" => page && page["id"], "url" => page && page.dig("attributes", "url"), "versionId" => version && version["id"], "state" => state, "reviewSubmissionId" => entry["reviewSubmissionId"] }
    end
  end
end
