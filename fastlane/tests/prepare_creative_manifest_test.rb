# frozen_string_literal: true
require "minitest/autorun"
require "tmpdir"
require "fileutils"
require "json"
require "digest"
require "open3"
require "rbconfig"

class PrepareCreativeManifestTest < Minitest::Test
  def test_comma_list_finalizes_only_listed_variants_and_keeps_the_rest
    Dir.mktmpdir("prepare-creatives") do |root|
      FileUtils.mkdir_p(File.join(root, "fastlane"))
      FileUtils.cp(File.expand_path("../prepare_creative_manifest.rb", __dir__), File.join(root, "fastlane", "prepare_creative_manifest.rb"))
      manifest_path = File.join(root, "app-stores", "apple", "creative-assets.json")
      FileUtils.mkdir_p(File.dirname(manifest_path))
      shipped = { "locale" => "en-US", "placement" => "search-results", "file" => "shipped.mp4", "sha256" => "d" * 64 }
      manifest = { "locales" => { "en-US" => ["en-US"] }, "variants" => { "default" => { "assets" => [] }, "kilter" => { "assets" => [shipped] }, "tension" => { "assets" => [] }, "spray" => { "assets" => [] } } }
      File.write(manifest_path, JSON.generate(manifest))
      %w[default spray].each do |variant|
        export = File.join(root, ".boardsesh", "app-store-creatives", variant, "en-US")
        FileUtils.mkdir_p(export)
        File.write(File.join(export, "search-results.mp4"), "video-#{variant}")
        File.write(File.join(export, "search-results-poster.jpg"), "poster-#{variant}")
        proof = { "variant" => variant, "locale" => "en-US", "video" => { "file" => "search-results.mp4", "sha256" => Digest::SHA256.hexdigest("video-#{variant}") }, "poster" => { "file" => "search-results-poster.jpg", "sha256" => Digest::SHA256.hexdigest("poster-#{variant}") }, "sources" => [{ "framesSha256" => "a" * 64, "marksSha256" => "b" * 64 }] }
        File.write(File.join(export, "search-results.manifest.json"), JSON.generate(proof))
      end
      refdata_path = File.join(root, "refdata.json")
      placement_type = "APP_STORE_SEARCH_RESULTS_ASSET"
      File.write(refdata_path, JSON.generate([{ "attributes" => { "videoSpecs" => [{ "specId" => "search", "compatiblePlacementTypes" => [placement_type], "aspectRatio" => "3:2", "dimensions" => { "minWidth" => 1920, "maxWidth" => 1920, "minHeight" => 1280, "maxHeight" => 1280 } }], "placementTypes" => [{ "placementTypeId" => placement_type, "specMappings" => [{ "placementGroupId" => "search", "specs" => ["search"] }] }] } }]))
      script = File.join(root, "fastlane", "prepare_creative_manifest.rb")
      ["default,default", "default,", "default,kilterx"].each do |variant|
        _stdout, _stderr, status = Open3.capture3(RbConfig.ruby, script, "--refdata", refdata_path, "--placement", "search", "--variant", variant)
        refute status.success?, "#{variant} should be rejected"
      end
      assert_equal manifest, JSON.parse(File.read(manifest_path))
      stdout, stderr, status = Open3.capture3(RbConfig.ruby, script, "--refdata", refdata_path, "--placement", "search", "--variant", "default,spray")
      assert status.success?, "#{stdout}\n#{stderr}"
      variants = JSON.parse(File.read(manifest_path)).fetch("variants")
      assert_equal [shipped], variants.fetch("kilter").fetch("assets")
      assert_empty variants.fetch("tension").fetch("assets")
      %w[default spray].each do |variant|
        assets = variants.fetch(variant).fetch("assets")
        assert_equal 1, assets.length
        assert_equal ".boardsesh/app-store-creatives/#{variant}/en-US/search-results.mp4", assets.first.fetch("file")
      end
    end
  end

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
