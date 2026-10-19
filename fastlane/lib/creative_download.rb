# frozen_string_literal: true

require "digest"
require "fileutils"
require "net/http"
require "tmpdir"
require "uri"

module BoardseshCreativeDownload
  class Error < StandardError; end

  def self.download(manifest:, root:, variant: "all", placement: "all", fetch: nil)
    root = File.realpath(root)
    output = File.join(root, ".boardsesh", "app-store-creatives")
    selected = variant == "all" ? manifest.fetch("variants").keys : [variant]
    raise Error, "Unknown creative variant" unless selected.all? { |name| manifest.fetch("variants").key?(name) && name.match?(/\A(?:default|kilter|tension|moonboard|spray)\z/) }
    raise Error, "Unknown creative placement" unless %w[all search].include?(placement)
    storage = manifest.fetch("storage")
    base = URI(storage.fetch("baseUrl"))
    raise Error, "Creative storage must use HTTPS" unless base.is_a?(URI::HTTPS) && base.host && !base.userinfo && !base.query && !base.fragment && ["", "/"].include?(base.path) && storage.fetch("bucket") == "boardsesh-store-creatives"
    fetch ||= ->(url) do
      response = Net::HTTP.start(url.host, url.port, use_ssl: true, open_timeout: 30, read_timeout: 120) { |http| http.get(url.request_uri) }
      raise Error, "Approved creative download failed: HTTP #{response.code}" unless response.is_a?(Net::HTTPSuccess)
      response.body
    end
    staged = []
    Dir.mktmpdir("boardsesh-r2-creatives") do |directory|
      selected.each do |name|
        manifest.fetch("variants").fetch(name).fetch("assets").each do |asset|
          next if placement == "search" && asset.fetch("placement") != "search-results"
          locale, kind = asset.fetch("locale"), asset.fetch("placement")
          raise Error, "Invalid asset identity" unless manifest.fetch("locales").key?(locale) && %w[en-US es fr de].include?(locale) && %w[header search-results].include?(kind)
          entries = [[asset.fetch("file"), asset.fetch("sha256"), kind == "header" ? "png" : "mp4"], [asset.fetch("provenance"), asset.fetch("provenanceSha256"), "json"]]
          entries << [asset.fetch("poster"), asset.fetch("posterSha256"), "jpg"] if asset.key?("poster")
          entries.each do |file, sha, extension|
            raise Error, "Invalid creative checksum" unless sha.match?(/\A[a-f0-9]{64}\z/)
            prefix = ".boardsesh/app-store-creatives/#{name}/#{locale}/"
            raise Error, "Creative destination escapes export directory" unless file.start_with?(prefix) && !file.delete_prefix(prefix).include?("/") && !file.include?("\\") && File.extname(file) == ".#{extension}"
            bytes = fetch.call(URI("#{base.to_s.delete_suffix('/')}/approved/#{sha}.#{extension}"))
            raise Error, "Approved creative SHA256 mismatch" unless Digest::SHA256.hexdigest(bytes) == sha
            temporary = File.join(directory, "#{staged.length}.#{extension}")
            File.binwrite(temporary, bytes)
            staged << [temporary, File.join(root, file)]
          end
        end
      end
      raise Error, "No finalized creative assets selected" if staged.empty?
      # Verify the complete download before exposing any file to the upload lane.
      staged.each do |source, destination|
        ancestor = File.dirname(destination)
        ancestor = File.dirname(ancestor) until File.exist?(ancestor) || File.symlink?(ancestor)
        raise Error, "Creative destination follows a symlink" unless File.realpath(ancestor) == ancestor && !File.symlink?(destination)
        FileUtils.mkdir_p(File.dirname(destination))
        FileUtils.cp(source, destination)
      end
    end
    staged.length
  rescue StandardError
    FileUtils.rm_rf(output) if output
    raise
  end
end
