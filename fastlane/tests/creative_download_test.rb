# frozen_string_literal: true
require "minitest/autorun"
require "tmpdir"
require "json"
require_relative "../lib/creative_download"

class CreativeDownloadTest < Minitest::Test
  def setup
    @root = File.realpath(Dir.mktmpdir("creative-download"))
    @video, @proof = "video", "proof"
    @asset = { "locale" => "en-US", "placement" => "search-results", "file" => ".boardsesh/app-store-creatives/default/en-US/search-results.mp4", "sha256" => Digest::SHA256.hexdigest(@video), "provenance" => ".boardsesh/app-store-creatives/default/en-US/search-results.manifest.json", "provenanceSha256" => Digest::SHA256.hexdigest(@proof) }
    @manifest = { "storage" => { "bucket" => "boardsesh-store-creatives", "baseUrl" => "https://store-creatives.boardsesh.com" }, "locales" => { "en-US" => ["en-US"] }, "variants" => { "default" => { "assets" => [@asset] } } }
  end
  def teardown
    FileUtils.remove_entry(@root)
  end
  def test_download_uses_approved_hashes_and_verifies_all_bytes
    urls = []
    fetch = ->(url) { urls << url.to_s; url.path.end_with?(".mp4") ? @video : @proof }
    assert_equal 2, BoardseshCreativeDownload.download(manifest: @manifest, root: @root, fetch: fetch)
    assert_equal @video, File.read(File.join(@root, @asset["file"]))
    assert_equal "https://store-creatives.boardsesh.com/approved/#{@asset['sha256']}.mp4", urls.first
  end
  def test_checksum_failure_wipes_stale_export_tree
    output = File.join(@root, ".boardsesh", "app-store-creatives")
    FileUtils.mkdir_p(output); File.write(File.join(output, "stale"), "old")
    assert_raises(BoardseshCreativeDownload::Error) { BoardseshCreativeDownload.download(manifest: @manifest, root: @root, fetch: ->(_url) { "wrong" }) }
    refute File.exist?(output)
  end
  def test_search_only_download_does_not_require_header_bytes
    @manifest["variants"]["default"]["assets"] << { "placement" => "header" }
    assert_equal 2, BoardseshCreativeDownload.download(manifest: @manifest, root: @root, placement: "search", fetch: ->(url) { url.path.end_with?(".mp4") ? @video : @proof })
  end
end
