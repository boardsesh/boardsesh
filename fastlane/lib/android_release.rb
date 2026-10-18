# frozen_string_literal: true

require "json"

# Owns one edit: upload once, assign both tester tracks, then submit together.
# Production is read only, and commit refuses to cancel an existing review.
module BoardseshAndroidRelease
  class Error < StandardError; end
  PACKAGE_NAME = "com.boardsesh.app"
  TESTER_TRACKS = %w[internal beta].freeze
  MAX_VERSION_CODE = 2_100_000_000

  def self.service(json_key_data:)
    require "supply"
    require "supply/client"
    raise Error, "Missing Google Play service-account JSON" if json_key_data.to_s.empty?
    credentials = JSON.parse(json_key_data)
    raise Error, "Expected a Google Play service account" unless credentials["type"] == "service_account"
    # Supply supplies authentication and the pinned Google API models, but its
    # commit wrapper can retry without sending changes for review. Call the
    # generated service directly so our strict commit parameters cannot change.
    Google::Apis.logger.level = Logger::WARN
    client = Supply::Client.make_from_config(params: { json_key_data: json_key_data, timeout: 300 })
    Google::Apis.logger.level = Logger::WARN
    service = client.client
    service.request_options.retries = 0
    service
  rescue Error
    raise
  rescue StandardError
    raise Error, "Google Play authentication failed; check the service-account credential"
  end

  def self.models(name, attributes)
    Google::Apis::AndroidpublisherV3.const_get(name).new(**attributes)
  end

  class Runner
    def initialize(service:, aab:, version_code:, version:, metadata_path:, model_factory: BoardseshAndroidRelease.method(:models))
      @service, @aab, @metadata_path, @model_factory = service, File.expand_path(aab), metadata_path, model_factory
      unless version_code.to_s.match?(/\A[1-9]\d*\z/) && version_code.to_i <= MAX_VERSION_CODE
        raise Error, "Expected Android versionCode must be a positive integer within Play's limit"
      end
      raise Error, "Expected release label must be semver" unless version.to_s.match?(/\A\d+\.\d+\.\d+\z/)
      raise Error, "Expected one existing AAB file" unless @aab.end_with?(".aab") && File.file?(@aab) && File.size(@aab).positive?
      @version_code, @version = version_code.to_i, version.to_s
      @notes = release_notes
    end

    def run
      # Resolve credentials only after local artifact/label/notes validation.
      @service = @service.call if @service.respond_to?(:call)
      unless @service.method(:commit_edit).parameters.include?([:key, :changes_in_review_behavior])
        raise Error, "Google Play API client lacks strict review protection; update the pinned client"
      end
      edit = @service.insert_edit(PACKAGE_NAME)
      edit_id = edit.id
      raise Error, "Google Play returned an invalid edit ID" unless edit_id.to_s.match?(/\A[A-Za-z0-9_-]+\z/)
      verify_track_ceilings(@service.list_edit_tracks(PACKAGE_NAME, edit_id))
      bundle = @service.upload_edit_bundle(PACKAGE_NAME, edit_id, upload_source: @aab, content_type: "application/octet-stream")
      unless bundle.version_code.to_s == @version_code.to_s
        raise Error, "Uploaded AAB versionCode differs from expected; edit was not committed"
      end
      TESTER_TRACKS.each do |track|
        release = @model_factory.call("TrackRelease", {
          name: @version, version_codes: [@version_code.to_s], status: "completed",
          release_notes: @notes.map { |note| @model_factory.call("LocalizedText", note) }
        })
        track_object = @model_factory.call("Track", { track: track, releases: [release] })
        @service.update_edit_track(PACKAGE_NAME, edit_id, track, track_object)
      end
      @service.validate_edit(PACKAGE_NAME, edit_id)
      @service.commit_edit(PACKAGE_NAME, edit_id,
        changes_not_sent_for_review: false, changes_in_review_behavior: "ERROR_IF_IN_REVIEW")
      {
        "action" => "committed", "packageName" => PACKAGE_NAME, "versionCode" => @version_code,
        "releaseLabel" => @version, "tracks" => TESTER_TRACKS, "publicationVerified" => false,
        "limitations" => [
          "Commit accepted; Google review and managed publishing may still delay publication.",
          "Release label comes from the build pipeline; embedded versionName is not independently verified here.",
          "Tester delivery must be checked with the independent release lifecycle audit."
        ]
      }
    rescue Error
      raise
    rescue StandardError => error
      status = error.respond_to?(:status_code) ? error.status_code.to_i : nil
      suffix = status && status.positive? ? " (HTTP #{status})" : ""
      raise Error, "Google Play tester upload was not confirmed#{suffix}; audit before retrying"
    end

    private

    def release_notes
      notes = Dir.glob(File.join(@metadata_path, "*", "changelogs", "default.txt")).sort.filter_map do |path|
        locale = File.basename(File.dirname(File.dirname(path)))
        next unless locale.match?(/\A[a-z]{2,3}(-[A-Za-z0-9]{2,8})*\z/)
        text = File.read(path, encoding: "UTF-8").strip
        raise Error, "Play release notes must contain 1 to 500 characters per locale" if text.empty? || text.length > 500
        { language: locale, text: text }
      end
      raise Error, "No localized Play release notes found" if notes.empty?
      notes
    end

    # Refuse a stale upload: any build Play already holds at this or a newer
    # versionCode, on any track. A release with no versionCodes holds no build
    # (Play returns those for a draft with no bundle yet, or a release whose
    # bundle has moved to another track), so it cannot make this upload stale
    # and is skipped. The first real tester upload (2026-10-18) aborted on one.
    def verify_track_ceilings(response)
      Array(response.tracks).each do |track|
        name = track.track.to_s.match?(/\A[a-z0-9:_-]{1,64}\z/i) ? track.track : "unnamed"
        Array(track.releases).each do |release|
          Array(release.version_codes).each do |code|
            unless code.to_s.match?(/\A[1-9]\d*\z/)
              raise Error, "Google Play returned an invalid versionCode on the #{name} track"
            end
            if code.to_i >= @version_code
              raise Error, "Google Play already contains this or a newer versionCode on the #{name} track; refusing a stale upload"
            end
          end
        end
      end
    end
  end
end
