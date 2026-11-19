# frozen_string_literal: true

# Uses the locked Fastlane gem, including the official action's Deliverfile
# loading and the real UploadMetadata implementation. All remote objects are
# local doubles; the test has no credentials and performs no HTTP requests.
require "tmpdir"
require "fileutils"
require "fastlane"
require "fastlane/actions/capture_ios_screenshots"
require "fastlane/actions/build_app"
require "fastlane/actions/app_store_connect_api_key"
require "fastlane/actions/upload_to_app_store"
require "deliver"

# The pinned SDK's own test-mode switch; the official action then returns the
# loaded configuration before Runner#login. We still run real UploadMetadata.
Object.const_set(:SpecHelper, Module.new) unless Object.const_defined?(:SpecHelper)

class MetadataRatingResetContractTest
  # Keep this runnable under bundle exec without adding a test framework to the
  # production Fastlane bundle. The assertion failures stop the CI contract.
  def assert(condition, message = "Contract assertion failed")
    raise message unless condition
  end

  def assert_equal(expected, actual)
    assert(expected == actual, "Expected #{expected.inspect}, got #{actual.inspect}")
  end

  def assert_nil(actual, message = "Expected nil")
    assert(actual.nil?, "#{message}; got #{actual.inspect}")
  end

  def assert_empty(actual, message = "Expected empty")
    assert(actual.empty?, "#{message}; got #{actual.inspect}")
  end

  def assert_includes(actual, expected)
    assert(actual.include?(expected), "Expected #{actual.inspect} to include #{expected.inspect}")
  end

  def assert_raises(exception_class)
    begin
      yield
    rescue exception_class => error
      return error
    end
    raise "Expected #{exception_class}"
  end
  class RemoteVersion
    attr_reader :version_string, :reset_calls, :phase_calls, :updates, :reset_present, :phase_present

    def initialize(reset_present:, phase_present:, unsupported: false)
      @reset_present, @phase_present, @unsupported = reset_present, phase_present, unsupported
      @reset_calls, @phase_calls, @updates = [], [], []
      @version_string = "2.8.0"
    end

    def update(attributes:)
      @updates << attributes
    end

    def fetch_reset_ratings_request
      @reset_calls << :get
      raise "The relationship 'resetRatingsRequest' does not exist" if @unsupported
      @reset_present ? self : nil
    end

    def create_reset_ratings_request
      @reset_calls << :post
      @reset_present = true
    end

    def delete!
      @reset_calls << :delete
      @reset_present = false
    end

    def fetch_app_store_version_phased_release
      @phase_calls << :get
      return nil unless @phase_present
      Object.new.tap do |phase|
        phase.define_singleton_method(:delete!) { raise "Must not delete the owner's phased release" }
      end
    end

    def create_app_store_version_phased_release(attributes:)
      @phase_calls << :post
      raise "Must not create a phased release"
    end
  end

  def setup
    @original_env = ENV.to_h
    ENV["FASTLANE_SKIP_UPDATE_CHECK"] = "1"
    ENV.delete("DELIVER_RESET_RATINGS")
    @directory = Dir.mktmpdir("metadata-rating-reset-contract-")
    FileUtils.mkdir_p(File.join(@directory, "fastlane"))
    FileUtils.cp(File.expand_path("../Deliverfile", __dir__), File.join(@directory, "fastlane", "Deliverfile"))
    @original_cache = Deliver.cache.dup
  end

  def teardown
    Deliver.cache.replace(@original_cache)
    ENV.replace(@original_env)
    FileUtils.remove_entry(@directory)
  end

  def action_configuration(phase_present:)
    configuration = FastlaneCore::Configuration.create(
      Fastlane::Actions::UploadToAppStoreAction.available_options,
      app_identifier: "com.boardsesh.app", metadata_path: @directory,
      skip_metadata: false, skip_screenshots: true, skip_binary_upload: true,
      skip_app_version_update: true, submit_for_review: false,
      run_precheck_before_submit: false, force: true, phased_release: phase_present,
      description: { "zh-Hans" => "与伙伴一起攀爬。" }
    )
    Dir.chdir(@directory) do
      # Official action returns its loaded config in test mode, before login.
      Fastlane::Actions::UploadToAppStoreAction.run(configuration)
    end
  end

  def upload_metadata(configuration, version)
    app = Struct.new(:id).new("fake-app")
    Deliver.cache[:app] = app
    uploaded_text = []
    localization = Struct.new(:locale).new("zh-Hans")
    localization.define_singleton_method(:update) { |attributes:| uploaded_text << attributes }
    uploader = Deliver::UploadMetadata.new(configuration)
    uploader.define_singleton_method(:detect_languages) { ["zh-Hans"] }
    uploader.define_singleton_method(:verify_available_version_languages!) { |_app, _languages| [localization] }
    uploader.define_singleton_method(:fetch_edit_app_info) { |_app| nil }
    uploader.define_singleton_method(:updating_localized_app_info?) { |_app, _info| false }
    uploader.define_singleton_method(:fetch_edit_app_store_version) { |_app, _platform| version }
    uploader.define_singleton_method(:sleep) { |_seconds| }
    %i[review_information app_clip_review_information review_attachment_file routing_app_coverage_file app_rating].each do |method|
      uploader.define_singleton_method(method) { |_resource| }
    end
    original_get_versions = Spaceship::ConnectAPI.method(:get_app_store_versions)
    begin
      Spaceship::ConnectAPI.define_singleton_method(:get_app_store_versions) { |**_arguments| [Object.new, Object.new] }
      uploader.upload
    ensure
      Spaceship::ConnectAPI.define_singleton_method(:get_app_store_versions, original_get_versions)
    end
    uploaded_text
  end

  def test_real_action_and_metadata_uploader_never_read_create_or_delete_rating_resets
    assert_equal "2.241.2", Fastlane::VERSION
    [false, true].product([false, true], [false, true]).each do |reset_present, phase_present, unsupported|
      version = RemoteVersion.new(reset_present: reset_present, phase_present: phase_present, unsupported: unsupported)
      configuration = action_configuration(phase_present: phase_present)
      assert configuration.config_file_options.key?(:reset_ratings), "Deliverfile must retain the nil key"
      assert_nil configuration[:reset_ratings], "The real configuration must not fall back to false"
      assert_equal [{ "description" => "与伙伴一起攀爬。" }], upload_metadata(configuration, version)
      assert_empty version.reset_calls, "No rating-reset GET/POST/DELETE is allowed"
      assert_equal reset_present, version.reset_present
      assert_equal [:get], version.phase_calls
      assert_equal phase_present, version.phase_present
    end
  end

  def test_plain_nil_argument_and_plain_nil_dsl_are_not_safe_preservation
    File.write(File.join(@directory, "fastlane", "Deliverfile"), "reset_ratings nil\n")
    configuration = action_configuration(phase_present: false)
    assert_equal false, configuration[:reset_ratings]
    File.delete(File.join(@directory, "fastlane", "Deliverfile"))
    configuration = action_configuration(phase_present: false)
    configuration[:reset_ratings] = nil
    assert_equal false, configuration[:reset_ratings]
  end

  def test_environment_overrides_are_blocked_by_the_actual_lane_before_authentication
    source = File.read(File.expand_path("../Fastfile", __dir__))
    ["true", "false", "1", "0", ""].each do |override|
      ENV["DELIVER_RESET_RATINGS"] = override
      authentication_calls = []
      lanes = {}
      dsl = Module.new
      dsl.const_set(:UI, FastlaneCore::UI)
      dsl.define_singleton_method(:opt_out_usage) {}
      dsl.define_singleton_method(:default_platform) { |_platform| }
      dsl.define_singleton_method(:desc) { |_description| }
      current_platform = nil
      dsl.define_singleton_method(:platform) { |platform, &block| current_platform = platform; block.call }
      dsl.define_singleton_method(:lane) { |name, &block| lanes[[current_platform, name]] = block }
      dsl.define_singleton_method(:app_store_connect_api_key) { |**_options| authentication_calls << :called }
      dsl.module_eval(source, File.expand_path("../Fastfile", __dir__))
      dsl.extend(dsl)
      error = assert_raises(FastlaneCore::Interface::FastlaneError) { lanes.fetch([:ios, :metadata]).call({}) }
      assert_includes error.message, "Remove DELIVER_RESET_RATINGS"
      assert_empty authentication_calls
    end
  end
end

contract = MetadataRatingResetContractTest.new
tests = contract.public_methods.grep(/^test_/).sort
tests.each do |name|
  begin
    contract.setup
    contract.public_send(name)
  ensure
    contract.teardown
  end
end
puts "#{tests.length} real Fastlane rating-reset contracts passed; no store requests performed."
