// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#ifndef UPDATE_MOCK_H
#define UPDATE_MOCK_H

#include <cstddef>
#include <cstdint>

#define UPDATE_SIZE_UNKNOWN 0xFFFFFFFF

class MockUpdate {
  public:
    bool begin(size_t size) {
        beginCalled_ = true;
        return !failBegin_;
    }

    size_t write(const uint8_t* data, size_t len) {
        bytesWritten_ += len;
        return failWrite_ ? 0 : len;
    }

    bool end(bool evenIfRemaining = false) {
        endCalled_ = true;
        return !failEnd_;
    }

    void abort() { abortCalled_ = true; }

    const char* errorString() { return errorMsg_; }

    bool hasError() { return hasError_; }

    // Test helpers
    void mockReset() {
        beginCalled_ = false;
        endCalled_ = false;
        abortCalled_ = false;
        bytesWritten_ = 0;
        hasError_ = false;
        failBegin_ = false;
        failWrite_ = false;
        failEnd_ = false;
        errorMsg_ = "";
    }

    void mockSetFailBegin(bool fail) { failBegin_ = fail; }
    void mockSetFailWrite(bool fail) { failWrite_ = fail; }
    void mockSetFailEnd(bool fail) { failEnd_ = fail; }
    void mockSetError(bool err, const char* msg = "Mock error") {
        hasError_ = err;
        errorMsg_ = msg;
    }

    bool wasBeginCalled() const { return beginCalled_; }
    bool wasEndCalled() const { return endCalled_; }
    bool wasAbortCalled() const { return abortCalled_; }
    size_t getBytesWritten() const { return bytesWritten_; }

  private:
    bool beginCalled_ = false;
    bool endCalled_ = false;
    bool abortCalled_ = false;
    size_t bytesWritten_ = 0;
    bool hasError_ = false;
    bool failBegin_ = false;
    bool failWrite_ = false;
    bool failEnd_ = false;
    const char* errorMsg_ = "";
};

extern MockUpdate Update;

#endif  // UPDATE_MOCK_H
