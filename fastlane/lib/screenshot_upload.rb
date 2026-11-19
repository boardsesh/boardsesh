# frozen_string_literal: true

require "pathname"

module BoardseshScreenshotUpload
  class Error < StandardError; end

  ALLOWED_LOCALES = %w[en-US es-ES es-MX fr-FR de-DE it zh-Hans].freeze
  DEVICES = %w[iphone-16-pro-max iphone-16-pro ipad-pro-13-inch-m5 ipad-pro-11-inch-m5 iphone-duo].freeze
  PHONE_NAMES = %w[00-your-boards.png 01-spray-wall.png 02-more-boards.png 03-your-crew.png
                   04-on-the-wall.png 05-one-logbook.png 06-session-plan.png 07-live-activity.png 08-next-project.png].freeze
  IPAD_NAMES = %w[00-wall-kiosk.png 01-wall-status.png 02-home.png 03-discover.png 04-workout-generator.png 05-profile.png].freeze
  DUO_NAMES = %w[00-board-view.png 01-board-view-2.png 02-climbs.png 03-home.png
                 04-playlist-detail.png 05-profile.png 06-session-detail.png 07-workout-generator.png].freeze
  SIZES = {
    "iphone-16-pro-max" => [[1320, 2868], [1290, 2796]],
    "iphone-16-pro" => [[1206, 2622]],
    "ipad-pro-13-inch-m5" => [[2752, 2064], [2732, 2048]],
    "ipad-pro-11-inch-m5" => [[2266, 1488], [2420, 1668], [2388, 1668], [2360, 1640]]
  }.freeze

  def self.parse_locales(raw)
    return nil if raw.nil? || raw == ""
    locales = raw.split(",", -1).map(&:strip)
    validate_locales!(locales)
    locales
  end

  def self.validate_locales!(locales)
    unless locales.is_a?(Array) && !locales.empty? && locales.uniq == locales &&
           locales.all? { |locale| ALLOWED_LOCALES.include?(locale) }
      raise Error, "Screenshot locales must be unique Apple locale codes: #{ALLOWED_LOCALES.join(', ')}."
    end
  end

  def self.expected_names(locale, device)
    return DUO_NAMES if device == "iphone-duo"
    return IPAD_NAMES if device.start_with?("ipad-")
    PHONE_NAMES.map do |name|
      %w[it zh-Hans].include?(locale) && name == "07-live-activity.png" ? "07-session-detail.png" : name
    end
  end

  # A selected-language upload must be a complete, isolated store tree. The
  # workflow checks capture provenance/content before this second, offline gate.
  def self.manifest(root:, locales:)
    validate_locales!(locales)
    unless root.is_a?(String) && Pathname.new(root).absolute? && File.directory?(root) && !File.symlink?(root)
      raise Error, "ASC_SCREENSHOT_PATH must name an absolute, isolated screenshot directory."
    end
    actual_locales = Dir.children(root).select { |name| File.directory?(File.join(root, name)) }.sort
    unless actual_locales == locales.sort
      raise Error, "Screenshot locale folders are #{actual_locales.join(', ')}, expected only #{locales.join(', ')}."
    end
    locales.to_h do |locale|
      locale_root = File.join(root, locale)
      raise Error, "Screenshot locale must not be a symlink: #{locale}" if File.symlink?(locale_root)
      devices = Dir.children(locale_root).select { |name| File.directory?(File.join(locale_root, name)) }.sort
      raise Error, "Screenshot devices for #{locale} must include exactly #{DEVICES.join(', ')}." unless devices == DEVICES.sort
      [locale, DEVICES.to_h do |device|
        device_root = File.join(locale_root, device)
        raise Error, "Screenshot device must not be a symlink: #{locale}/#{device}" if File.symlink?(device_root)
        names = Dir.children(device_root).select { |name| name.downcase.end_with?(".png") }.sort
        unless names == expected_names(locale, device).sort
          raise Error, "Screenshot files for #{locale}/#{device} do not match the complete store campaign."
        end
        files = names.map do |name|
          path = File.join(device_root, name)
          raise Error, "Screenshot must be a regular file: #{locale}/#{device}/#{name}" unless File.file?(path) && !File.symlink?(path)
          header = File.binread(path, 24)
          unless header.bytesize == 24 && header.start_with?("\x89PNG\r\n\x1a\n".b) && header.byteslice(12, 4) == "IHDR"
            raise Error, "Screenshot is not a PNG: #{locale}/#{device}/#{name}"
          end
          dimensions = header.byteslice(16, 8).unpack("NN")
          accepted = device == "iphone-duo" ? [name.to_i < 5 ? [2853, 2007] : [1398, 2034]] : SIZES.fetch(device)
          raise Error, "Screenshot has invalid dimensions: #{locale}/#{device}/#{name}" unless accepted.include?(dimensions)
          path
        end
        [device, files]
      end]
    end
  end

  # deliver 2.241.2's sync compares every remote screenshot against local files.
  # Filter at its app/version boundary so deletion, sorting, retries and waiting
  # all see only the locales in this manifest. No process-wide patch is applied.
  # Source: fastlane/fastlane, 2.241.2, deliver/lib/deliver/sync_screenshots.rb.
  class ScopedVersion
    def initialize(version:, locales:)
      BoardseshScreenshotUpload.validate_locales!(locales)
      @version, @locales = version, locales.freeze
    end

    def version_string
      @version.version_string
    end

    def get_app_store_version_localizations
      selected = @version.get_app_store_version_localizations.select { |entry| @locales.include?(entry.locale) }
      raise Error, "App Store returned duplicate selected localizations." unless selected.map(&:locale).uniq.length == selected.length
      selected
    end

    def create_app_store_version_localization(attributes:)
      unless attributes.keys == [:locale] && @locales.include?(attributes[:locale])
        raise Error, "Refusing to create an unrequested localization or change listing text."
      end
      @version.create_app_store_version_localization(attributes: attributes)
    end
  end

  class ScopedApp
    def initialize(version:, locales:)
      @version = ScopedVersion.new(version: version, locales: locales)
    end

    def get_edit_app_store_version(platform:)
      raise Error, "Screenshot upload must target iOS." unless platform == "IOS"
      @version
    end
  end

  def self.sync(version:, locales:, screenshots:, sync_class:)
    validate_locales!(locales)
    unless screenshots.map(&:language).uniq.sort == locales.sort
      raise Error, "Loaded screenshots do not match the requested upload locales."
    end
    app = ScopedApp.new(version: version, locales: locales)
    sync_class.new(app: app, platform: "IOS").sync(screenshots)
  end
end
