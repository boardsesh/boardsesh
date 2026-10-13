# frozen_string_literal: true

require "digest"
require "json"
require "fileutils"
require "optparse"

# Finalize reviewed local exports against real Apple refdata. Never mint hashes
# or invent placement group IDs while the native captures are still pending.
options = { variant: "all" }
OptionParser.new do |parser|
  parser.on("--refdata FILE") { |path| options[:refdata] = path }
  parser.on("--variant VARIANT") { |variant| options[:variant] = variant }
  parser.on("--header-group GROUP") { |group| options[:header_group] = group }
  parser.on("--search-group GROUP") { |group| options[:search_group] = group }
end.parse!
abort "Pass --refdata with the ios creatives action:refdata JSON report" unless options[:refdata]
root = File.expand_path("..", __dir__)
manifest_path = File.join(root, "app-stores", "apple", "creative-assets.json")
manifest = JSON.parse(File.read(manifest_path))
refdata = JSON.parse(File.read(options.fetch(:refdata)))
attributes = refdata.map { |datum| datum.fetch("attributes") }
selected = options[:variant] == "all" ? manifest.fetch("variants").keys : [options[:variant]]
abort "Unknown creative variant" unless selected.all? { |variant| manifest.fetch("variants").key?(variant) }
selected.each do |variant|
  assets = manifest.fetch("locales").keys.flat_map do |locale|
    %w[header search-results].map do |placement|
      extension = placement == "header" ? "png" : "mp4"
      file = ".boardsesh/app-store-creatives/#{variant}/#{locale}/#{placement}.#{extension}"
      path = File.join(root, file)
      abort "Missing export #{file}; record and render its native locale first" unless File.file?(path)
      report_name = placement == "header" ? "creative-assets.json" : "search-results.manifest.json"
      report_path = File.join(File.dirname(path), report_name)
      abort "Missing provenance #{report_name} for #{variant}/#{locale}" unless File.file?(report_path)
      report = JSON.parse(File.read(report_path))
      abort "Export provenance identity mismatch" unless report["variant"] == variant && report["locale"] == locale
      sha = Digest::SHA256.file(path).hexdigest
      recorded_output = placement == "header" ? report.fetch("assets").find { |asset| asset["placement"] == placement } : report["video"]
      abort "Export bytes do not match provenance" unless recorded_output && recorded_output["file"] == File.basename(path) && recorded_output["sha256"] == sha
      sources = report.fetch("sources")
      abort "Header needs native source hashes" if placement == "header" && (!sources.is_a?(Hash) || sources.length != 3 || sources.values.any? { |source| !source.fetch("sha256").match?(/\A[a-f0-9]{64}\z/) })
      abort "Video needs native source hashes" if placement != "header" && (!sources.is_a?(Array) || sources.empty? || sources.any? { |source| !source.fetch("framesSha256").match?(/\A[a-f0-9]{64}\z/) || !source.fetch("marksSha256").match?(/\A[a-f0-9]{64}\z/) })
      placement_type = placement == "header" ? "PRODUCT_PAGE_HEADER_ASSET" : "APP_STORE_SEARCH_RESULTS_ASSET"
      width, height = placement == "header" ? [3840, 1646] : [1920, 1280]
      media_key = placement == "header" ? "imageSpecs" : "videoSpecs"
      specs = attributes.flat_map { |entry| entry.fetch(media_key, []) }.select do |spec|
        dimensions = spec.fetch("dimensions")
        spec.fetch("compatiblePlacementTypes", []).include?(placement_type) &&
          width.between?(dimensions.fetch("minWidth"), dimensions.fetch("maxWidth")) &&
          height.between?(dimensions.fetch("minHeight"), dimensions.fetch("maxHeight")) &&
          spec.fetch("aspectRatio") == (placement == "header" ? "21:9" : "3:2")
      end
      groups = attributes.flat_map { |entry| entry.fetch("placementTypes", []) }.select { |entry| entry["placementTypeId"] == placement_type }.flat_map { |entry| entry.fetch("specMappings") }
      explicit_group = options[placement == "header" ? :header_group : :search_group]
      combinations = specs.flat_map do |spec|
        groups.select { |group| group.fetch("specs").include?(spec.fetch("specId")) && (!explicit_group || group["placementGroupId"] == explicit_group) }.map { |group| [spec.fetch("specId"), group.fetch("placementGroupId")] }
      end.uniq
      abort "Ambiguous or unsupported #{placement}; specify --#{placement == 'header' ? 'header' : 'search'}-group from Apple refdata" unless combinations.length == 1
      { "locale" => locale, "placement" => placement, "file" => file, "sha256" => sha, "specId" => combinations.first[0], "placementGroup" => combinations.first[1], "provenance" => report_path.delete_prefix("#{root}/"), "provenanceSha256" => Digest::SHA256.file(report_path).hexdigest }
    end
  end
  manifest.fetch("variants").fetch(variant)["assets"] = assets
end
File.write(manifest_path, JSON.pretty_generate(manifest) + "\n")
puts "Finalized #{selected.length} variants with fresh native locale exports and SHA256 hashes."
