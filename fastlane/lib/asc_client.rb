# frozen_string_literal: true

require "json"
require "net/http"
require "uri"

module BoardseshASC
  class Error < StandardError; end

  # No credentials or signed upload URLs are written to logs. POST is deliberately
  # not retried: after an ambiguous network failure, the next lane run reconciles
  # Apple's resources before creating anything else.
  class Client
    ORIGIN = "https://api.appstoreconnect.apple.com"
    SAFE_ERROR_CODE = /\A[A-Z0-9_]+(?:\.[A-Z0-9_]+)*\z/.freeze
    ERROR_RELATIONSHIPS = %w[
      app appCustomProductPageVersions appCustomProductPage appStoreVersionTemplate
      customProductPageTemplate appCustomProductPageLocalizations appCustomProductPageVersion
      appCustomProductPageLocalization appScreenshotSet appScreenshots searchKeywords
      reviewSubmission appStoreVersion
    ].freeze
    SAFE_ERROR_POINTER = %r{\A/(?:data|included/(?:0|[1-9][0-9]{0,2}))/relationships/(?:#{ERROR_RELATIONSHIPS.join("|")})(?:/data(?:/(?:0|[1-9][0-9]{0,2}))?(?:/(?:id|type))?)?\z}.freeze

    def initialize(token:, sleeper: ->(seconds) { sleep(seconds) }, transport: ->(uri) { Net::HTTP.new(uri.host, uri.port) })
      @token = token
      @sleeper = sleeper
      @transport = transport
    end

    def request(method, path, body = nil)
      uri = URI(path.start_with?("https://") ? path : "#{ORIGIN}#{path}")
      raise Error, "Refusing an App Store Connect URL outside Apple's API" unless uri.scheme == "https" && uri.host == URI(ORIGIN).host
      response = perform(method, uri, body && JSON.generate(body), { "Authorization" => "Bearer #{@token.call}", "Content-Type" => "application/json" })
      response.body.to_s.empty? ? {} : JSON.parse(response.body)
    end

    def list(path)
      resources = []
      100.times do
        response = request("GET", path)
        resources.concat(response.fetch("data"))
        path = response.dig("links", "next")
        return resources unless path
      end
      raise Error, "App Store Connect pagination exceeded 100 pages"
    end

    def upload(operation, path)
      uri = URI(operation.fetch("url"))
      raise Error, "Apple upload operation must use HTTPS" unless uri.scheme == "https"
      offset = operation.fetch("offset")
      length = operation.fetch("length")
      raise Error, "Invalid asset upload range" unless offset >= 0 && length > 0 && offset + length <= File.size(path)
      headers = operation.fetch("requestHeaders", []).to_h { |header| [header.fetch("name"), header.fetch("value")] }
      bytes = File.open(path, "rb") { |file| file.seek(offset); file.read(length) }
      perform(operation.fetch("method"), uri, bytes, headers)
    end

    private

    def error_diagnostics(response_body)
      document = JSON.parse(response_body)
      return "malformed error response" unless document.is_a?(Hash)
      errors = document.fetch("errors", [])
      return "malformed error response" unless errors.is_a?(Array) && errors.all? { |error| error.is_a?(Hash) }
      diagnostics = errors.first(10).map do |error|
        error_code = error["code"]
        safe_code = error_code.is_a?(String) && error_code.bytesize <= 128 && SAFE_ERROR_CODE.match?(error_code) ? error_code : "UNKNOWN_ERROR"
        source = error["source"]
        pointer = source.is_a?(Hash) && source["pointer"]
        safe_pointer = pointer.is_a?(String) && pointer.bytesize <= 256 && SAFE_ERROR_POINTER.match?(pointer)
        safe_pointer ? "#{safe_code} at #{pointer}" : safe_code
      end
      diagnostics.empty? ? "UNKNOWN_ERROR" : diagnostics.uniq.join(", ")
    rescue JSON::ParserError
      "non-JSON response"
    end

    def perform(method, uri, body, headers)
      attempts = 0
      begin
        attempts += 1
        http = @transport.call(uri)
        http.use_ssl = true
        http.open_timeout = 30
        http.read_timeout = 120
        request = Net::HTTPGenericRequest.new(method, !body.nil?, method != "HEAD", uri.request_uri, headers)
        request.body = body if body
        response = http.request(request)
        code = response.code.to_i
        return response if code >= 200 && code < 300
        raise Net::ReadTimeout if method != "POST" && (code == 429 || code >= 500) && attempts < 3
        # Error details can contain signed asset URLs. Retain only bounded codes
        # and allowlisted structural relationship pointers, never IDs or details.
        raise Error, "Apple API #{method} failed (HTTP #{code}; #{error_diagnostics(response.body)}). Re-run to reconcile after checking App Store Connect."
      rescue Net::OpenTimeout, Net::ReadTimeout, IOError, SystemCallError => error
        if method != "POST" && attempts < 3
          @sleeper.call(attempts * 5)
          retry
        end
        raise Error, "Apple API #{method} transport failed (#{error.class}); re-run to reconcile."
      end
    end
  end

end
