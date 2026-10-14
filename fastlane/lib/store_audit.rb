# frozen_string_literal: true

require "digest"
require "json"
require "time"
require_relative "asc_client"

# Inspect store state independently of upload receipts. Retain public listing
# fields and review resource identities/states, never actors, contact details,
# credentials, or signed upload operations. All Apple requests are GET-only.
module BoardseshStoreAudit
  class Error < StandardError; end

  def self.text_fields(attributes, fields)
    fields.to_h do |field|
      text = attributes[field]
      [field, { "text" => text, "sha256" => text.nil? ? nil : Digest::SHA256.hexdigest(text) }]
    end
  end

  def self.write_report(path, report)
    File.write(path, JSON.pretty_generate(report) + "\n")
    errors = report.fetch("identityErrors")
    raise Error, errors.join("; ") unless errors.empty?
  end

  class Apple
    LOCALIZED_FIELDS = %w[description keywords marketingUrl promotionalText supportUrl whatsNew].freeze
    REVIEW_ITEM_TYPES = {
      "appStoreVersion" => "appStoreVersions", "appCustomProductPageVersion" => "appCustomProductPageVersions",
      "appStoreVersionExperiment" => "appStoreVersionExperiments", "appStoreVersionExperimentV2" => "appStoreVersionExperiments",
      "appEvent" => "appEvents", "appAssetLibraryImage" => "appAssetLibraryImages", "appAssetLibraryVideo" => "appAssetLibraryVideos",
      "backgroundAssetVersion" => "backgroundAssetVersions", "gameCenterAchievementVersion" => "gameCenterAchievementVersions",
      "gameCenterActivityVersion" => "gameCenterActivityVersions", "gameCenterChallengeVersion" => "gameCenterChallengeVersions",
      "gameCenterLeaderboardSetVersion" => "gameCenterLeaderboardSetVersions", "gameCenterLeaderboardVersion" => "gameCenterLeaderboardVersions",
      "inAppPurchaseVersion" => "inAppPurchaseVersions", "subscriptionVersion" => "subscriptionVersions",
      "subscriptionGroupVersion" => "subscriptionGroupVersions"
    }.freeze

    def initialize(client:, app_id:, version:, build_number:, cpp_targets:, locales:, display_types:)
      raise Error, "Expected iOS version must be semver" unless version.match?(/\A\d+\.\d+\.\d+\z/)
      raise Error, "Expected iOS build must be numeric" unless build_number.match?(/\A[1-9]\d*\z/)
      @client, @app_id, @version, @build_number = client, app_id, version, build_number
      @cpp_targets, @locales, @display_types = cpp_targets, locales, display_types
      @issues = []
    end

    def run
      report = {
        "platform" => "ios", "auditedAt" => Time.now.utc.iso8601,
        "appId" => @app_id, "expectedVersion" => @version, "expectedBuild" => @build_number,
        "identityErrors" => [], "readinessIssues" => @issues
      }
      versions = @client.list("/v1/apps/#{@app_id}/appStoreVersions?filter[platform]=IOS&filter[versionString]=#{@version}&limit=200")
      matches = versions.select { |version| version.dig("attributes", "versionString") == @version && version.dig("attributes", "platform") == "IOS" }
      unless matches.length == 1
        report["identityErrors"] << "Expected exactly one iOS #{@version} store version; found #{matches.length}"
        return report
      end
      version = matches.first
      attributes = version.fetch("attributes")
      build = @client.request("GET", "/v1/appStoreVersions/#{version.fetch('id')}/build").fetch("data")
      report["version"] = { "id" => version.fetch("id") }.merge(attributes.slice("versionString", "platform", "appStoreState", "appVersionState", "releaseType", "earliestReleaseDate"))
      report["build"] = build && { "id" => build.fetch("id") }.merge(build.fetch("attributes").slice("version", "processingState", "uploadedDate", "expired", "minOsVersion"))
      if build.nil? || build.dig("attributes", "version") != @build_number
        report["identityErrors"] << "iOS #{@version} does not have expected build #{@build_number} attached"
      else
        prerelease = @client.request("GET", "/v1/builds/#{build.fetch('id')}/preReleaseVersion").fetch("data")
        report["build"]["preReleaseVersion"] = prerelease && prerelease.fetch("attributes").slice("version", "platform")
        unless prerelease && prerelease.dig("attributes", "version") == @version && prerelease.dig("attributes", "platform") == "IOS"
          report["identityErrors"] << "Attached iOS build belongs to a different prerelease version"
        end
        @issues << "Attached iOS build is not fully processed" unless build.dig("attributes", "processingState") == "VALID"
        @issues << "Attached iOS build is expired" if build.dig("attributes", "expired")
      end
      report["localizations"] = localizations("appStoreVersions", version.fetch("id"), "appStoreVersionLocalizations", "default")
      report["customProductPages"] = custom_product_pages
      report["reviewSubmissions"] = review_submissions
      report
    end

    private

    def review_id(resource, expected_type)
      unless resource.is_a?(Hash) && resource["type"] == expected_type && resource["id"].is_a?(String) && resource["id"].match?(/\A[A-Za-z0-9-]{1,128}\z/)
        raise Error, "Malformed Apple review resource identity"
      end
      resource.fetch("id")
    end

    def review_link(resource, name, expected_type, nullable: false)
      relationship = resource.fetch("relationships", {})[name]
      raise Error, "Missing Apple review resource linkage" unless relationship.is_a?(Hash) && relationship.key?("data")
      binding = relationship.fetch("data")
      return nil if nullable && binding.nil?
      { "type" => expected_type, "id" => review_id(binding, expected_type) }
    end

    def review_state(resource)
      state = resource.fetch("attributes")["state"]
      raise Error, "Malformed Apple review state" unless state.is_a?(String) && state.match?(/\A[A-Z_]{1,64}\z/)
      state
    end

    # Preserve historical and unresolved membership as evidence. In particular,
    # appStoreVersionForReview is context, not proof an app version is an item.
    # Empty/mixed item bindings remain explicitly ambiguous; no capacity claim is
    # inferred from this inventory. Both collections use the paginating client.
    def review_submissions
      submissions = @client.list("/v1/apps/#{@app_id}/reviewSubmissions?filter[platform]=IOS&include=app,appStoreVersionForReview&limit=200")
      submission_ids, item_ids = [], []
      submissions.map do |submission|
        submission_id = review_id(submission, "reviewSubmissions")
        raise Error, "Duplicate Apple review submission identity" if submission_ids.include?(submission_id)
        submission_ids << submission_id
        attributes = submission.fetch("attributes")
        app = review_link(submission, "app", "apps")
        raise Error, "Apple review submission app or platform mismatch" unless app["id"] == @app_id && attributes["platform"] == "IOS"
        context = review_link(submission, "appStoreVersionForReview", "appStoreVersions", nullable: true)
        # Apple omits linkage without include and rejects expanding every type.
        # Use the same proven expansion as review submission. Other item kinds
        # remain visible by ID/state and explicitly unresolved without linkage.
        items = @client.list("/v1/reviewSubmissions/#{submission_id}/items?include=appStoreVersion,appCustomProductPageVersion&limit=200").map do |item|
          item_id = review_id(item, "reviewSubmissionItems")
          raise Error, "Duplicate Apple review item identity" if item_ids.include?(item_id)
          item_ids << item_id
          relationships = item.fetch("relationships", {})
          raise Error, "Unknown Apple review item relationship" unless relationships.is_a?(Hash) && (relationships.keys - REVIEW_ITEM_TYPES.keys).empty?
          resources = relationships.filter_map do |name, _relationship|
            binding = review_link(item, name, REVIEW_ITEM_TYPES.fetch(name), nullable: true)
            binding && binding.merge("relationship" => name)
          end
          { "id" => item_id, "state" => review_state(item), "resources" => resources,
            "bindingAmbiguous" => resources.length != 1 }
        end
        bindings = items.flat_map { |item| item.fetch("resources").map { |resource| resource.slice("type", "id") } }
        raise Error, "Duplicate Apple review resource membership" unless bindings.uniq == bindings
        { "id" => submission_id, "platform" => attributes["platform"], "state" => review_state(submission),
          "app" => app, "appStoreVersionForReview" => context, "items" => items,
          "membershipAmbiguous" => items.empty? || items.any? { |item| item.fetch("bindingAmbiguous") } }
      end
    end

    def custom_product_pages
      pages = @client.list("/v1/apps/#{@app_id}/appCustomProductPages?limit=200")
      @cpp_targets.map do |target, config|
        reference_name = config.fetch("referenceName")
        matches = pages.select { |page| page.dig("attributes", "name") == reference_name }
        unless matches.length == 1
          @issues << "CPP #{target}: expected one page, found #{matches.length}"
          next { "target" => target, "referenceName" => reference_name, "versions" => [] }
        end
        page = matches.first
        versions = @client.list("/v1/appCustomProductPages/#{page.fetch('id')}/appCustomProductPageVersions?limit=200")
          .reject { |version| version.dig("attributes", "state") == "REPLACED_WITH_NEW_VERSION" }
        @issues << "CPP #{target}: no current version" if versions.empty?
        {
          "target" => target, "id" => page.fetch("id"), "referenceName" => reference_name,
          "visible" => page.dig("attributes", "visible"), "url" => page.dig("attributes", "url"),
          "versions" => versions.map do |version|
            {
              "id" => version.fetch("id"), "version" => version.dig("attributes", "version"), "state" => version.dig("attributes", "state"),
              "localizations" => localizations("appCustomProductPageVersions", version.fetch("id"), "appCustomProductPageLocalizations", "CPP #{target}/#{version.fetch('id')}")
            }
          end
        }
      end
    end

    def localizations(parent_type, parent_id, localization_type, label)
      entries = @client.list("/v1/#{parent_type}/#{parent_id}/#{localization_type}?limit=200")
      found_locales = entries.map { |entry| entry.dig("attributes", "locale") }
      (@locales - found_locales).each { |locale| @issues << "#{label}: missing locale #{locale}" }
      entries.map do |localization|
        locale = localization.fetch("attributes").fetch("locale")
        sets = @client.list("/v1/#{localization_type}/#{localization.fetch('id')}/appScreenshotSets?limit=200")
        found_types = sets.map { |set| set.dig("attributes", "screenshotDisplayType") }
        (@display_types - found_types).each { |type| @issues << "#{label}/#{locale}: missing screenshot set #{type}" }
        {
          "id" => localization.fetch("id"), "locale" => locale,
          "metadata" => BoardseshStoreAudit.text_fields(localization.fetch("attributes"), LOCALIZED_FIELDS),
          "screenshotSets" => sets.map { |set| screenshot_set(set, "#{label}/#{locale}") }
        }
      end
    end

    def screenshot_set(set, label)
      display_type = set.fetch("attributes").fetch("screenshotDisplayType")
      images = @client.list("/v1/appScreenshotSets/#{set.fetch('id')}/appScreenshots?limit=200")
      # Read the ordered relationship explicitly, rather than trusting the order
      # an API resource collection happens to return.
      order = @client.list("/v1/appScreenshotSets/#{set.fetch('id')}/relationships/appScreenshots?limit=200").map { |image| image.fetch("id") }
      indexed = images.to_h { |image| [image.fetch("id"), image] }
      raise Error, "Screenshot set changed while reading; repeat the audit" unless order.uniq.length == order.length && order.sort == indexed.keys.sort && indexed.length == images.length
      @issues << "#{label}/#{display_type}: empty screenshot set" if order.empty?
      {
        "id" => set.fetch("id"), "displayType" => display_type, "count" => order.length,
        "screenshots" => order.each_with_index.map do |id, index|
          attributes = indexed.fetch(id).fetch("attributes")
          state = attributes.dig("assetDeliveryState", "state")
          @issues << "#{label}/#{display_type}/#{index + 1}: screenshot is not COMPLETE" unless state == "COMPLETE"
          @issues << "#{label}/#{display_type}/#{index + 1}: missing source checksum" if attributes["sourceFileChecksum"].to_s.empty?
          {
            "id" => id, "position" => index + 1, "fileName" => attributes["fileName"],
            "fileSize" => attributes["fileSize"], "sourceFileChecksum" => attributes["sourceFileChecksum"],
            "processingState" => state,
            "imageAsset" => attributes["imageAsset"]&.slice("templateUrl", "width", "height")
          }
        end
      }
    end
  end

end
