# frozen_string_literal: true

# Keep distribution separate from the Xcode upload: a processing delay can be
# retried without rebuilding or uploading the signed archive again.
module BoardseshTestflightDistribution
  APP_IDENTIFIER = "com.boardsesh.app"
  GROUP_NAME = "Discord Users"
  MAX_NOTES_BYTES = 4_000
  READY_STATES = %w[READY_FOR_BETA_TESTING IN_BETA_TESTING].freeze
  REVIEW_STATES = %w[WAITING_FOR_BETA_REVIEW IN_BETA_REVIEW].freeze
  REFUSED_STATES = %w[BETA_REJECTED EXPIRED PROCESSING_EXCEPTION].freeze

  class Error < StandardError; end

  def self.read_notes(notes_path, root:)
    raise Error, "Missing TestFlight notes path" if notes_path.to_s.empty?
    File.binread(File.expand_path(notes_path, root)).force_encoding(Encoding::UTF_8)
  rescue SystemCallError => error
    raise Error, "Could not read TestFlight notes: #{error.message}"
  end

  def self.validate_inputs!(version:, build_number:, notes:)
    raise Error, "Expected iOS version must be semver" unless version.match?(/\A\d+\.\d+\.\d+\z/)
    raise Error, "Expected iOS build must be a positive integer" unless build_number.match?(/\A[1-9]\d*\z/)
    raise Error, "TestFlight notes must be valid UTF-8" unless notes.encoding == Encoding::UTF_8 && notes.valid_encoding?
    raise Error, "TestFlight notes must not be empty" if notes.strip.empty?
    raise Error, "TestFlight notes exceed #{MAX_NOTES_BYTES} bytes" if notes.bytesize > MAX_NOTES_BYTES
  end

  def self.summary(receipt)
    identity = "TestFlight #{receipt.fetch('version')} (#{receipt.fetch('buildNumber')})"
    case receipt.fetch("status")
    when "ready-for-testing"
      "#{identity} is ready for the #{receipt.fetch('groupName')} tester group."
    when "pending-beta-review"
      "#{identity} is assigned to #{receipt.fetch('groupName')}; Apple beta review is pending."
    when "approved-awaiting-availability"
      "#{identity} is assigned to #{receipt.fetch('groupName')}; Apple approved beta review and availability is pending."
    else
      raise Error, "Unknown TestFlight distribution summary status: #{receipt.fetch('status').inspect}"
    end
  end

  class Runner
    def initialize(app:, version:, build_number:, notes:, find_builds:, distribute:)
      BoardseshTestflightDistribution.validate_inputs!(version: version, build_number: build_number, notes: notes)
      raise Error, "Boardsesh app not found on App Store Connect" unless app && app.bundle_id == APP_IDENTIFIER && !app.id.to_s.empty?
      @app, @version, @build_number, @notes = app, version, build_number, notes
      @find_builds, @distribute = find_builds, distribute
    end

    def run
      groups = @app.get_beta_groups
      matches = groups.select { |group| group.name.to_s.casecmp?(GROUP_NAME) }
      unless matches.length == 1
        available = groups.map do |group|
          "#{group.name.inspect} (id: #{group.id.inspect}, internal: #{group.is_internal_group.inspect})"
        end
        raise Error, "Expected exactly one existing TestFlight group named #{GROUP_NAME.inspect} (case-insensitive); " \
          "found #{matches.length}. Available groups: #{available.empty? ? '(none)' : available.join('; ')}"
      end
      group = matches.first
      raise Error, "TestFlight group #{group.name.inspect} must be external" unless group.is_internal_group == false
      raise Error, "TestFlight group has no identity" if group.id.to_s.empty?

      before = exact_build(allow_missing: true)
      assigned = before && assigned?(group, before.id)
      # A completed first attempt may have lost its response. Read the existing
      # assignment before invoking Pilot again, so retries send no second notice.
      if assigned && before.processing_state == "VALID" && completed_state?(external_state(before))
        return receipt(before, group, "already-assigned", notification_requested: false)
      end

      @distribute.call(
        app_identifier: APP_IDENTIFIER,
        app_platform: "ios",
        app_version: @version,
        build_number: @build_number,
        changelog: @notes,
        distribute_only: true,
        distribute_external: true,
        groups: [group.id],
        submit_beta_review: true,
        notify_external_testers: true,
        skip_submission: false,
        skip_waiting_for_build_processing: false,
        wait_processing_interval: 30,
        wait_processing_timeout_duration: 45 * 60,
        expire_previous_builds: false,
        reject_build_waiting_for_review: false
      )

      # Pilot returns a log message, not a build. It also silently ignores an
      # unknown group, so independently verify both identity and assignment.
      after = exact_build(require_processed: true)
      if before && after.id != before.id
        raise Error, "TestFlight build identity changed during distribution; inspect the exact build before retrying"
      end
      raise Error, "Exact TestFlight build is not assigned to #{group.name.inspect}; rerun to recheck" unless assigned?(group, after.id)
      receipt(after, group, "assigned", notification_requested: true)
    end

    private

    def exact_build(allow_missing: false, require_processed: false)
      builds = @find_builds.call
      return nil if allow_missing && builds.empty?
      raise Error, "Expected exactly one TestFlight build #{@version} (#{@build_number})" unless builds.length == 1
      build = builds.first
      unless build.app_id == @app.id && build.bundle_id == APP_IDENTIFIER && build.platform == "IOS" &&
          build.app_version == @version && build.version == @build_number && !build.id.to_s.empty?
        raise Error, "App Store Connect returned a different app, platform, version, or build; refusing distribution"
      end
      if build.expired || %w[FAILED INVALID].include?(build.processing_state) || REFUSED_STATES.include?(external_state(build))
        raise Error, "Exact TestFlight build is expired, invalid, or rejected; inspect it in App Store Connect"
      end
      if require_processed && build.processing_state != "VALID"
        raise Error, "Exact TestFlight build has not finished Apple processing; rerun to recheck"
      end
      build
    end

    def external_state(build)
      build.build_beta_detail&.external_build_state
    end

    def assigned?(group, build_id)
      group.fetch_builds.any? { |build| build.id == build_id }
    end

    def completed_state?(state)
      # An assignment alone does not confirm beta review or availability. Keep
      # this allowlist strict: a new Apple state must fail verification below
      # until we can describe it accurately, rather than report testers ready.
      READY_STATES.include?(state) || REVIEW_STATES.include?(state) || state == "BETA_APPROVED"
    end

    def receipt(build, group, action, notification_requested:)
      state = external_state(build)
      status = if READY_STATES.include?(state)
        "ready-for-testing"
      elsif REVIEW_STATES.include?(state)
        "pending-beta-review"
      elsif state == "BETA_APPROVED"
        "approved-awaiting-availability"
      else
        raise Error, "TestFlight group is assigned but beta review/testing state is #{state.inspect}; rerun to recheck"
      end
      {
        "version" => @version, "buildNumber" => @build_number, "buildId" => build.id,
        "groupId" => group.id, "groupName" => group.name, "action" => action,
        "status" => status, "externalBuildState" => state, "notificationRequested" => notification_requested
      }
    end
  end
end
