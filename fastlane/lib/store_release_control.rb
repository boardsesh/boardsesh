# frozen_string_literal: true

require "time"
require_relative "asc_client"

# Apple documents releaseType: MANUAL in AppStoreVersionUpdateRequest.Data.Attributes.
# This helper never submits a review or releases an approved app.
module BoardseshStoreReleaseControl
  class Error < StandardError; end
  APP_IDENTIFIER = "com.boardsesh.app"
  EDITABLE = %w[PREPARE_FOR_SUBMISSION READY_FOR_REVIEW].freeze

  class Client < BoardseshASC::Client
    def request(method, path, body = nil)
      raise Error, "Release control reads must use GET" unless method == "GET" && body.nil?
      super
    end

    # Construct the only permitted write here. Do not use the shared client's
    # retrying PATCH implementation, even when the response outcome is ambiguous.
    def make_manual(version_id)
      raise Error, "Invalid app version resource ID" unless version_id.match?(/\A[A-Za-z0-9-]+\z/)
      uri = URI("#{ORIGIN}/v1/appStoreVersions/#{version_id}")
      http = @transport.call(uri)
      http.use_ssl = true
      http.open_timeout, http.read_timeout = 30, 120
      http.max_retries = 0
      request = Net::HTTP::Patch.new(uri, { "Authorization" => "Bearer #{@token.call}", "Content-Type" => "application/json" })
      request.body = JSON.generate({ "data" => {
        "type" => "appStoreVersions", "id" => version_id,
        "attributes" => { "releaseType" => "MANUAL" }
      } })
      response = http.request(request)
      unless response.code.to_i.between?(200, 299)
        raise Error, "Manual release write not confirmed (HTTP #{response.code.to_i}); audit before retrying"
      end
      # The independent GET readback, not the PATCH body, proves the outcome.
      nil
    rescue Net::OpenTimeout, Net::ReadTimeout, IOError, SystemCallError => error
      raise Error, "Manual release write outcome is ambiguous (#{error.class}); audit before retrying"
    end
  end

  class Runner
    attr_reader :receipt

    def initialize(client:, version:, build_number:)
      raise Error, "Expected iOS version must be semver" unless version.match?(/\A\d+\.\d+\.\d+\z/)
      raise Error, "Expected build must be numeric" unless build_number.match?(/\A[1-9]\d*\z/)
      @client, @version, @build_number = client, version, build_number
      @receipt = { "schemaVersion" => 1, "appIdentifier" => APP_IDENTIFIER, "expectedVersion" => version,
        "expectedBuild" => build_number, "writeAttempted" => false, "status" => "checking" }
    end

    def run
      initial = read_snapshot
      @receipt["before"] = initial
      fresh = read_snapshot
      raise Error, "Release identity or settings changed during preflight; no write attempted" unless fresh == initial
      verify_binding(fresh)
      if fresh.dig("version", "releaseType") == "MANUAL"
        return verified_receipt("already-manual", fresh)
      end
      @receipt["writeAttempted"] = true
      @client.make_manual(fresh.fetch("version").fetch("id"))
      expected = Marshal.load(Marshal.dump(fresh))
      expected.fetch("version")["releaseType"] = "MANUAL"
      readback = read_snapshot
      @receipt["readback"] = readback
      raise Error, "Manual release readback differs from the exact expected release; audit before retrying" unless readback == expected
      verify_binding(readback)
      verified_receipt("set-manual", readback)
    rescue StandardError => error
      @receipt["status"] = @receipt["writeAttempted"] ? "outcome-unconfirmed" : "failed-before-write"
      @receipt["error"] = if error.is_a?(Error) || error.is_a?(BoardseshASC::Error)
        error.message
      else
        "Release control failed (#{error.class}); audit before retrying"
      end
      raise Error, @receipt.fetch("error")
    end

    private

    def resource_id(resource)
      id = resource.fetch("id")
      raise Error, "Invalid Apple resource identity" unless id.is_a?(String) && id.match?(/\A[A-Za-z0-9-]+\z/)
      id
    end

    def exactly_one(resources, label)
      raise Error, "Expected exactly one #{label}" unless resources.length == 1
      resources.first
    end

    def included(response, type, id)
      exactly_one(response.fetch("included").select { |resource| resource["type"] == type && resource["id"] == id }, "included #{type} resource")
    end

    def binding(version_id)
      response = @client.request("GET", "/v1/appStoreVersions/#{version_id}?include=app,build")
      version = response.fetch("data")
      raise Error, "App version resource identity changed" unless version["type"] == "appStoreVersions" && resource_id(version) == version_id
      attributes = version.fetch("attributes")
      state = attributes["appVersionState"] || attributes["appStoreState"]
      unless attributes["versionString"] == @version && attributes["platform"] == "IOS" && EDITABLE.include?(state)
        raise Error, "Expected exact editable iOS release before manual release control"
      end
      raise Error, "Unsupported release type; inspect scheduled release settings" unless %w[MANUAL AFTER_APPROVAL].include?(attributes["releaseType"])
      app_link = version.dig("relationships", "app", "data")
      build_link = version.dig("relationships", "build", "data")
      raise Error, "Missing version app/build relationships" unless app_link.is_a?(Hash) && app_link["type"] == "apps" && build_link.is_a?(Hash) && build_link["type"] == "builds"
      app = included(response, "apps", resource_id(app_link))
      build = included(response, "builds", resource_id(build_link))
      raise Error, "Version belongs to another app" unless app.dig("attributes", "bundleId") == APP_IDENTIFIER
      build_attributes = build.fetch("attributes")
      unless build_attributes["version"] == @build_number && build_attributes["processingState"] == "VALID" && build_attributes["expired"] == false
        raise Error, "Expected attached build is missing, invalid, or expired"
      end
      {
        "app" => { "id" => resource_id(app), "bundleId" => APP_IDENTIFIER },
        "version" => { "id" => version_id, "versionString" => @version, "platform" => "IOS", "state" => state,
          "releaseType" => attributes.fetch("releaseType"), "earliestReleaseDate" => attributes["earliestReleaseDate"] },
        "build" => { "id" => resource_id(build) }.merge(build_attributes.slice("version", "processingState", "expired"))
      }
    end

    def read_snapshot
      apps = @client.list("/v1/apps?filter[bundleId]=#{APP_IDENTIFIER}&limit=200")
      app = exactly_one(apps.select { |entry| entry["type"] == "apps" && entry.dig("attributes", "bundleId") == APP_IDENTIFIER }, "Boardsesh app")
      app_id = resource_id(app)
      versions = @client.list("/v1/apps/#{app_id}/appStoreVersions?filter[platform]=IOS&filter[versionString]=#{@version}&limit=200")
      version = exactly_one(versions.select { |entry| entry["type"] == "appStoreVersions" && entry.dig("attributes", "platform") == "IOS" && entry.dig("attributes", "versionString") == @version }, "matching iOS version")
      snapshot = binding(resource_id(version))
      raise Error, "Resolved app identity changed" unless snapshot.dig("app", "id") == app_id
      prerelease = @client.request("GET", "/v1/builds/#{snapshot.fetch('build').fetch('id')}/preReleaseVersion").fetch("data")
      unless prerelease && prerelease["type"] == "preReleaseVersions" && prerelease.dig("attributes", "version") == @version && prerelease.dig("attributes", "platform") == "IOS"
        raise Error, "Attached build belongs to another prerelease version"
      end
      snapshot["preReleaseVersion"] = { "id" => resource_id(prerelease), "version" => @version, "platform" => "IOS" }
      snapshot
    end

    # Last read before PATCH/no-op/verified receipt. Includes current app identity,
    # attached build identity/validity, state, and release settings in one response.
    def verify_binding(snapshot)
      raise Error, "Current app/build binding or release settings changed" unless binding(snapshot.fetch("version").fetch("id")) == snapshot.reject { |key, _entry| key == "preReleaseVersion" }
    end

    def verified_receipt(action, snapshot)
      @receipt.merge!("action" => action, "status" => "verified", "verifiedAt" => Time.now.utc.iso8601, "readback" => snapshot)
    end
  end

  def self.cli
    output = ENV.fetch("STORE_RELEASE_CONTROL_OUTPUT")
    runner = nil
    begin
      require "spaceship"
      token = Spaceship::ConnectAPI::Token.create(
        key_id: ENV.fetch("APP_STORE_CONNECT_API_KEY_ID"), issuer_id: ENV.fetch("APP_STORE_CONNECT_ISSUER_ID"),
        filepath: ENV.fetch("ASC_KEY_PATH"), in_house: false
      )
      client = Client.new(token: -> { token.refresh! if token.expired?; token.text })
      runner = Runner.new(client: client, version: ENV.fetch("RELEASE_VERSION"), build_number: ENV.fetch("IOS_BUILD_NUMBER"))
      runner.run
      puts "Apple manual release verified for #{ENV.fetch('RELEASE_VERSION')} build #{ENV.fetch('IOS_BUILD_NUMBER')}"
      0
    rescue StandardError => error
      warn(error.is_a?(Error) ? error.message : "Release control failed (#{error.class}); no verified outcome")
      1
    ensure
      receipt = runner&.receipt || { "status" => "failed-before-write", "writeAttempted" => false, "error" => "Release control initialization failed" }
      File.write(output, JSON.pretty_generate(receipt) + "\n")
    end
  end
end

exit BoardseshStoreReleaseControl.cli if $PROGRAM_NAME == __FILE__
