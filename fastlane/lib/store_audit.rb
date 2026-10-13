# frozen_string_literal: true

require "digest"
require "json"
require "time"
require_relative "asc_client"

# Inspect the committed store state independently of upload receipts. Only public
# listing fields are retained: never review contact details, credentials, or upload
# operations (which can contain signed URLs). All Apple requests are GET-only.
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
      report
    end

    private

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
