# frozen_string_literal: true

require "minitest/autorun"
require "tmpdir"
require "fileutils"
require_relative "../lib/creative_assets"

class CreativeAssetsTest < Minitest::Test
  class FakeApple
    attr_reader :writes, :uploads, :assets, :placements
    attr_accessor :live, :supported

    def initialize
      @writes, @uploads, @assets, @placements = [], [], [], []
      @supported = true
      @live = false
    end

    def list(path)
      case path
      when "/v1/appAssetLibraryRefData"
        [{ "attributes" => { "placementTypes" => BoardseshCreatives::PLACEMENTS.map { |placement, type| { "placementTypeId" => @supported ? type : "unsupported", "specMappings" => [{ "placementGroupId" => "creative", "specs" => [placement] }] } } } }]
      when /appStoreVersions\?/
        [{ "id" => "version", "attributes" => { "appStoreState" => @live ? "READY_FOR_DISTRIBUTION" : "PREPARE_FOR_SUBMISSION" } }]
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
    runner.run(action: "upload")
    runner.run(action: "place")
    assert_equal 10, @client.placements.length
    assert @client.placements.all? { |placement| placement.dig("relationships", "appStoreVersionLocalization", "data", "type") == "appStoreVersionLocalizations" }
    @client.writes.clear
    assert runner.run(action: "place").all? { |result| result["action"] == "unchanged" }
    assert_empty @client.writes
  end

  def test_changed_placement_requires_deletion_approval
    runner.run(action: "upload")
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
    assert_raises(BoardseshCreatives::Error) { runner.run(action: "upload") }
    assert_empty @client.writes
    assert_equal 10, runner.run(action: "plan", allow_live: true).length
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
    runner.run(action: "upload")
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
end
