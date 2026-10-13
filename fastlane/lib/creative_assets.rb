# frozen_string_literal: true

require "digest"
require "json"
require "open3"
require "time"
require_relative "asc_client"

# Request shapes follow Apple's 2026-10-07 OpenAPI. Placement IDs and groups
# come from refdata, never from a fastlane enum or an assumed device class.
module BoardseshCreatives
  Error = BoardseshASC::Error
  PLACEMENTS = { "header" => "PRODUCT_PAGE_HEADER_ASSET", "search-results" => "APP_STORE_SEARCH_RESULTS_ASSET" }.freeze
  PLACEABLE = %w[PREPARE_FOR_SUBMISSION READY_FOR_REVIEW WAITING_FOR_REVIEW IN_REVIEW ACCEPTED APPROVED].freeze
  UPLOADED = (%w[UPLOAD_COMPLETE COMPLETE] + PLACEABLE).freeze
  EDITABLE = %w[PREPARE_FOR_SUBMISSION READY_FOR_REVIEW REJECTED].freeze
  LIVE = %w[READY_FOR_SALE READY_FOR_DISTRIBUTION].freeze

  class Runner
    def initialize(client:, repo_root:, manifest:, app_id:, cpp_manifest:, probe: nil)
      @client, @root, @manifest, @app_id, @cpp = client, File.realpath(repo_root), manifest, app_id, cpp_manifest
      @probe = probe || ->(path) do
        output, status = Open3.capture2("ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", path)
        raise Error, "ffprobe failed for creative video" unless status.success?
        JSON.parse(output)
      end
    end

    def run(action: "plan", variant: "all", allow_live: false, allow_replace: false)
      raise Error, "Creative action must be refdata, plan, upload, or place" unless %w[refdata plan upload place].include?(action)
      refdata = @client.list("/v1/appAssetLibraryRefData")
      return refdata if action == "refdata"
      selected = variant == "all" ? @manifest.fetch("variants").keys : [variant]
      raise Error, "Unknown creative variant" unless selected.all? { |name| @manifest.fetch("variants").key?(name) }
      placement_types = refdata.flat_map { |datum| datum.dig("attributes", "placementTypes") || [] }
      PLACEMENTS.each_value do |placement_type|
        raise Error, "Apple refdata does not advertise #{placement_type}; no writes performed" unless placement_types.any? { |entry| entry["placementTypeId"] == placement_type }
      end
      entries = selected.flat_map { |name| local_assets(name, placement_types) }
      return [{ "action" => "pending", "variants" => selected, "diagnostics" => ["Generate and review fresh assets for every locale, then finalize creative-assets.json"] }] if action == "plan" && entries.empty?
      raise Error, "No finalized creative assets; generate the locale matrix first" if entries.empty?
      pending = selected.select { |name| @manifest.fetch("variants").fetch(name).fetch("assets").empty? }
      raise Error, "Unfinalized creative variants: #{pending.join(', ')}" unless pending.empty?
      library = @client.request("GET", "/v1/apps/#{@app_id}/assetLibrary").fetch("data")
      raise Error, "Unexpected asset library identity" unless library.fetch("type") == "appAssetLibraries"
      library_id = library.fetch("id")
      remote_assets = %w[images videos].flat_map { |kind| @client.list("/v1/appAssetLibraries/#{library_id}/#{kind}?filter[category]=CREATIVE_ASSETS&limit=200") }
      remote_placements = action == "upload" ? [] : remote_assets.flat_map do |remote|
        @client.list("/v1/#{remote.fetch('type')}/#{remote.fetch('id')}/placements?limit=200")
      end.uniq { |placement| placement.fetch("id") }
      destinations = {}
      # Resolve all bindings/conflicts before the first reserve or placement write.
      plans = entries.map do |entry|
        matches = remote_assets.select { |asset| asset.dig("attributes", "fileName") == entry.fetch("fileName") }
        raise Error, "Duplicate creative asset filename; resolve in Asset Library" if matches.length > 1
        asset = matches.first
        if action == "upload" && asset && !UPLOADED.include?(asset.dig("attributes", "state")) && asset.dig("attributes", "state") != "AWAITING_UPLOAD"
          raise Error, "Existing creative asset is #{asset.dig('attributes', 'state')}; inspect Asset Library before any upload"
        end
        if asset && (asset.fetch("type") != entry.fetch("type") || asset.dig("attributes", "category") != "CREATIVE_ASSETS" || asset.dig("attributes", "fileSize") != File.size(entry.fetch("path")))
          raise Error, "Remote creative identity differs from finalized manifest"
        end
        next entry.merge("asset" => asset, "unchanged" => !!asset && UPLOADED.include?(asset.dig("attributes", "state"))) if action == "upload"
        if action == "place"
          raise Error, "Upload #{entry.fetch('fileName')} before placing it" unless asset
          state = asset.dig("attributes", "state")
          unless PLACEABLE.include?(state)
            raise Error, "Creative #{entry.fetch('fileName')} is #{state}; Apple processing/review preparation must reach PREPARE_FOR_SUBMISSION or later before placement; no writes performed"
          end
        end
        destination_key = [entry.fetch("variant"), entry.fetch("storeLocale")]
        destination = destinations[destination_key] ||= destination(entry.fetch("variant"), entry.fetch("storeLocale"), allow_live)
        placements = remote_placements.select do |placement|
          placement.dig("attributes", "placementType") == entry.fetch("placementType") &&
            placement.dig("attributes", "placementGroup") == entry.fetch("placementGroup") &&
            placement.dig("relationships", destination.fetch("relationship"), "data", "id") == destination.fetch("id")
        end.uniq { |placement| placement.fetch("id") }
        raise Error, "Multiple placements for one creative slot" if placements.length > 1
        existing = placements.first
        raise Error, "Existing creative placement failed; inspect ASC stateDetails before retrying" if existing && existing.dig("attributes", "state") == "FAILED"
        relation = entry.fetch("type") == "appAssetLibraryImages" ? "image" : "video"
        same = existing && asset && existing.dig("relationships", relation, "data", "id") == asset.fetch("id")
        if action == "place"
          if existing && !same
            previous_link = existing.dig("relationships", "image", "data") || existing.dig("relationships", "video", "data")
            previous = remote_assets.find { |candidate| previous_link && candidate["type"] == previous_link["type"] && candidate["id"] == previous_link["id"] }
            prefix = "#{entry.fetch('variant')}-#{entry.fetch('placement')}-#{entry.fetch('appLocale')}-"
            raise Error, "Refusing to replace an unowned placement" unless previous && previous.dig("attributes", "fileName").to_s.match?(/\A#{Regexp.escape(prefix)}[a-f0-9]{12}\.(png|mp4)\z/)
            raise Error, "Placement replacement deletes one assignment; pass allow_replace:true after approval" unless allow_replace
          end
        end
        entry.merge("asset" => asset, "destination" => destination, "existing" => existing, "unchanged" => !!same)
      end
      uploaded_assets = {}
      plans.map do |plan|
        asset = uploaded_assets[plan.fetch("fileName")] || plan["asset"]
        plan = plan.merge("asset" => asset) if asset
        asset = upload(plan, library_id) if action == "upload" && (!asset || !UPLOADED.include?(asset.dig("attributes", "state")))
        uploaded_assets[plan.fetch("fileName")] = asset if asset
        if action == "place" && !plan.fetch("unchanged")
          @client.request("DELETE", "/v1/appAssetLibraryPlacements/#{plan.fetch('existing').fetch('id')}") if plan["existing"]
          relationship = plan.fetch("type") == "appAssetLibraryImages" ? "image" : "video"
          destination = plan.fetch("destination")
          @client.request("POST", "/v1/appAssetLibraryPlacements", {
            "data" => { "type" => "appAssetLibraryPlacements", "attributes" => { "placementType" => plan.fetch("placementType"), "placementGroup" => plan.fetch("placementGroup") },
                        "relationships" => { relationship => link(plan.fetch("type"), asset.fetch("id")), destination.fetch("relationship") => link(destination.fetch("type"), destination.fetch("id")) } }
          })
        end
        { "variant" => plan.fetch("variant"), "locale" => plan.fetch("storeLocale"), "placement" => plan.fetch("placement"), "placementState" => plan.dig("existing", "attributes", "state"), "fileName" => plan.fetch("fileName"), "sha256" => plan.fetch("sha256"), "action" => plan.fetch("unchanged") ? "unchanged" : action, "assetId" => asset && asset["id"], "publication" => "Asset review and ASC Preview remain required; this lane does not submit or publish." }
      end
    end

    private

    def link(type, id)
      { "data" => { "type" => type, "id" => id } }
    end

    def local_assets(variant, placement_types)
      config = @manifest.fetch("variants").fetch(variant)
      assets = config.fetch("assets")
      return [] if assets.empty?
      required = @manifest.fetch("locales").keys.product(PLACEMENTS.keys)
      actual = assets.map { |asset| [asset.fetch("locale"), asset.fetch("placement")] }
      raise Error, "#{variant} needs exactly one header and search video in every app locale" unless actual.sort == required.sort
      assets.flat_map do |asset|
        locale, placement, sha = asset.fetch("locale"), asset.fetch("placement"), asset.fetch("sha256")
        raise Error, "Creative SHA256 is invalid" unless sha.match?(/\A[a-f0-9]{64}\z/)
        relative = asset.fetch("file")
        path = File.expand_path(relative, @root)
        raise Error, "Creative file escapes repository" unless path.start_with?("#{@root}/") && File.file?(path) && File.realpath(path).start_with?("#{@root}/")
        raise Error, "Creative SHA256 mismatch" unless Digest::SHA256.file(path).hexdigest == sha
        provenance_path = File.expand_path(asset.fetch("provenance"), @root)
        provenance_sha = asset.fetch("provenanceSha256")
        raise Error, "Creative provenance file is invalid" unless provenance_sha.match?(/\A[a-f0-9]{64}\z/) && provenance_path.start_with?("#{@root}/") && File.file?(provenance_path) && File.realpath(provenance_path).start_with?("#{@root}/") && Digest::SHA256.file(provenance_path).hexdigest == provenance_sha
        report = JSON.parse(File.read(provenance_path))
        output = placement == "header" ? report.fetch("assets").find { |entry| entry["placement"] == placement } : report["video"]
        raise Error, "Creative output and provenance differ" unless report["variant"] == variant && report["locale"] == locale && output && output["file"] == File.basename(path) && output["sha256"] == sha
        extension = placement == "header" ? "png" : "mp4"
        raise Error, "Creative extension does not match placement" unless File.extname(path) == ".#{extension}"
        validate_media(path, placement)
        filename = "#{variant}-#{placement}-#{locale}-#{sha[0, 12]}.#{extension}"
        placement_type = PLACEMENTS.fetch(placement)
        mappings = placement_types.find { |entry| entry["placementTypeId"] == placement_type }.fetch("specMappings")
        group = asset.fetch("placementGroup")
        raise Error, "Creative placement group/spec is not supported by Apple refdata" unless mappings.any? { |mapping| mapping["placementGroupId"] == group && mapping.fetch("specs").include?(asset.fetch("specId")) }
        @manifest.fetch("locales").fetch(locale).map do |store_locale|
          { "variant" => variant, "appLocale" => locale, "storeLocale" => store_locale, "placement" => placement, "placementType" => placement_type, "placementGroup" => group, "path" => path, "sha256" => sha, "fileName" => filename, "type" => placement == "header" ? "appAssetLibraryImages" : "appAssetLibraryVideos" }
        end
      end
    end

    def validate_media(path, placement)
      if placement == "header"
        bytes = File.binread(path, 33)
        raise Error, "Header must be opaque 3840x1646 PNG" unless bytes.start_with?("\x89PNG\r\n\x1a\n".b) && bytes[16, 8].unpack("NN") == [3840, 1646] && [0, 2].include?(bytes.getbyte(25))
      else
        probe = @probe.call(path)
        raise Error, "Search creative must have no audio stream" if probe.fetch("streams").any? { |stream| stream["codec_type"] == "audio" }
        video = probe.fetch("streams").select { |stream| stream["codec_type"] == "video" }
        raise Error, "Search creative requires one H.264 High video stream" unless video.length == 1 && video.first["codec_name"] == "h264" && video.first["profile"] == "High"
        stream = video.first
        rate = stream.fetch("avg_frame_rate").split("/").map(&:to_f)
        duration = probe.fetch("format").fetch("duration").to_f
        raise Error, "Search creative must be 1920x1280, 30fps, 5–30s, yuv420p, level>=5.0" unless stream["width"] == 1920 && stream["height"] == 1280 && rate[1].positive? && (rate[0] / rate[1] - 30).abs < 0.01 && duration.between?(5, 30) && stream["pix_fmt"] == "yuv420p" && stream.fetch("level").to_i >= 50
      end
    end

    def destination(variant, locale, allow_live)
      if variant == "default"
        versions = @client.list("/v1/apps/#{@app_id}/appStoreVersions?filter[platform]=IOS&limit=200")
        editable = versions.select { |version| EDITABLE.include?(version.dig("attributes", "appStoreState")) }
        live = versions.select { |version| LIVE.include?(version.dig("attributes", "appStoreState")) }
        version = if editable.empty? && allow_live
          latest_live_version(live)
        else
          raise Error, "Need exactly one editable iOS version (live requires allow_live:true)" unless editable.length == 1
          editable.first
        end
        localized = @client.list("/v1/appStoreVersions/#{version.fetch('id')}/appStoreVersionLocalizations?limit=200")
        type, relationship = "appStoreVersionLocalizations", "appStoreVersionLocalization"
      else
        name = @cpp.fetch("targets").fetch(variant).fetch("referenceName")
        pages = @client.list("/v1/apps/#{@app_id}/appCustomProductPages?limit=200").select { |page| page.dig("attributes", "name") == name }
        raise Error, "Need exactly one CPP named #{name}" unless pages.length == 1
        versions = @client.list("/v1/appCustomProductPages/#{pages.first.fetch('id')}/appCustomProductPageVersions?limit=200")
        editable = versions.select { |version| EDITABLE.include?(version.dig("attributes", "state")) }
        candidates = editable.empty? && allow_live ? versions.select { |version| version.dig("attributes", "state") == "APPROVED" } : editable
        raise Error, "Need exactly one editable CPP version (live requires allow_live:true)" unless candidates.length == 1
        localized = @client.list("/v1/appCustomProductPageVersions/#{candidates.first.fetch('id')}/appCustomProductPageLocalizations?limit=200")
        type, relationship = "appCustomProductPageLocalizations", "appCustomProductPageLocalization"
      end
      matches = localized.select { |entry| entry.dig("attributes", "locale") == locale }
      raise Error, "Missing or ambiguous destination locale #{variant}/#{locale}" unless matches.length == 1
      { "type" => type, "relationship" => relationship, "id" => matches.first.fetch("id") }
    end

    def latest_live_version(versions)
      raise Error, "No published iOS version found" if versions.empty?
      dated_versions = versions.map do |version|
        created_date = version.dig("attributes", "createdDate")
        begin
          raise ArgumentError unless created_date.is_a?(String) && created_date.match?(/(?:Z|[+-]\d{2}:\d{2})\z/)
          Date.iso8601(created_date)
          [Time.iso8601(created_date), version]
        rescue ArgumentError
          raise Error, "Published iOS version has missing or invalid createdDate; cannot safely choose the current version"
        end
      end
      newest_date = dated_versions.map(&:first).max
      newest = dated_versions.select { |created_date, _version| created_date == newest_date }
      raise Error, "Published iOS versions tie for latest createdDate; cannot safely choose the current version" unless newest.length == 1
      newest.first.last
    end

    def upload(plan, library_id)
      resource = plan["asset"]
      unless resource
        attributes = { "category" => "CREATIVE_ASSETS", "fileName" => plan.fetch("fileName"), "referenceName" => "Boardsesh #{plan.fetch('variant')} #{plan.fetch('placement')} #{plan.fetch('appLocale')}", "fileSize" => File.size(plan.fetch("path")) }
        attributes["previewFrameTimeCode"] = "00:00:00:00" if plan.fetch("type") == "appAssetLibraryVideos"
        resource = @client.request("POST", "/v1/#{plan.fetch('type')}", { "data" => { "type" => plan.fetch("type"), "attributes" => attributes, "relationships" => { "assetLibrary" => link("appAssetLibraries", library_id) } } }).fetch("data")
      end
      raise Error, "Creative asset is not awaiting upload; inspect Asset Library" unless resource.dig("attributes", "state") == "AWAITING_UPLOAD"
      operations = resource.dig("attributes", "uploadOperations")
      raise Error, "Apple returned no asset upload operations" unless operations.is_a?(Array) && !operations.empty?
      operations.each { |operation| @client.upload(operation, plan.fetch("path")) }
      @client.request("PATCH", "/v1/#{resource.fetch('type')}/#{resource.fetch('id')}", { "data" => { "type" => resource.fetch("type"), "id" => resource.fetch("id"), "attributes" => { "uploaded" => true } } }).fetch("data")
    end
  end
end
