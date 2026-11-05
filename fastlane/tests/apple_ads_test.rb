# frozen_string_literal: true

require "minitest/autorun"

class AppleAdsLaneTest < Minitest::Test
  module FakeUI
    def self.user_error!(message)
      raise ArgumentError, message
    end
  end

  def setup
    @runner = Object.new
    @commands = []
    captured_commands = @commands
    @runner.define_singleton_method(:sh) { |*arguments| captured_commands << [Dir.pwd, arguments] }
    root = File.expand_path("../..", __dir__)
    lane = File.read(File.join(root, "fastlane", "Fastfile")).match(/  lane :ads do \|options\|\n(.*?)\n  end/m)[1]
    @runner.instance_variable_set(:@lane, lane)
    @runner.define_singleton_method(:run) do |options|
      binding_context = binding
      eval(@lane, binding_context)
    end
    @previous_ui = Object.const_get(:UI) if Object.const_defined?(:UI)
    Object.send(:remove_const, :UI) if Object.const_defined?(:UI)
    Object.const_set(:UI, FakeUI)
    @created_root = !Object.const_defined?(:REPO_ROOT)
    Object.const_set(:REPO_ROOT, root) if @created_root
  end

  def teardown
    Object.send(:remove_const, :UI)
    Object.const_set(:UI, @previous_ui) if @previous_ui
    Object.send(:remove_const, :REPO_ROOT) if @created_root
  end

  def test_defaults_to_read_only_plan_from_repository_root
    @runner.run({})
    cwd, command = @commands.fetch(0)
    assert_equal REPO_ROOT, cwd
    assert_equal %w[vp exec node --import tsx], command.take(5)
    assert_equal "plan", command[command.index("--action") + 1]
    assert_equal File.join(REPO_ROOT, "app-stores/apple/ads.json"), command[command.index("--config") + 1]
  end

  def test_offline_apply_and_unknown_actions_never_launch
    assert_raises(ArgumentError) { @runner.run(action: "apply", offline: true) }
    assert_raises(ArgumentError) { @runner.run(action: "delete") }
    assert_empty @commands
  end

  def test_paths_are_passed_as_arguments_without_shell_interpolation
    @runner.run(action: "plan", offline: "true", config: "ads config.json", output: "report with spaces.json")
    command = @commands.fetch(0)[1]
    assert_includes command, "--offline"
    assert_includes command, File.join(REPO_ROOT, "ads config.json")
    assert_includes command, File.join(REPO_ROOT, "report with spaces.json")
  end
end
