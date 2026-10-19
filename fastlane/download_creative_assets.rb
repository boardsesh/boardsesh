# frozen_string_literal: true

require "json"
require_relative "lib/creative_download"

root = File.expand_path("..", __dir__)
manifest = JSON.parse(File.read(File.join(root, "app-stores", "apple", "creative-assets.json")))
BoardseshCreativeDownload.download(manifest: manifest, root: root,
  variant: ENV.fetch("CREATIVE_VARIANT", "all"), placement: ENV.fetch("CREATIVE_PLACEMENT", "all"))
