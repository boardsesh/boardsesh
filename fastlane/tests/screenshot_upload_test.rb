# frozen_string_literal: true

require "minitest/autorun"
require "tmpdir"
require "fileutils"
require_relative "../lib/screenshot_upload"

class ScreenshotUploadTest < Minitest::Test
  Screenshot = Struct.new(:language, :path)
  Localization = Struct.new(:locale, :screenshots)

  class Version
    attr_reader :version_string, :created

    def initialize(localizations)
      @version_string = "2.8.0"
      @localizations, @created = localizations, []
    end

    def get_app_store_version_localizations
      @localizations
    end

    def create_app_store_version_localization(attributes:)
      @created << attributes
      @localizations << Localization.new(attributes.fetch(:locale), [])
    end
  end

  # Exercise the same app/version boundary used by pinned deliver's sync: it
  # compares ALL returned remote images, then sorts ALL returned remote sets.
  class Sync
    class << self
      attr_accessor :visited_locales, :seen_version
    end

    def initialize(app:, platform:)
      @app, @platform = app, platform
    end

    def sync(screenshots)
      version = @app.get_edit_app_store_version(platform: @platform)
      self.class.seen_version = version.version_string
      existing = version.get_app_store_version_localizations
      (screenshots.map(&:language).uniq - existing.map(&:locale)).each do |locale|
        version.create_app_store_version_localization(attributes: { locale: locale })
      end
      self.class.visited_locales = []
      version.get_app_store_version_localizations.each do |localization|
        self.class.visited_locales << localization.locale
        # A global view here would clear other locales, just like deliver's
        # remote-minus-local calculation would when no local images exist.
        localization.screenshots.replace(screenshots.select { |screenshot| screenshot.language == localization.locale }.map(&:path).sort)
      end
    end
  end

  def setup
    @root = Dir.mktmpdir("scoped-screenshot-upload-")
    Sync.visited_locales, Sync.seen_version = nil, nil
  end

  def teardown
    FileUtils.remove_entry(@root)
  end

  def write_chinese_tree
    BoardseshScreenshotUpload::DEVICES.each do |device|
      directory = File.join(@root, "zh-Hans", device)
      FileUtils.mkdir_p(directory)
      BoardseshScreenshotUpload.expected_names("zh-Hans", device).each do |name|
        dimensions = if device == "iphone-duo"
          name.to_i < 5 ? [2853, 2007] : [1398, 2034]
        else
          BoardseshScreenshotUpload::SIZES.fetch(device).first
        end
        header = "\x89PNG\r\n\x1a\n".b + [13].pack("N") + "IHDR" + dimensions.pack("NN")
        File.binwrite(File.join(directory, name), header)
      end
    end
  end

  def chinese_manifest
    BoardseshScreenshotUpload.manifest(root: @root, locales: ["zh-Hans"])
  end

  def test_parses_only_unique_supported_apple_locale_codes
    assert_nil BoardseshScreenshotUpload.parse_locales(nil)
    assert_nil BoardseshScreenshotUpload.parse_locales("")
    assert_equal ["zh-Hans", "fr-FR"], BoardseshScreenshotUpload.parse_locales(" zh-Hans,fr-FR ")
    ["zh-CN", "zh-Hans,", ",zh-Hans", " ", "zh-Hans,zh-Hans", "zh-Hans,en-XX", "../en-US"].each do |invalid|
      assert_raises(BoardseshScreenshotUpload::Error, invalid) { BoardseshScreenshotUpload.parse_locales(invalid) }
    end
  end

  def test_requires_an_absolute_isolated_path_and_explicit_scope
    [nil, "", "relative/path", File.join(@root, "missing")].each do |path|
      assert_raises(BoardseshScreenshotUpload::Error) do
        BoardseshScreenshotUpload.manifest(root: path, locales: ["zh-Hans"])
      end
    end
    assert_raises(BoardseshScreenshotUpload::Error) { BoardseshScreenshotUpload.manifest(root: @root, locales: []) }
  end

  def test_accepts_only_the_complete_chinese_five_device_campaign
    write_chinese_tree
    manifest = chinese_manifest
    assert_equal ["zh-Hans"], manifest.keys
    assert_equal 38, manifest.fetch("zh-Hans").values.sum(&:length)
    assert_equal BoardseshScreenshotUpload::DEVICES.sort, manifest.fetch("zh-Hans").keys.sort
    %w[iphone-16-pro-max iphone-16-pro].each do |device|
      assert_includes manifest.fetch("zh-Hans").fetch(device).map { |path| File.basename(path) }, "07-session-detail.png"
    end
  end

  def test_rejects_any_unrequested_locale_directory
    write_chinese_tree
    FileUtils.mkdir_p(File.join(@root, "en-US"))
    assert_raises(BoardseshScreenshotUpload::Error) { chinese_manifest }
  end

  def test_rejects_missing_or_unexpected_devices
    write_chinese_tree
    FileUtils.mv(File.join(@root, "zh-Hans", "iphone-duo"), File.join(@root, "zh-Hans", "unexpected-phone"))
    assert_raises(BoardseshScreenshotUpload::Error) { chinese_manifest }
    FileUtils.rm_rf(File.join(@root, "zh-Hans", "unexpected-phone"))
    assert_raises(BoardseshScreenshotUpload::Error) { chinese_manifest }
  end

  def test_rejects_missing_extra_or_wrong_language_phone_images
    write_chinese_tree
    phone = File.join(@root, "zh-Hans", "iphone-16-pro")
    session = File.join(phone, "07-session-detail.png")
    bytes = File.binread(session)
    FileUtils.rm(session)
    assert_raises(BoardseshScreenshotUpload::Error) { chinese_manifest }
    File.binwrite(session, bytes)
    File.binwrite(File.join(phone, "07-live-activity.png"), bytes)
    assert_raises(BoardseshScreenshotUpload::Error) { chinese_manifest }
    FileUtils.rm(session)
    assert_raises(BoardseshScreenshotUpload::Error) { chinese_manifest }
  end

  def test_rejects_wrong_device_dimensions_or_non_png_data
    write_chinese_tree
    screenshot = File.join(@root, "zh-Hans", "iphone-16-pro", "00-your-boards.png")
    header = File.binread(screenshot)
    File.binwrite(screenshot, header.byteslice(0, 16) + [1320, 2868].pack("NN"))
    assert_raises(BoardseshScreenshotUpload::Error) { chinese_manifest }
    File.write(screenshot, "not an image")
    assert_raises(BoardseshScreenshotUpload::Error) { chinese_manifest }
  end

  def test_rejects_symlinked_upload_files
    write_chinese_tree
    screenshot = File.join(@root, "zh-Hans", "iphone-16-pro", "00-your-boards.png")
    external = File.join(@root, "external.png")
    FileUtils.mv(screenshot, external)
    File.symlink(external, screenshot)
    assert_raises(BoardseshScreenshotUpload::Error) { chinese_manifest }
  end

  def test_chinese_upload_leaves_english_and_french_remote_images_untouched
    english = Localization.new("en-US", ["english-z", "english-a"])
    french = Localization.new("fr-FR", ["french-z", "french-a"])
    chinese = Localization.new("zh-Hans", ["old-chinese"])
    version = Version.new([english, french, chinese])
    BoardseshScreenshotUpload.sync(version: version, locales: ["zh-Hans"],
      screenshots: [Screenshot.new("zh-Hans", "new-chinese")], sync_class: Sync)
    assert_equal ["english-z", "english-a"], english.screenshots
    assert_equal ["french-z", "french-a"], french.screenshots
    assert_equal ["new-chinese"], chinese.screenshots
    assert_equal ["zh-Hans"], Sync.visited_locales
    assert_equal "2.8.0", Sync.seen_version
    assert_empty version.created
  end

  def test_default_six_locale_upload_preserves_existing_remote_chinese
    default_locales = %w[en-US es-ES es-MX fr-FR de-DE it]
    defaults = default_locales.map { |locale| Localization.new(locale, ["old-#{locale}"]) }
    chinese = Localization.new("zh-Hans", ["chinese-z", "chinese-a"])
    version = Version.new(defaults + [chinese])
    screenshots = default_locales.map { |locale| Screenshot.new(locale, "new-#{locale}") }
    BoardseshScreenshotUpload.sync(version: version, locales: default_locales, screenshots: screenshots, sync_class: Sync)
    assert_equal ["chinese-z", "chinese-a"], chinese.screenshots
    assert_equal default_locales, Sync.visited_locales
    defaults.each { |localization| assert_equal ["new-#{localization.locale}"], localization.screenshots }
  end

  def test_creates_only_the_requested_missing_localization_without_listing_text
    english = Localization.new("en-US", ["english"])
    version = Version.new([english])
    BoardseshScreenshotUpload.sync(version: version, locales: ["zh-Hans"],
      screenshots: [Screenshot.new("zh-Hans", "chinese")], sync_class: Sync)
    assert_equal [{ locale: "zh-Hans" }], version.created
    assert_equal ["english"], english.screenshots
    assert_equal ["zh-Hans"], Sync.visited_locales
  end

  def test_rejects_unexpected_local_screenshot_languages_before_starting_sync
    version = Version.new([])
    assert_raises(BoardseshScreenshotUpload::Error) do
      BoardseshScreenshotUpload.sync(version: version, locales: ["zh-Hans"],
        screenshots: [Screenshot.new("en-US", "unexpected")], sync_class: Sync)
    end
    assert_nil Sync.visited_locales
    assert_empty version.created
  end

  def test_scoped_version_refuses_other_locale_creation_and_listing_text_changes
    version = Version.new([])
    scoped = BoardseshScreenshotUpload::ScopedVersion.new(version: version, locales: ["zh-Hans"])
    [{ locale: "en-US" }, { locale: "zh-Hans", description: "invented copy" }].each do |attributes|
      assert_raises(BoardseshScreenshotUpload::Error) { scoped.create_app_store_version_localization(attributes: attributes) }
    end
    assert_empty version.created
  end

  def test_rejects_duplicate_selected_remote_localizations
    version = Version.new([Localization.new("zh-Hans", []), Localization.new("zh-Hans", [])])
    scoped = BoardseshScreenshotUpload::ScopedVersion.new(version: version, locales: ["zh-Hans"])
    assert_raises(BoardseshScreenshotUpload::Error) { scoped.get_app_store_version_localizations }
  end

  def test_scoped_app_exposes_only_the_pinned_ios_version
    version = Version.new([])
    app = BoardseshScreenshotUpload::ScopedApp.new(version: version, locales: ["zh-Hans"])
    assert_equal "2.8.0", app.get_edit_app_store_version(platform: "IOS").version_string
    assert_raises(BoardseshScreenshotUpload::Error) { app.get_edit_app_store_version(platform: "MAC_OS") }
    refute_respond_to app.get_edit_app_store_version(platform: "IOS"), :update
  end
end
