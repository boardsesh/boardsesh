# frozen_string_literal: true

require_relative "store_review_submission"
require_relative "app_store_version_states"

# Where one exact iOS candidate stands for manual public-store submission
# (mobile-store-submit.yml). Pure: it classifies the app's
# appStoreVersions as App Store Connect returned them; the caller does the GET.
#
#   pending     nothing blocks a submission; the draft and submit jobs may run.
#               needsDraft says whether the draft lane must run first: it must
#               when the version is missing or in Prepare for Submission, and must
#               not once it sits in a review draft (READY_FOR_REVIEW), because
#               deliver cannot see that state and would try to create the version
#               again. The review helper resumes such a draft instead.
#   done        already submitted, approved or released; nothing to do
#   deferred    another version is in App Review, or approved and not released
#               yet; retry once it moves on
#   blocked     a person has to act (a rejection, a version pulled from review,
#               another version being prepared, or a state this does not know)
#   superseded  a newer version exists; submitting this one would go backwards
#
# Which other versions hold this one comes from BoardseshAppStoreVersionStates,
# the list the iOS draft lane refuses on, so a version the draft would refuse is
# never reported as pending.
module BoardseshStoreSubmissionStatus
  Error = BoardseshStoreReview::Error
  STATES = BoardseshAppStoreVersionStates
  # A rejection, a version a person pulled from review, or a broken binary: the
  # review helper refuses these, and resubmitting them unattended every hour
  # would fight whoever is handling it.
  NEEDS_PERSON = STATES::NEEDS_PERSON
  DONE = (BoardseshStoreReview::SUBMITTED + %w[REPLACED_WITH_NEW_VERSION]).freeze
  BUILD_BOUND_STATES = (DONE + %w[READY_FOR_REVIEW]).freeze

  def self.semver(version)
    raise Error, "Expected iOS version must be semver" unless version.is_a?(String) && version.match?(/\A\d+\.\d+\.\d+\z/)
    version.split(".").map(&:to_i)
  end

  def self.describe(versions)
    versions.map { |entry| "#{entry.fetch('versionString')} (#{entry.fetch('state')})" }.join(", ")
  end

  def self.ios(app_store_versions, version, expected_build: nil, attached_build: nil)
    wanted = semver(version)
    if expected_build && (!expected_build.is_a?(String) || !expected_build.match?(/\A[1-9]\d*\z/))
      raise Error, "Expected iOS build must be a positive build number"
    end
    versions = app_store_versions.filter_map do |resource|
      attributes = resource.fetch("attributes", {})
      next unless resource["type"] == "appStoreVersions" && attributes["platform"] == "IOS"
      version_string = attributes["versionString"]
      next unless version_string.is_a?(String) && version_string.match?(/\A\d+(?:\.\d+){0,2}\z/)
      { "id" => resource["id"], "versionString" => version_string, "state" => attributes["appVersionState"] || attributes["appStoreState"] }
    end
    targets = versions.select { |entry| entry.fetch("versionString") == version }
    raise Error, "App Store Connect lists #{targets.length} iOS #{version} versions; inspect it by hand" if targets.length > 1
    target = targets.first
    others = versions - targets
    # Numeric compare, so "2.10.0" is newer than "2.9.0"; a short "2.7" pads to 2.7.0.
    numbers = ->(entry) { (entry.fetch("versionString").split(".").map(&:to_i) + [0, 0])[0, 3] }
    newer = others.select { |entry| (numbers.call(entry) <=> wanted) == 1 }
    in_group = ->(states) { others.select { |entry| states.include?(entry.fetch("state")) } }
    in_review = in_group.call(STATES::IN_REVIEW)
    approved = in_group.call(STATES::APPROVED_UNRELEASED)
    other_needs_person = in_group.call(STATES::NEEDS_PERSON)
    other_editable = in_group.call(STATES::EDITABLE)
    state = target && target.fetch("state")
    result = lambda do |status, reason|
      { "platform" => "ios", "version" => version, "status" => status, "state" => state, "versionId" => target && target["id"],
        "needsDraft" => status == "pending" && (target.nil? || state == "PREPARE_FOR_SUBMISSION"), "reason" => reason }
    end

    if expected_build && BUILD_BOUND_STATES.include?(state)
      exact_build = attached_build.is_a?(Hash) && target["id"].is_a?(String) && !target["id"].empty? &&
        attached_build["versionId"] == target["id"] && attached_build["buildNumber"] == expected_build &&
        attached_build["marketingVersion"] == version && attached_build["platform"] == "IOS"
      unless exact_build
        return result.call("blocked", "iOS #{version} is #{state} but does not have the exact requested build #{expected_build} attached; inspect App Store Connect before submitting this candidate.")
      end
    end

    return result.call("done", "iOS #{version} is already #{state}; nothing to submit.") if DONE.include?(state)
    if newer.any?
      return result.call("superseded", "App Store Connect already has a newer iOS version, #{describe(newer)}; not submitting #{version}.")
    end
    if NEEDS_PERSON.include?(state)
      return result.call("blocked", "iOS #{version} is #{state}; the automatic submission never resubmits it. Fix and resubmit it in App Store Connect.")
    end
    if in_review.any?
      return result.call("deferred", "Apple is reviewing #{describe(in_review)} and reviews one app version at a time; the next run retries once that review ends.")
    end
    if approved.any?
      return result.call("deferred", "#{describe(approved)} is approved and not released yet, and App Store Connect opens the next version only after that; the next run retries once it is released.")
    end
    if other_needs_person.any?
      return result.call("blocked", "#{describe(other_needs_person)} is open in App Store Connect and needs a person; #{version} waits until it is fixed and resubmitted there.")
    end
    if other_editable.any?
      return result.call("blocked", "#{describe(other_editable)} is being prepared in App Store Connect, and the draft lane will not rename it to #{version}. Submit it, or rename it to #{version} there.")
    end
    return result.call("pending", "No iOS #{version} version yet; the draft job creates it.") if target.nil?
    if state == "READY_FOR_REVIEW"
      return result.call("pending", "iOS #{version} is already in a review draft (READY_FOR_REVIEW); the submission resumes it.")
    end
    return result.call("pending", "iOS #{version} is #{state} and can be submitted.") if BoardseshStoreReview::EDITABLE.include?(state)
    result.call("blocked", "iOS #{version} is in a state this automation does not handle (#{state.inspect}); inspect it in App Store Connect.")
  end
end
