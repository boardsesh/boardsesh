# frozen_string_literal: true

require_relative "store_audit"
require_relative "custom_product_pages"

module BoardseshStoreReview
  Error = BoardseshStoreAudit::Error
  DEFAULT_COUNTS = { "APP_IPHONE_67" => 9, "APP_IPHONE_61" => 9, "APP_IPAD_PRO_3GEN_129" => 6, "APP_IPAD_PRO_3GEN_11" => 6 }.freeze
  EDITABLE = %w[PREPARE_FOR_SUBMISSION READY_FOR_REVIEW].freeze
  REQUIRES_RESOLUTION = %w[REJECTED METADATA_REJECTED DEVELOPER_REJECTED].freeze
  SUBMITTED = %w[WAITING_FOR_REVIEW IN_REVIEW ACCEPTED APPROVED PENDING_DEVELOPER_RELEASE PENDING_APPLE_RELEASE PROCESSING_FOR_DISTRIBUTION READY_FOR_DISTRIBUTION READY_FOR_SALE].freeze
  REVIEW_ACTIVE = %w[WAITING_FOR_REVIEW IN_REVIEW COMPLETING COMPLETE].freeze
  CPP_CONTEXT_APPROVED = %w[READY_FOR_DISTRIBUTION PENDING_DEVELOPER_RELEASE PENDING_APPLE_RELEASE].freeze
  CPP_CONTEXT_NOT_APPROVED = %w[PREPARE_FOR_SUBMISSION READY_FOR_REVIEW WAITING_FOR_REVIEW IN_REVIEW REJECTED METADATA_REJECTED DEVELOPER_REJECTED INVALID_BINARY REPLACED_WITH_NEW_VERSION NOT_APPLICABLE].freeze
  METADATA_FILES = { "description" => "description.txt", "keywords" => "keywords.txt", "marketingUrl" => "marketing_url.txt", "promotionalText" => "promotional_text.txt", "supportUrl" => "support_url.txt", "whatsNew" => "release_notes.txt" }.freeze

  # POST and the final submission PATCH must never be retried automatically.
  # An ambiguous response requires a new plan/readback, not a second write.
  class Client < BoardseshASC::Client
    def request_once(method, path, body)
      unless (method == "POST" && %w[/v1/reviewSubmissions /v1/reviewSubmissionItems].include?(path)) || (method == "PATCH" && path.match?(%r{\A/v1/reviewSubmissions/[A-Za-z0-9-]+\z}))
        raise Error, "Unsupported review write"
      end
      uri = URI("#{ORIGIN}#{path}")
      http = @transport.call(uri)
      http.use_ssl = true
      http.open_timeout, http.read_timeout = 30, 120
      request = Net::HTTPGenericRequest.new(method, true, true, uri.request_uri, { "Authorization" => "Bearer #{@token.call}", "Content-Type" => "application/json" })
      request.body = JSON.generate(body)
      response = http.request(request)
      unless response.code.to_i.between?(200, 299)
        raise Error, "Apple review write failed (HTTP #{response.code.to_i}); rerun plan before any further write"
      end
      response.body.to_s.empty? ? {} : JSON.parse(response.body)
    rescue Net::OpenTimeout, Net::ReadTimeout, IOError, SystemCallError, JSON::ParserError => error
      raise Error, "Apple review write outcome is ambiguous (#{error.class}); rerun plan to reconcile, never retry blindly"
    end
  end

  def self.canonical(entry)
    case entry
    when Hash then entry.keys.sort.to_h { |key| [key, canonical(entry.fetch(key))] }
    when Array then entry.map { |child| canonical(child) }
    else entry
    end
  end

  def self.digest(snapshot)
    Digest::SHA256.hexdigest(JSON.generate(canonical(snapshot)))
  end

  class Runner
    def initialize(client:, audit:, manifest:, metadata_root:, selected:, cpp_review_context_version_id: nil)
      @client, @audit, @manifest, @metadata_root = client, audit, manifest, metadata_root
      @selected = selected.sort
      known = ["default"] + manifest.fetch("targets").keys
      raise Error, "Select unique known review surfaces" if @selected.empty? || @selected.uniq != @selected || (@selected - known).any?
      @cpp_context_id = cpp_review_context_version_id.to_s
      unless @cpp_context_id.empty?
        raise Error, "An explicit CPP review context is only allowed for CPP-only submissions" if @selected.include?("default")
        raise Error, "Invalid CPP review context version ID" unless resource_id?(@cpp_context_id)
      end
    end

    def run(action:, expected_sha256: nil)
      raise Error, "Review action must be plan or submit" unless %w[plan submit].include?(action)
      if action == "submit" && !expected_sha256.to_s.match?(/\A[0-9a-f]{64}\z/)
        raise Error, "Submission requires the reviewed snapshot SHA-256"
      end
      snapshot, states = read_snapshot
      digest = BoardseshStoreReview.digest(snapshot)
      result = { "action" => action, "snapshotSha256" => digest, "snapshot" => snapshot, "states" => states }
      return result if action == "plan"
      raise Error, "Remote review content differs from the reviewed snapshot" unless digest == expected_sha256
      desired = snapshot.fetch("surfaces").map { |surface| surface.fetch("item") }
      pending = desired.select { |item| EDITABLE.include?(states.fetch(item_key(item))) }
      submitted = desired - pending
      raise Error, "Selected surfaces mix submitted and unsubmitted items; select each exact group separately" if pending.any? && submitted.any?
      submissions = review_submissions(snapshot.fetch("appId"))
      if pending.empty?
        candidates = submissions.select { |entry| REVIEW_ACTIVE.include?(entry.fetch("state")) && entry.fetch("items") == desired.sort_by { |item| item_key(item) } }
        raise Error, "No unique existing review submission matches these exact surfaces" unless candidates.length == 1
        assert_snapshot(expected_sha256)
        verify_current_bindings(snapshot, submitted: true)
        verify_submission(candidates.first.fetch("id"), desired, snapshot.fetch("appId"), review_context_id(snapshot), REVIEW_ACTIVE)
        return result.merge("action" => "already-submitted", "reviewSubmissionId" => candidates.first.fetch("id"))
      end
      overlapping = submissions.select { |entry| (entry.fetch("items") & desired).any? }
      raise Error, "Selected items belong to an incompatible review submission" if overlapping.any? { |entry| entry.fetch("state") != "READY_FOR_REVIEW" || (entry.fetch("items") - desired).any? }
      candidates = overlapping.select { |entry| entry.fetch("state") == "READY_FOR_REVIEW" }
      raise Error, "Multiple review drafts contain selected items" if candidates.length > 1
      if candidates.empty? && submissions.any? { |entry| entry.fetch("state") == "READY_FOR_REVIEW" && entry.fetch("items").empty? }
        raise Error, "An unowned empty review draft exists; inspect it before creating another"
      end
      submission = candidates.first
      if submission
        review_items(submission.fetch("id"))
        verify_context(submission.fetch("id"), review_context_id(snapshot))
      end
      unless submission
        resource = create("reviewSubmissions", { "platform" => "IOS" }, { "app" => linkage("apps", snapshot.fetch("appId")) })
        submission = { "id" => resource.fetch("id"), "items" => [], "state" => resource.dig("attributes", "state") }
      end
      (desired - submission.fetch("items")).each do |item|
        assert_snapshot(expected_sha256, editable: true)
        create("reviewSubmissionItems", {}, {
          "reviewSubmission" => linkage("reviewSubmissions", submission.fetch("id")),
          item.fetch("relationship") => linkage(item.fetch("type"), item.fetch("id"))
        })
      end
      # These are the final reads before the only irreversible write. No listing,
      # keyword, visibility, rollout, or asset endpoint is ever mutated.
      assert_snapshot(expected_sha256, editable: true)
      verify_current_bindings(snapshot, submitted: false)
      verify_submission(submission.fetch("id"), desired, snapshot.fetch("appId"), review_context_id(snapshot), ["READY_FOR_REVIEW"])
      @client.request_once("PATCH", "/v1/reviewSubmissions/#{submission.fetch('id')}", {
        "data" => { "type" => "reviewSubmissions", "id" => submission.fetch("id"), "attributes" => { "submitted" => true } }
      })
      final = @client.request("GET", "/v1/reviewSubmissions/#{submission.fetch('id')}?include=app,appStoreVersionForReview").fetch("data")
      raise Error, "Submission write returned but review state is not confirmed; rerun plan" unless REVIEW_ACTIVE.include?(final.dig("attributes", "state"))
      assert_snapshot(expected_sha256)
      verify_current_bindings(snapshot, submitted: true)
      verify_submission(submission.fetch("id"), desired, snapshot.fetch("appId"), review_context_id(snapshot), REVIEW_ACTIVE)
      result.merge("action" => "submitted", "reviewSubmissionId" => submission.fetch("id"), "reviewState" => final.dig("attributes", "state"))
    end

    private

    def read_snapshot
      report = @audit.call
      raise Error, report.fetch("identityErrors").join("; ") unless report.fetch("identityErrors").empty?
      version, build = report.fetch("version"), report.fetch("build")
      raise Error, "Attached release build is not valid" unless build["processingState"] == "VALID" && build["expired"] == false
      snapshot = {
        "schemaVersion" => 1, "appId" => report.fetch("appId"),
        "version" => version.reject { |key, _entry| %w[appStoreState appVersionState].include?(key) },
        "build" => build.reject { |key, _entry| key == "uploadedDate" }, "surfaces" => []
      }
      snapshot["cppReviewContext"] = read_cpp_review_context(snapshot.fetch("appId")) unless @cpp_context_id.empty?
      states = {}
      @selected.each do |target|
        if target == "default"
          raise Error, "App release must already be set to MANUAL; no rollout settings were changed" unless version["releaseType"] == "MANUAL"
          state = version["appVersionState"] || version["appStoreState"]
          item = { "relationship" => "appStoreVersion", "type" => "appStoreVersions", "id" => version.fetch("id") }
          surface = { "target" => target, "item" => item, "localizations" => normalized_localizations(report.fetch("localizations"), target, DEFAULT_COUNTS) }
        else
          page = report.fetch("customProductPages").find { |entry| entry.fetch("target") == target }
          raise Error, "Selected CPP #{target} is missing" unless page && page["id"]
          versions = page.fetch("versions")
          raise Error, "Selected CPP #{target} has no current version" if versions.empty?
          numbers = versions.map { |entry| entry.fetch("version") }
          raise Error, "CPP version numbering is invalid or ambiguous" unless numbers.all? { |number| number.to_s.match?(/\A\d+(?:\.\d+)*\z/) } && numbers.uniq.length == numbers.length
          current = versions.max_by { |entry| entry.fetch("version").split(".").map(&:to_i) }
          remote_page = @client.request("GET", "/v1/appCustomProductPages/#{page.fetch('id')}?include=app").fetch("data")
          raise Error, "CPP app ownership changed" unless remote_page.dig("relationships", "app", "data") == { "type" => "apps", "id" => report.fetch("appId") }
          remote_version = @client.request("GET", "/v1/appCustomProductPageVersions/#{current.fetch('id')}?include=appCustomProductPage").fetch("data")
          raise Error, "CPP version parent changed" unless remote_version.dig("relationships", "appCustomProductPage", "data") == { "type" => "appCustomProductPages", "id" => page.fetch("id") }
          raise Error, "CPP version changed during readback" unless remote_version.dig("attributes", "version") == current.fetch("version") && remote_version.dig("attributes", "state") == current.fetch("state")
          raise Error, "CPP visibility changed during readback" unless [true, false].include?(page["visible"]) && remote_page.dig("attributes", "visible") == page.fetch("visible")
          state = current.fetch("state")
          item = { "relationship" => "appCustomProductPageVersion", "type" => "appCustomProductPageVersions", "id" => current.fetch("id") }
          surface = {
            "target" => target, "item" => item, "pageId" => page.fetch("id"), "referenceName" => remote_page.dig("attributes", "name"),
            "visible" => page.fetch("visible"), "version" => current.fetch("version"), "deepLink" => remote_version.dig("attributes", "deepLink"),
            "localizations" => normalized_localizations(current.fetch("localizations"), target, DEFAULT_COUNTS.transform_values { 9 })
          }
        end
        if REQUIRES_RESOLUTION.include?(state)
          raise Error, "Selected surface #{target} requires rejection resolution in App Store Connect; this helper only submits initial or ready drafts"
        end
        raise Error, "Selected surface #{target} is not editable or submitted (#{state})" unless (EDITABLE + SUBMITTED).include?(state)
        states[item_key(item)] = state
        snapshot.fetch("surfaces") << surface
      end
      [snapshot, states]
    end

    def normalized_localizations(localizations, target, counts)
      expected_locales = @manifest.fetch("locales").values.flatten.sort
      raise Error, "#{target}: locales must exactly match the release manifest" unless localizations.map { |entry| entry.fetch("locale") }.sort == expected_locales
      localizations.sort_by { |entry| entry.fetch("locale") }.map do |localization|
        locale = localization.fetch("locale")
        metadata = localization.fetch("metadata")
        if target == "default"
          METADATA_FILES.each do |field, filename|
            wanted = File.read(File.join(@metadata_root, locale, filename)).strip
            raise Error, "#{target}/#{locale}: #{field} differs from committed metadata" unless metadata.dig(field, "text").to_s.strip == wanted
          end
        else
          app_locale = @manifest.fetch("locales").find { |_language, locales| locales.include?(locale) }.first
          wanted = @manifest.fetch("targets").fetch(target).fetch("localizations").fetch(app_locale).fetch("promotionalText")
          raise Error, "#{target}/#{locale}: promotional text differs from committed metadata" unless metadata.dig("promotionalText", "text") == wanted
        end
        sets = localization.fetch("screenshotSets")
        raise Error, "#{target}/#{locale}: screenshot devices are incomplete or duplicated" unless sets.map { |set| set.fetch("displayType") }.sort == counts.keys.sort
        normalized_sets = sets.sort_by { |set| set.fetch("displayType") }.map do |set|
          screenshots = set.fetch("screenshots")
          raise Error, "#{target}/#{locale}: wrong screenshot count" unless screenshots.length == counts.fetch(set.fetch("displayType")) && set.fetch("count") == screenshots.length
          raise Error, "#{target}/#{locale}: screenshot identity/order is ambiguous" unless screenshots.map { |image| image.fetch("position") } == (1..screenshots.length).to_a && screenshots.map { |image| image.fetch("id") }.uniq.length == screenshots.length && screenshots.map { |image| image.fetch("fileName") }.uniq.length == screenshots.length
          images = screenshots.map do |image|
            unless image["processingState"] == "COMPLETE" && image["sourceFileChecksum"].to_s.match?(/\A[0-9a-f]{32}\z/i) && image["fileSize"].is_a?(Integer) && image["fileSize"] > 0 && image["fileName"].is_a?(String) && !image["fileName"].empty?
              raise Error, "#{target}/#{locale}: screenshot is incomplete or lacks a valid source checksum"
            end
            dimensions = image.fetch("imageAsset").slice("width", "height")
            unless BoardseshCPP::Runner::DISPLAY_DIMENSIONS.fetch(set.fetch("displayType")).include?([dimensions["width"], dimensions["height"]])
              raise Error, "#{target}/#{locale}: screenshot dimensions do not match the device slot"
            end
            image.reject { |key, _entry| key == "imageAsset" }.merge("dimensions" => dimensions)
          end
          set.merge("screenshots" => images)
        end
        normalized = localization.merge("screenshotSets" => normalized_sets)
        if target != "default"
          keywords = @client.list("/v1/appCustomProductPageLocalizations/#{localization.fetch('id')}/searchKeywords?limit=200")
          normalized["keywordIds"] = keywords.map { |keyword| keyword.fetch("id") }.sort
          raise Error, "CPP keyword membership is duplicated" unless normalized["keywordIds"].uniq == normalized["keywordIds"]
        end
        normalized
      end
    end

    def assert_snapshot(expected_sha256, editable: false)
      snapshot, states = read_snapshot
      raise Error, "Remote review snapshot changed; no review submitted" unless BoardseshStoreReview.digest(snapshot) == expected_sha256
      raise Error, "A selected surface is no longer editable" if editable && states.values.any? { |state| !EDITABLE.include?(state) }
      [snapshot, states]
    end

    def item_key(item)
      "#{item.fetch('type')}:#{item.fetch('id')}"
    end

    def review_items(id, strict: true)
      @client.list("/v1/reviewSubmissions/#{id}/items?include=appStoreVersion,appCustomProductPageVersion&limit=200").flat_map do |item|
        raise Error, "Review draft contains removed/rejected items" if strict && !%w[READY_FOR_REVIEW ACCEPTED APPROVED].include?(item.dig("attributes", "state"))
        relationships = item.fetch("relationships").select { |_name, relationship| !relationship["data"].nil? }
        unless strict
          next relationships.map do |relationship, binding|
            linked = binding["data"].is_a?(Hash) ? binding.fetch("data") : {}
            { "relationship" => relationship, "type" => linked["type"].to_s, "id" => linked["id"].to_s }
          end
        end
        raise Error, "Review submission contains unknown or mixed item types" unless relationships.length == 1 && %w[appStoreVersion appCustomProductPageVersion].include?(relationships.keys.first)
        relationship, binding = relationships.first
        expected_type = relationship == "appStoreVersion" ? "appStoreVersions" : "appCustomProductPageVersions"
        raise Error, "Review item binding is malformed" unless binding.dig("data", "type") == expected_type && binding.dig("data", "id").is_a?(String)
        [{ "relationship" => relationship, "type" => expected_type, "id" => binding.fetch("data").fetch("id") }]
      end.sort_by { |item| item_key(item) }.tap do |items|
        raise Error, "Review submission contains duplicate items" if strict && items.uniq != items
      end
    end

    def review_submissions(app_id)
      @client.list("/v1/apps/#{app_id}/reviewSubmissions?filter[platform]=IOS&limit=200")
        .select { |entry| entry.dig("attributes", "platform") == "IOS" }
        .map { |entry| { "id" => entry.fetch("id"), "state" => entry.dig("attributes", "state"), "items" => review_items(entry.fetch("id"), strict: false) } }
    end

    def verify_context(id, version_id)
      submission = @client.request("GET", "/v1/reviewSubmissions/#{id}?include=app,appStoreVersionForReview").fetch("data")
      unless submission.dig("relationships", "appStoreVersionForReview", "data") == { "type" => "appStoreVersions", "id" => version_id }
        raise Error, "Review submission is associated with a different or unknown app version"
      end
      submission
    end

    def resource_id?(id)
      id.is_a?(String) && id.match?(/\A[A-Za-z0-9-]{1,128}\z/)
    end

    def review_context_id(snapshot)
      snapshot.dig("cppReviewContext", "version", "id") || snapshot.fetch("version").fetch("id")
    end

    def context_state(version)
      attributes = version.fetch("attributes")
      normalize = ->(state) { state == "READY_FOR_SALE" ? "READY_FOR_DISTRIBUTION" : state }
      modern, legacy = attributes["appVersionState"], attributes["appStoreState"]
      if modern && legacy && normalize.call(modern) != normalize.call(legacy)
        raise Error, "CPP review context has conflicting app version states"
      end
      state = normalize.call(modern || legacy)
      raise Error, "CPP review context has no app version state" unless state.is_a?(String) && !state.empty?
      state
    end

    # Apple chooses the latest approved iOS version for an items-only review.
    # Pin that separate context explicitly; never replace the release/build or
    # screenshot bindings in the main snapshot with an older approved binary.
    def read_cpp_review_context(app_id)
      versions = @client.list("/v1/apps/#{app_id}/appStoreVersions?filter[platform]=IOS&limit=200")
      ids = versions.map { |version| version["id"] }
      unless ids.all? { |id| resource_id?(id) } && ids.uniq == ids
        raise Error, "CPP review context version inventory is ambiguous"
      end
      dated = versions.map do |version|
        unless version["type"] == "appStoreVersions" && version.dig("attributes", "platform") == "IOS"
          raise Error, "CPP review context inventory contains a different resource or platform"
        end
        begin
          created = Time.iso8601(version.fetch("attributes").fetch("createdDate"))
        rescue ArgumentError, TypeError, KeyError
          raise Error, "CPP review context version creation date is missing or invalid"
        end
        [version, created, context_state(version)]
      end
      approved = dated.select { |_version, _created, state| CPP_CONTEXT_APPROVED.include?(state) }
      raise Error, "CPP review context has no supported approved iOS version" if approved.empty?
      latest_date = approved.map { |_version, created, _state| created }.max
      latest = approved.select { |_version, created, _state| created == latest_date }
      unless latest.length == 1 && latest.first.first.fetch("id") == @cpp_context_id
        raise Error, "Explicit CPP review context is not the unique latest approved iOS version"
      end
      if dated.any? { |_version, created, state| created >= latest_date && !(CPP_CONTEXT_APPROVED + CPP_CONTEXT_NOT_APPROVED).include?(state) }
        raise Error, "A newer iOS version has an unresolved approval state; inspect the CPP review context"
      end
      selected = latest.first.first
      version = @client.request("GET", "/v1/appStoreVersions/#{@cpp_context_id}?include=app,build").fetch("data")
      fields = %w[versionString platform appStoreState appVersionState createdDate]
      unless version.is_a?(Hash) && version["type"] == "appStoreVersions" && version["id"] == @cpp_context_id &&
          version.dig("relationships", "app", "data") == { "type" => "apps", "id" => app_id } &&
          version.fetch("attributes").slice(*fields) == selected.fetch("attributes").slice(*fields)
        raise Error, "CPP review context app/version binding changed"
      end
      attributes = version.fetch("attributes")
      unless attributes["versionString"].is_a?(String) && attributes["versionString"].match?(/\A\d+(?:\.\d+){0,2}\z/) && CPP_CONTEXT_APPROVED.include?(context_state(version))
        raise Error, "CPP review context is not an approved iOS app version"
      end
      binding = version.dig("relationships", "build", "data")
      unless binding.is_a?(Hash) && binding["type"] == "builds" && resource_id?(binding["id"])
        raise Error, "CPP review context has no attached build"
      end
      build = @client.request("GET", "/v1/appStoreVersions/#{@cpp_context_id}/build").fetch("data")
      unless build.is_a?(Hash) && build["type"] == "builds" && build["id"] == binding.fetch("id") &&
          build.dig("attributes", "processingState") == "VALID" && build.dig("attributes", "expired") == false &&
          build.dig("attributes", "version").is_a?(String) && build.dig("attributes", "version").match?(/\A[1-9]\d*\z/)
        raise Error, "CPP review context build is missing, changed, expired, or invalid"
      end
      prerelease = @client.request("GET", "/v1/builds/#{build.fetch('id')}/preReleaseVersion").fetch("data")
      unless prerelease.is_a?(Hash) && prerelease["type"] == "preReleaseVersions" && resource_id?(prerelease["id"]) &&
          prerelease.dig("attributes", "version") == attributes.fetch("versionString") && prerelease.dig("attributes", "platform") == "IOS"
        raise Error, "CPP review context build belongs to a different prerelease version"
      end
      {
        "version" => { "id" => version.fetch("id") }.merge(attributes.slice(*fields)),
        "build" => { "id" => build.fetch("id") }.merge(build.fetch("attributes").slice("version", "processingState", "expired", "minOsVersion"))
          .merge("preReleaseVersion" => { "id" => prerelease.fetch("id") }.merge(prerelease.fetch("attributes").slice("version", "platform")))
      }
    end

    def verify_submission(id, desired, app_id, version_id, allowed_states)
      raise Error, "Review draft membership changed" unless review_items(id) == desired.sort_by { |item| item_key(item) }
      submission = verify_context(id, version_id)
      unless submission.dig("attributes", "platform") == "IOS" && allowed_states.include?(submission.dig("attributes", "state")) && submission.dig("relationships", "app", "data") == { "type" => "apps", "id" => app_id }
        raise Error, "Review draft binding or state changed"
      end
    end

    # The full asset scan takes many requests. Re-resolve the release's build and
    # each selected page's highest current version after it, so an old version
    # that still exists cannot be submitted after its destination has moved on.
    def verify_current_bindings(snapshot, submitted:)
      version = snapshot.fetch("version")
      remote = @client.request("GET", "/v1/appStoreVersions/#{version.fetch('id')}?include=app,build").fetch("data")
      unless remote.dig("relationships", "app", "data") == { "type" => "apps", "id" => snapshot.fetch("appId") } &&
          remote.dig("relationships", "build", "data") == { "type" => "builds", "id" => snapshot.fetch("build").fetch("id") } &&
          remote.fetch("attributes").slice(*version.keys.reject { |key| key == "id" }) == version.reject { |key, _entry| key == "id" }
        raise Error, "Current release/build binding or release settings changed"
      end
      allowed_states = submitted ? SUBMITTED : EDITABLE
      snapshot.fetch("surfaces").each do |surface|
        if surface.fetch("target") == "default"
          state = remote.dig("attributes", "appVersionState") || remote.dig("attributes", "appStoreState")
          raise Error, "Current app review state changed" unless allowed_states.include?(state)
          next
        end
        page = @client.request("GET", "/v1/appCustomProductPages/#{surface.fetch('pageId')}?include=app").fetch("data")
        unless page.dig("relationships", "app", "data") == { "type" => "apps", "id" => snapshot.fetch("appId") } && page.dig("attributes", "name") == surface.fetch("referenceName") && page.dig("attributes", "visible") == surface.fetch("visible")
          raise Error, "Current CPP page binding changed"
        end
        versions = @client.list("/v1/appCustomProductPages/#{surface.fetch('pageId')}/appCustomProductPageVersions?limit=200")
          .reject { |entry| entry.dig("attributes", "state") == "REPLACED_WITH_NEW_VERSION" }
        numbers = versions.map { |entry| entry.dig("attributes", "version") }
        raise Error, "Current CPP version identity is ambiguous" unless numbers.any? && numbers.all? { |number| number.to_s.match?(/\A\d+(?:\.\d+)*\z/) } && numbers.uniq.length == numbers.length
        current = versions.max_by { |entry| entry.dig("attributes", "version").split(".").map(&:to_i) }
        unless current.fetch("id") == surface.fetch("item").fetch("id") && current.dig("attributes", "version") == surface.fetch("version") && allowed_states.include?(current.dig("attributes", "state"))
          raise Error, "Current CPP version or review state changed"
        end
      end
      if snapshot["cppReviewContext"] && read_cpp_review_context(snapshot.fetch("appId")) != snapshot.fetch("cppReviewContext")
        raise Error, "Current approved CPP review context or build changed"
      end
    end

    def linkage(type, id)
      { "data" => { "type" => type, "id" => id } }
    end

    def create(type, attributes, relationships)
      payload = { "type" => type, "relationships" => relationships }
      payload["attributes"] = attributes unless attributes.empty?
      @client.request_once("POST", "/v1/#{type}", { "data" => payload }).fetch("data")
    end
  end
end
