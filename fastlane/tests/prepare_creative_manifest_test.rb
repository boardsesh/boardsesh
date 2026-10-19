# frozen_string_literal: true
require "minitest/autorun"
require "tmpdir"
require "fileutils"
require "json"
require "digest"
require "open3"
require "rbconfig"

class PrepareCreativeManifestTest < Minitest::Test
  def test_search_finalization_preserves_header_entries_without_header_files
    Dir.mktmpdir("prepare-creatives") do |root|
      FileUtils.mkdir_p(File.join(root, "fastlane"))
      FileUtils.cp(File.expand_path("../prepare_creative_manifest.rb", __dir__), File.join(root, "fastlane", "prepare_creative_manifest.rb"))
      manifest_path = File.join(root, "app-stores", "apple", "creative-assets.json")
      FileUtils.mkdir_p(File.dirname(manifest_path))
      header = { "locale" => "en-US", "placement" => "header", "file" => "retained-header.png", "sha256" => "a" * 64 }
      manifest = { "locales" => { "en-US" => ["en-US"] }, "variants" => { "default" => { "assets" => [header] } } }
      File.write(manifest_path, JSON.generate(manifest))
      export = File.join(root, ".boardsesh", "app-store-creatives", "default", "en-US")
      FileUtils.mkdir_p(export)
      File.write(File.join(export, "search-results.mp4"), "video")
      File.write(File.join(export, "search-results-poster.jpg"), "poster")
      proof = { "variant" => "default", "locale" => "en-US", "video" => { "file" => "search-results.mp4", "sha256" => Digest::SHA256.hexdigest("video") }, "poster" => { "file" => "search-results-poster.jpg", "sha256" => Digest::SHA256.hexdigest("poster") }, "sources" => [{ "framesSha256" => "a" * 64, "marksSha256" => "b" * 64 }] }
      File.write(File.join(export, "search-results.manifest.json"), JSON.generate(proof))
      refdata_path = File.join(root, "refdata.json")
      placement_type = "APP_STORE_SEARCH_RESULTS_ASSET"
      File.write(refdata_path, JSON.generate([{ "attributes" => { "videoSpecs" => [{ "specId" => "search", "compatiblePlacementTypes" => [placement_type], "aspectRatio" => "3:2", "dimensions" => { "minWidth" => 1920, "maxWidth" => 1920, "minHeight" => 1280, "maxHeight" => 1280 } }], "placementTypes" => [{ "placementTypeId" => placement_type, "specMappings" => [{ "placementGroupId" => "search", "specs" => ["search"] }] }] } }]))
      stdout, stderr, status = Open3.capture3(RbConfig.ruby, File.join(root, "fastlane", "prepare_creative_manifest.rb"), "--refdata", refdata_path, "--placement", "search")
      assert status.success?, "#{stdout}\n#{stderr}"
      assets = JSON.parse(File.read(manifest_path)).fetch("variants").fetch("default").fetch("assets")
      assert_equal header, assets.first
      assert_equal 2, assets.length
      assert_equal "search-results", assets.last.fetch("placement")
      assert_equal Digest::SHA256.hexdigest("poster"), assets.last.fetch("posterSha256")
    end
  end
end
