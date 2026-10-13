# frozen_string_literal: true

require "minitest/autorun"
require "tmpdir"
require "fileutils"
require_relative "../lib/creative_assets"

class CreativeAssetsTest < Minitest::Test
  class FakeApple
    attr_reader :writes, :uploads, :assets, :placements, :reads
    attr_accessor :live, :supported, :versions, :destinations_available

    def initialize
      @writes, @uploads, @assets, @placements = [], [], [], []
      @reads = []
      @supported = true
      @live = false
      @destinations_available = true
    end

    def list(path)
      @reads << path
      raise "Upload unexpectedly read a placement destination" if !@destinations_available && path.match?(/appStoreVersion|appCustomProductPage|\/placements\?/)
      case path
      when "/v1/appAssetLibraryRefData"
        [{ "attributes" => { "placementTypes" => BoardseshCreatives::PLACEMENTS.map { |placement, type| { "placementTypeId" => @supported ? type : "unsupported", "specMappings" => [{ "placementGroupId" => "creative", "specs" => [placement] }] } } } }]
      when /appStoreVersions\?/
        @versions || [{ "id" => "version", "attributes" => { "appStoreState" => @live ? "READY_FOR_DISTRIBUTION" : "PREPARE_FOR_SUBMISSION", "createdDate" => "2026-10-01T00:00:00Z" } }]
      when /appStoreVersionLocalizations\?/
        %w[en-US es-ES es-MX fr-FR de-DE].map { |locale| { "id" => locale, "attributes" => { "locale" => locale } } }
      when %r{/appAssetLibraries/library/(images|videos)}
        type = path.include?("/images") ? "appAssetLibraryImages" : "appAssetLibraryVideos"
        @assets.select { |asset| asset["type"] == type }
      when %r{/v1/(appAssetLibraryImages|appAssetLibraryVideos)/([^/]+)/placements}
        type, id = path.split("/")[2, 2]
        relation = type == "appAssetLibraryImages" ? "image" : "video"
        @placements.select { |placement| placement.dig("relationships", relation, "data", "id") == id }
      else
        raise "Unexpected GET list #{path}"
      end
    end

    def request(method, path, body = nil)
      return { "data" => { "type" => "appAssetLibraries", "id" => "library" } } if method == "GET" && path == "/v1/apps/app/assetLibrary"
      @writes << [method, path, body]
      if method == "POST" && path == "/v1/appAssetLibraryPlacements"
        placement = body.fetch("data").merge("id" => "placement-#{@placements.length}")
        @placements << placement
        return { "data" => placement }
      end
      if method == "DELETE"
        @placements.reject! { |placement| path.end_with?("/#{placement['id']}") }
        return {}
      end
      payload = body.fetch("data")
      if method == "POST"
        asset = Marshal.load(Marshal.dump(payload)).merge("id" => "asset-#{@assets.length}")
        asset["attributes"].merge!("state" => "AWAITING_UPLOAD", "uploadOperations" => [{ "offset" => 0, "length" => asset.dig("attributes", "fileSize") }])
        @assets << asset
      else
        asset = @assets.find { |entry| entry["id"] == payload["id"] }
        asset["attributes"]["state"] = "UPLOAD_COMPLETE"
      end
      { "data" => asset }
    end

    def upload(_operation, path)
      @uploads << path
    end
  end

  class FakeCppApple < FakeApple
    def list(path)
      case path
      when %r{\A/v1/apps/app/appCustomProductPages\?}
        [{ "id" => "kilter-page", "attributes" => { "name" => "Boardsesh Kilter" } }]
      when %r{\A/v1/appCustomProductPages/kilter-page/appCustomProductPageVersions\?}
        [{ "id" => "kilter-version", "attributes" => { "state" => "PREPARE_FOR_SUBMISSION" } }]
      when %r{\A/v1/appCustomProductPageVersions/kilter-version/appCustomProductPageLocalizations\?}
        %w[en-US es-ES es-MX fr-FR de-DE].map { |locale| { "id" => "cpp-#{locale}", "attributes" => { "locale" => locale } } }
      else
        super
      end
    end
  end

  def setup
    @root = File.realpath(Dir.mktmpdir("creative-assets-test"))
    @client = FakeApple.new
    @manifest = { "locales" => { "en-US" => ["en-US"], "es" => %w[es-ES es-MX], "fr" => ["fr-FR"], "de" => ["de-DE"] }, "variants" => { "default" => { "assets" => [] } } }
    @manifest.fetch("locales").each_key do |locale|
      BoardseshCreatives::PLACEMENTS.each_key do |placement|
        file = "#{locale}-#{placement}.#{placement == 'header' ? 'png' : 'mp4'}"
        bytes = placement == "header" ? "\x89PNG\r\n\x1a\n".b + [13].pack("N") + "IHDR" + [3840, 1646].pack("NN") + [8, 2, 0, 0, 0].pack("C*") : "native-video-#{locale}"
        File.binwrite(File.join(@root, file), bytes)
        sha = Digest::SHA256.hexdigest(bytes)
        proof_file = "#{locale}-#{placement}-proof.json"
        output = { "file" => file, "sha256" => sha, "placement" => placement }
        report = { "variant" => "default", "locale" => locale, "sources" => [{ "framesSha256" => "a" * 64, "marksSha256" => "b" * 64 }] }
        report[placement == "header" ? "assets" : "video"] = placement == "header" ? [output] : output
        File.write(File.join(@root, proof_file), JSON.generate(report))
        @manifest["variants"]["default"]["assets"] << { "locale" => locale, "placement" => placement, "file" => file, "sha256" => sha, "placementGroup" => "creative", "specId" => placement, "provenance" => proof_file, "provenanceSha256" => Digest::SHA256.file(File.join(@root, proof_file)).hexdigest }
      end
    end
    @probe = ->(_path) { { "streams" => [{ "codec_type" => "video", "codec_name" => "h264", "profile" => "High", "width" => 1920, "height" => 1280, "pix_fmt" => "yuv420p", "level" => 50, "avg_frame_rate" => "30/1" }], "format" => { "duration" => "15" } } }
  end

  def teardown
    FileUtils.remove_entry(@root)
  end

  def runner
    BoardseshCreatives::Runner.new(client: @client, repo_root: @root, manifest: @manifest, app_id: "app", cpp_manifest: {}, probe: @probe)
  end

  def upload_processed_assets
    runner.run(action: "upload")
    @client.assets.each { |asset| asset["attributes"]["state"] = "PREPARE_FOR_SUBMISSION" }
  end

  def use_kilter_manifest
    config = @manifest.fetch("variants").delete("default")
    @manifest.fetch("variants")["kilter"] = config
    config.fetch("assets").each do |asset|
      path = File.join(@root, asset.fetch("provenance"))
      proof = JSON.parse(File.read(path))
      proof["variant"] = "kilter"
      File.write(path, JSON.generate(proof))
      asset["provenanceSha256"] = Digest::SHA256.file(path).hexdigest
    end
  end

  def test_plan_is_read_only_and_spanish_maps_to_both_storefronts
    results = runner.run
    assert_equal 10, results.length
    assert_empty @client.writes
    assert_equal %w[es-ES es-MX], results.select { |entry| entry["placement"] == "header" && entry["locale"].start_with?("es") }.map { |entry| entry["locale"] }
  end

  def test_upload_deduplicates_spanish_and_reuses_uploaded_assets
    runner.run(action: "upload")
    assert_equal 8, @client.assets.length
    assert_equal 8, @client.uploads.length
    assert_equal 16, @client.writes.length
    @client.writes.clear
    runner.run(action: "upload")
    assert_empty @client.writes
    assert_equal "00:00:00:00", @client.assets.find { |asset| asset["type"] == "appAssetLibraryVideos" }.dig("attributes", "previewFrameTimeCode")
  end

  def test_place_is_idempotent_and_uses_localization_relationship
    upload_processed_assets
    runner.run(action: "place")
    assert_equal 10, @client.placements.length
    assert @client.placements.all? { |placement| placement.dig("relationships", "appStoreVersionLocalization", "data", "type") == "appStoreVersionLocalizations" }
    @client.writes.clear
    assert runner.run(action: "place").all? { |result| result["action"] == "unchanged" }
    assert_empty @client.writes
  end

  def test_changed_placement_requires_deletion_approval
    upload_processed_assets
    runner.run(action: "place")
    @client.writes.clear
    @client.placements.first["relationships"]["image"]["data"]["id"] = @client.assets[2]["id"]
    assert_raises(BoardseshCreatives::Error) { runner.run(action: "place") }
    assert_empty @client.writes
  end

  def test_unsupported_refdata_blocks_before_writes
    @client.supported = false
    assert_raises(BoardseshCreatives::Error) { runner.run(action: "upload") }
    assert_empty @client.writes
  end

  def test_hash_tampering_blocks_entire_upload
    File.write(File.join(@root, "de-search-results.mp4"), "changed")
    assert_raises(BoardseshCreatives::Error) { runner.run(action: "upload") }
    assert_empty @client.writes
  end

  def test_missing_locale_blocks_entire_upload
    @manifest["variants"]["default"]["assets"].pop
    assert_raises(BoardseshCreatives::Error) { runner.run(action: "upload") }
    assert_empty @client.writes
  end

  def test_live_version_requires_explicit_option
    @client.live = true
    upload_processed_assets
    @client.writes.clear
    assert_raises(BoardseshCreatives::Error) { runner.run(action: "place") }
    assert_empty @client.writes
    assert_equal 10, runner.run(action: "plan", allow_live: true).length
    assert_equal 10, runner.run(action: "place", allow_live: true).length
  end

  def test_upload_needs_no_version_localization_or_placement_access
    @client.destinations_available = false
    runner.run(action: "upload")
    assert_equal 8, @client.uploads.length
    assert_equal 8, @client.assets.length
    @client.writes.clear
    assert runner.run(action: "upload").all? { |result| result["action"] == "unchanged" }
    assert_empty @client.writes
  end

  def test_cpp_upload_needs_no_cpp_version_localization_or_manifest_target
    use_kilter_manifest
    @client.destinations_available = false
    runner.run(action: "upload")
    assert_equal 8, @client.uploads.length
    assert @client.assets.all? { |asset| asset.dig("attributes", "fileName").start_with?("kilter-") }
  end

  def test_processing_asset_blocks_entire_placement_batch
    %w[UPLOAD_COMPLETE COMPLETE].each do |state|
      upload_processed_assets
      @client.assets.last["attributes"]["state"] = state
      @client.writes.clear
      error = assert_raises(BoardseshCreatives::Error) { runner.run(action: "place") }
      assert_includes error.message, state
      assert_includes error.message, "PREPARE_FOR_SUBMISSION"
      assert_empty @client.writes
      assert_empty @client.placements
    end
  end

  def test_processing_asset_blocks_earlier_placement_replacement
    upload_processed_assets
    runner.run(action: "place")
    @client.assets.last["attributes"]["state"] = "UPLOAD_COMPLETE"
    previous_asset = Marshal.load(Marshal.dump(@client.assets.first))
    previous_asset["id"] = "previous-owned-header"
    previous_asset["attributes"]["fileName"] = "default-header-en-US-#{'f' * 12}.png"
    @client.assets << previous_asset
    @client.placements.first["relationships"]["image"]["data"]["id"] = previous_asset.fetch("id")
    original_placements = Marshal.load(Marshal.dump(@client.placements))
    @client.writes.clear
    error = assert_raises(BoardseshCreatives::Error) { runner.run(action: "place", allow_replace: true) }
    assert_includes error.message, "UPLOAD_COMPLETE"
    assert_empty @client.writes
    assert_equal original_placements, @client.placements
  end

  def test_latest_live_version_is_selected_among_historical_versions
    @client.versions = [
      { "id" => "older", "attributes" => { "appStoreState" => "READY_FOR_SALE", "createdDate" => "2025-12-31T23:59:59Z" } },
      { "id" => "current", "attributes" => { "appStoreState" => "READY_FOR_DISTRIBUTION", "createdDate" => "2026-10-01T00:00:00Z" } },
      { "id" => "historical", "attributes" => { "appStoreState" => "READY_FOR_SALE", "createdDate" => "2026-05-01T00:00:00Z" } }
    ]
    upload_processed_assets
    @client.reads.clear
    runner.run(action: "place", allow_live: true)
    localization_reads = @client.reads.select { |path| path.include?("/appStoreVersionLocalizations?") }
    refute_empty localization_reads
    assert localization_reads.all? { |path| path.start_with?("/v1/appStoreVersions/current/") }
    assert_equal 10, @client.placements.length
  end

  def test_uncertain_live_dates_block_all_placement_writes
    [nil, "not-a-date", "2026-10-01T00:00:00", "2026-02-30T00:00:00Z", "2026-10-01T00:00:00Z"].each do |uncertain_date|
      @client.versions = [
        { "id" => "current", "attributes" => { "appStoreState" => "READY_FOR_DISTRIBUTION", "createdDate" => "2026-10-01T00:00:00Z" } },
        { "id" => "other", "attributes" => { "appStoreState" => "READY_FOR_SALE", "createdDate" => uncertain_date } }
      ]
      upload_processed_assets
      @client.writes.clear
      assert_raises(BoardseshCreatives::Error) { runner.run(action: "place", allow_live: true) }
      assert_empty @client.writes
      assert_empty @client.placements
    end
  end

  def test_level_four_video_is_rejected
    @probe = ->(_path) { { "streams" => [{ "codec_type" => "video", "codec_name" => "h264", "profile" => "High", "width" => 1920, "height" => 1280, "pix_fmt" => "yuv420p", "level" => 40, "avg_frame_rate" => "30/1" }], "format" => { "duration" => "15" } } }
    assert_raises(BoardseshCreatives::Error) { runner.run(action: "upload") }
    assert_empty @client.writes
  end

  def test_audio_video_is_rejected_before_upload
    valid_probe = @probe
    @probe = ->(path) { result = valid_probe.call(path); result["streams"] << { "codec_type" => "audio" }; result }
    assert_raises(BoardseshCreatives::Error) { runner.run(action: "upload") }
    assert_empty @client.writes
  end

  def test_failed_placement_is_not_successfully_unchanged
    upload_processed_assets
    runner.run(action: "place")
    @client.placements.last["attributes"]["state"] = "FAILED"
    @client.writes.clear
    assert_raises(BoardseshCreatives::Error) { runner.run(action: "place") }
    assert_empty @client.writes
  end

  def test_late_failed_asset_blocks_before_any_write
    runner.run(action: "upload")
    @client.assets.shift
    @client.assets.last["attributes"]["state"] = "FAILED"
    @client.writes.clear
    assert_raises(BoardseshCreatives::Error) { runner.run(action: "upload") }
    assert_empty @client.writes
  end

  def test_changed_provenance_blocks_upload
    File.write(File.join(@root, "de-search-results-proof.json"), "{}")
    assert_raises(BoardseshCreatives::Error) { runner.run(action: "upload") }
    assert_empty @client.writes
  end

  def test_media_rehash_cannot_reuse_stale_provenance
    file = File.join(@root, "de-search-results.mp4")
    File.write(file, "overwritten native video")
    @manifest["variants"]["default"]["assets"].last["sha256"] = Digest::SHA256.file(file).hexdigest
    assert_raises(BoardseshCreatives::Error) { runner.run(action: "upload") }
    assert_empty @client.writes
  end

  def test_cpp_placements_bind_to_cpp_localizations_in_every_store_locale
    @client = FakeCppApple.new
    use_kilter_manifest
    cpp = { "targets" => { "kilter" => { "referenceName" => "Boardsesh Kilter" } } }
    cpp_runner = BoardseshCreatives::Runner.new(client: @client, repo_root: @root, manifest: @manifest, app_id: "app", cpp_manifest: cpp, probe: @probe)
    cpp_runner.run(action: "upload")
    @client.assets.each { |asset| asset["attributes"]["state"] = "PREPARE_FOR_SUBMISSION" }
    cpp_runner.run(action: "place")
    assert_equal 10, @client.placements.length
    assert @client.placements.all? { |placement| placement.dig("relationships", "appCustomProductPageLocalization", "data", "type") == "appCustomProductPageLocalizations" }
    refute @client.placements.any? { |placement| placement.fetch("relationships").key?("appStoreVersionLocalization") }
  end

  def test_pending_manifest_is_not_an_upload_success
    @manifest.fetch("variants").fetch("default")["assets"] = []
    assert_equal "pending", runner.run(action: "plan").first.fetch("action")
    assert_raises(BoardseshCreatives::Error) { runner.run(action: "upload") }
    assert_raises(BoardseshCreatives::Error) { runner.run(action: "place") }
    assert_empty @client.writes
  end
end
