# frozen_string_literal: true

require "digest"
require "fileutils"
require "json"
require "tmpdir"

root = File.expand_path("..", __dir__)
manifest = JSON.parse(File.read(File.join(root, "app-stores", "apple", "creative-assets.json")))
variant = ENV.fetch("CREATIVE_VARIANT", "all")
selected = variant == "all" ? manifest.fetch("variants").keys : [variant]
abort "Unknown creative variant" unless selected.all? { |name| manifest.fetch("variants").key?(name) }
Dir.mktmpdir("boardsesh-release-creatives") do |directory|
  selected.each do |name|
    manifest.fetch("variants").fetch(name).fetch("assets").each do |asset|
      locale, placement, sha = asset.fetch("locale"), asset.fetch("placement"), asset.fetch("sha256")
      abort "Invalid asset identity" unless manifest.fetch("locales").key?(locale) && %w[header search-results].include?(placement) && sha.match?(/\A[a-f0-9]{64}\z/)
      extension = placement == "header" ? "png" : "mp4"
      filename = "#{name}-#{placement}-#{locale}-#{sha[0, 12]}.#{extension}"
      downloaded = File.join(directory, filename)
      unless File.file?(downloaded)
        abort "Release asset download failed" unless system("gh", "release", "download", manifest.fetch("release"), "--repo", "boardsesh/boardsesh", "--pattern", filename, "--dir", directory)
      end
      abort "Release asset SHA256 mismatch" unless Digest::SHA256.file(downloaded).hexdigest == sha
      destination = File.expand_path(asset.fetch("file"), root)
      abort "Asset destination escapes creative export directory" unless destination.start_with?(File.join(root, ".boardsesh", "app-store-creatives", name, locale) + "/")
      FileUtils.mkdir_p(File.dirname(destination))
      FileUtils.cp(downloaded, destination)
      proof_sha = asset.fetch("provenanceSha256")
      abort "Invalid provenance checksum" unless proof_sha.match?(/\A[a-f0-9]{64}\z/)
      proof_name = "#{name}-#{placement}-#{locale}-#{proof_sha[0, 12]}.json"
      proof_file = File.join(directory, proof_name)
      unless File.file?(proof_file)
        abort "Provenance download failed" unless system("gh", "release", "download", manifest.fetch("release"), "--repo", "boardsesh/boardsesh", "--pattern", proof_name, "--dir", directory)
      end
      abort "Provenance SHA256 mismatch" unless Digest::SHA256.file(proof_file).hexdigest == proof_sha
      proof_destination = File.expand_path(asset.fetch("provenance"), root)
      abort "Provenance destination escapes creative directory" unless proof_destination.start_with?(File.join(root, ".boardsesh", "app-store-creatives", name, locale) + "/")
      FileUtils.mkdir_p(File.dirname(proof_destination))
      FileUtils.cp(proof_file, proof_destination)
    end
  end
end
