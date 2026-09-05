// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

/**
 * WebServer Mock Header for Native Unit Testing
 *
 * Provides a mock ESP32 WebServer implementation to simulate HTTP server
 * functionality for testing web server code.
 */

#ifndef WEBSERVER_MOCK_H
#define WEBSERVER_MOCK_H

#include "Arduino.h"

#include <cstdint>
#include <functional>
#include <map>
#include <string>
#include <vector>

// HTTP methods
typedef enum { HTTP_ANY, HTTP_GET, HTTP_HEAD, HTTP_POST, HTTP_PUT, HTTP_PATCH, HTTP_DELETE, HTTP_OPTIONS } HTTPMethod;

// Upload status constants
#define UPLOAD_FILE_START 0
#define UPLOAD_FILE_WRITE 1
#define UPLOAD_FILE_END 2
#define UPLOAD_FILE_ABORTED 3

struct HTTPUpload {
    int status = 0;
    const uint8_t* buf = nullptr;
    size_t currentSize = 0;
    size_t totalSize = 0;
    String filename;
};

class WebServer;
typedef std::function<void(void)> THandlerFunction;

// Mock ESP class for restart
class MockESP {
  public:
    void restart() {
        restartCalled_ = true;
        restartCount_++;
    }

    // Test helpers
    bool wasRestartCalled() const { return restartCalled_; }
    int getRestartCount() const { return restartCount_; }
    void mockReset() {
        restartCalled_ = false;
        restartCount_ = 0;
    }

  private:
    bool restartCalled_ = false;
    int restartCount_ = 0;
};

extern MockESP ESP;

class WebServer {
  public:
    WebServer(uint16_t port = 80) : port_(port), running_(false) {}

    void begin() { running_ = true; }

    void stop() { running_ = false; }

    void handleClient() {
        // In mock, we call handlers via mockRequest()
    }

    void on(const char* uri, HTTPMethod method, THandlerFunction handler) {
        routes_[std::string(uri)][method] = handler;
    }

    void on(const char* uri, HTTPMethod method, THandlerFunction handler, THandlerFunction uploadHandler) {
        routes_[std::string(uri)][method] = handler;
        uploadHandlers_[std::string(uri)] = uploadHandler;
    }

    void on(const char* uri, THandlerFunction handler) { on(uri, HTTP_ANY, handler); }

    void onNotFound(THandlerFunction handler) { notFoundHandler_ = handler; }

    void send(int code, const char* contentType, const char* content) {
        lastResponseCode_ = code;
        lastContentType_ = contentType ? contentType : "";
        lastResponseBody_ = content ? content : "";
        responses_.push_back({code, lastContentType_, lastResponseBody_});
    }

    void send(int code, const char* contentType, const String& content) { send(code, contentType, content.c_str()); }

    void sendHeader(const char* name, const char* value) { lastHeaders_[name ? name : ""] = value ? value : ""; }

    bool hasArg(const char* name) const { return args_.find(name ? name : "") != args_.end(); }

    String arg(const char* name) const {
        auto it = args_.find(name ? name : "");
        if (it != args_.end())
            return it->second.c_str();
        return String();
    }

    HTTPMethod method() const { return currentMethod_; }

    const String& uri() const { return currentUri_; }

    HTTPUpload& upload() { return mockUpload_; }

    // Test control methods
    void mockRequest(const char* uri, HTTPMethod method, const std::string& body = "") {
        currentUri_ = uri ? uri : "";
        currentMethod_ = method;
        if (body.length() > 0) {
            args_["plain"] = body;
        }

        auto uriIt = routes_.find(currentUri_.c_str());
        if (uriIt != routes_.end()) {
            auto methodIt = uriIt->second.find(method);
            if (methodIt != uriIt->second.end()) {
                methodIt->second();
                return;
            }
            // Try HTTP_ANY
            methodIt = uriIt->second.find(HTTP_ANY);
            if (methodIt != uriIt->second.end()) {
                methodIt->second();
                return;
            }
        }

        // Not found
        if (notFoundHandler_) {
            notFoundHandler_();
        }
    }

    // Simulate a file upload by calling the upload handler then the completion handler
    void mockSimulateUpload(const char* uri, const std::string& filename,
                            const uint8_t* data, size_t dataLen) {
        auto uploadIt = uploadHandlers_.find(uri ? uri : "");
        auto uriIt = routes_.find(uri ? uri : "");
        if (uploadIt == uploadHandlers_.end() || uriIt == routes_.end()) return;

        auto methodIt = uriIt->second.find(HTTP_POST);
        if (methodIt == uriIt->second.end()) return;

        auto& uploadHandler = uploadIt->second;
        auto& completionHandler = methodIt->second;

        // UPLOAD_FILE_START
        mockUpload_.status = UPLOAD_FILE_START;
        mockUpload_.filename = filename.c_str();
        mockUpload_.currentSize = 0;
        mockUpload_.totalSize = dataLen;
        mockUpload_.buf = nullptr;
        uploadHandler();

        // UPLOAD_FILE_WRITE (single chunk)
        if (data && dataLen > 0) {
            mockUpload_.status = UPLOAD_FILE_WRITE;
            mockUpload_.buf = data;
            mockUpload_.currentSize = dataLen;
            uploadHandler();
        }

        // UPLOAD_FILE_END
        mockUpload_.status = UPLOAD_FILE_END;
        mockUpload_.currentSize = 0;
        uploadHandler();

        // Completion handler (sends the HTTP response)
        completionHandler();
    }

    // Simulate an aborted upload
    void mockSimulateUploadAbort(const char* uri, const std::string& filename) {
        auto uploadIt = uploadHandlers_.find(uri ? uri : "");
        auto uriIt = routes_.find(uri ? uri : "");
        if (uploadIt == uploadHandlers_.end() || uriIt == routes_.end()) return;

        auto methodIt = uriIt->second.find(HTTP_POST);
        if (methodIt == uriIt->second.end()) return;

        auto& uploadHandler = uploadIt->second;
        auto& completionHandler = methodIt->second;

        // UPLOAD_FILE_START
        mockUpload_.status = UPLOAD_FILE_START;
        mockUpload_.filename = filename.c_str();
        mockUpload_.currentSize = 0;
        mockUpload_.totalSize = 0;
        mockUpload_.buf = nullptr;
        uploadHandler();

        // UPLOAD_FILE_ABORTED
        mockUpload_.status = UPLOAD_FILE_ABORTED;
        uploadHandler();

        // Completion handler
        completionHandler();
    }

    void mockSetArgs(const std::map<std::string, std::string>& args) { args_ = args; }

    void mockClearArgs() { args_.clear(); }

    void mockReset() {
        running_ = false;
        routes_.clear();
        uploadHandlers_.clear();
        args_.clear();
        lastHeaders_.clear();
        responses_.clear();
        lastResponseCode_ = 0;
        lastContentType_ = "";
        lastResponseBody_ = "";
        currentUri_ = "";
        notFoundHandler_ = nullptr;
        mockUpload_ = HTTPUpload();
    }

    // Test inspection methods
    bool isRunning() const { return running_; }
    uint16_t getPort() const { return port_; }
    int getLastResponseCode() const { return lastResponseCode_; }
    const std::string& getLastContentType() const { return lastContentType_; }
    const std::string& getLastResponseBody() const { return lastResponseBody_; }
    const std::map<std::string, std::string>& getLastHeaders() const { return lastHeaders_; }
    size_t getResponseCount() const { return responses_.size(); }

    struct Response {
        int code;
        std::string contentType;
        std::string body;
    };
    const std::vector<Response>& getResponses() const { return responses_; }

  private:
    uint16_t port_;
    bool running_;
    std::map<std::string, std::map<HTTPMethod, THandlerFunction>> routes_;
    std::map<std::string, THandlerFunction> uploadHandlers_;
    THandlerFunction notFoundHandler_;
    std::map<std::string, std::string> args_;
    std::map<std::string, std::string> lastHeaders_;
    std::vector<Response> responses_;
    int lastResponseCode_ = 0;
    std::string lastContentType_;
    std::string lastResponseBody_;
    String currentUri_;
    HTTPMethod currentMethod_ = HTTP_GET;
    HTTPUpload mockUpload_;
};

#endif  // WEBSERVER_MOCK_H
