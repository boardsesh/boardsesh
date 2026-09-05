// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#include "display_base.h"

#include <qrcode.h>

// ============================================
// DisplayBase Implementation
// ============================================

DisplayBase::DisplayBase()
    : _wifiConnected(false), _backendConnected(false), _bleEnabled(false), _bleConnected(false), _hasClimb(false),
      _angle(0), _boardType("kilter"), _queueIndex(-1), _queueTotal(0), _hasNavigation(false), _hasQRCode(false),
      _queueCount(0), _currentQueueIndex(-1), _pendingNavigation(false) {}

DisplayBase::~DisplayBase() {}

// ============================================
// Status Management
// ============================================

void DisplayBase::setWiFiStatus(bool connected) {
    _wifiConnected = connected;
    onStatusChanged();
}

void DisplayBase::setBackendStatus(bool connected) {
    _backendConnected = connected;
    onStatusChanged();
}

void DisplayBase::setBleStatus(bool enabled, bool connected) {
    _bleEnabled = enabled;
    _bleConnected = connected;
    onStatusChanged();
}

// ============================================
// Session & Climb Management
// ============================================

void DisplayBase::setSessionId(const char* sessionId) {
    _sessionId = sessionId ? sessionId : "";
}

void DisplayBase::showClimb(const char* name, const char* grade, const char* gradeColor, int angle, const char* uuid,
                            const char* boardType) {
    _climbName = name ? name : "";
    _grade = grade ? grade : "";
    _gradeColor = gradeColor ? gradeColor : "";
    _angle = angle;
    _climbUuid = uuid ? uuid : "";
    _boardType = boardType ? boardType : "kilter";
    _hasClimb = true;

    // Generate QR code for the session (boardsesh.com/join/{sessionId})
    if (_sessionId.length() > 0) {
        String url = "https://www.boardsesh.com/join/";
        url += _sessionId;
        setQRCodeUrl(url.c_str());
    }

    refresh();
}

void DisplayBase::showClimbInfoOnly(const char* name, const char* grade, const char* gradeColor, int angle,
                                     const char* uuid, const char* boardType) {
    _climbName = name ? name : "";
    _grade = grade ? grade : "";
    _gradeColor = gradeColor ? gradeColor : "";
    _angle = angle;
    _climbUuid = uuid ? uuid : "";
    _boardType = boardType ? boardType : "kilter";
    _hasClimb = true;

    // Generate QR code for the session (boardsesh.com/join/{sessionId})
    if (_sessionId.length() > 0) {
        String url = "https://www.boardsesh.com/join/";
        url += _sessionId;
        setQRCodeUrl(url.c_str());
    }

    refreshInfoOnly();
}

void DisplayBase::showNoClimb() {
    _hasClimb = false;
    _climbName = "";
    _grade = "";
    _gradeColor = "";
    _angle = 0;
    _climbUuid = "";
    _hasQRCode = false;

    refresh();
}

// ============================================
// History Management
// ============================================

void DisplayBase::addToHistory(const char* name, const char* grade, const char* gradeColor) {
    if (!name || strlen(name) == 0)
        return;

    ClimbHistoryEntry entry;
    entry.name = name;
    entry.grade = grade ? grade : "";
    entry.gradeColor = gradeColor ? gradeColor : "";

    _history.push_back(entry);

    while (_history.size() > MAX_HISTORY_ITEMS) {
        _history.erase(_history.begin());
    }
}

void DisplayBase::clearHistory() {
    _history.clear();
}

// ============================================
// Navigation Context
// ============================================

void DisplayBase::setNavigationContext(const QueueNavigationItem& prevClimb, const QueueNavigationItem& nextClimb,
                                       int currentIndex, int totalCount) {
    _prevClimb = prevClimb;
    _nextClimb = nextClimb;
    _queueIndex = currentIndex;
    _queueTotal = totalCount;
    _hasNavigation = true;
}

void DisplayBase::clearNavigationContext() {
    _prevClimb.clear();
    _nextClimb.clear();
    _queueIndex = -1;
    _queueTotal = 0;
    _hasNavigation = false;
}

// ============================================
// Queue Management
// ============================================

void DisplayBase::setQueueFromSync(LocalQueueItem* items, int count, int currentIndex) {
    clearQueue();

    _queueCount = min(count, MAX_QUEUE_SIZE);
    for (int i = 0; i < _queueCount; i++) {
        _queueItems[i] = items[i];
    }

    _currentQueueIndex = currentIndex;
    _pendingNavigation = false;

    // Update navigation context to match new queue state
    if (_queueCount > 0 && _currentQueueIndex >= 0 && _currentQueueIndex < _queueCount) {
        QueueNavigationItem prevItem, nextItem;

        if (_currentQueueIndex > 0) {
            const LocalQueueItem& prev = _queueItems[_currentQueueIndex - 1];
            prevItem = QueueNavigationItem(prev.name, prev.grade, "");
        }

        if (_currentQueueIndex < _queueCount - 1) {
            const LocalQueueItem& next = _queueItems[_currentQueueIndex + 1];
            nextItem = QueueNavigationItem(next.name, next.grade, "");
        }

        setNavigationContext(prevItem, nextItem, _currentQueueIndex, _queueCount);
    } else {
        clearNavigationContext();
    }
}

void DisplayBase::clearQueue() {
    for (int i = 0; i < MAX_QUEUE_SIZE; i++) {
        _queueItems[i].clear();
    }
    _queueCount = 0;
    _currentQueueIndex = -1;
    _pendingNavigation = false;
}

const LocalQueueItem* DisplayBase::getQueueItem(int index) const {
    if (index < 0 || index >= _queueCount) {
        return nullptr;
    }
    return &_queueItems[index];
}

const LocalQueueItem* DisplayBase::getCurrentQueueItem() const {
    return getQueueItem(_currentQueueIndex);
}

const LocalQueueItem* DisplayBase::getPreviousQueueItem() const {
    return getQueueItem(_currentQueueIndex - 1);
}

const LocalQueueItem* DisplayBase::getNextQueueItem() const {
    return getQueueItem(_currentQueueIndex + 1);
}

// ============================================
// Optimistic Navigation
// ============================================

bool DisplayBase::navigateToPrevious() {
    if (!canNavigatePrevious()) {
        return false;
    }

    _currentQueueIndex--;
    _pendingNavigation = true;

    const LocalQueueItem* current = getCurrentQueueItem();
    if (current) {
        QueueNavigationItem prevItem, nextItem;

        if (_currentQueueIndex > 0) {
            const LocalQueueItem* prev = getPreviousQueueItem();
            if (prev) {
                prevItem = QueueNavigationItem(prev->name, prev->grade, "");
            }
        }

        if (_currentQueueIndex < _queueCount - 1) {
            const LocalQueueItem* next = getNextQueueItem();
            if (next) {
                nextItem = QueueNavigationItem(next->name, next->grade, "");
            }
        }

        setNavigationContext(prevItem, nextItem, _currentQueueIndex, _queueCount);
    }

    return true;
}

bool DisplayBase::navigateToNext() {
    if (!canNavigateNext()) {
        return false;
    }

    _currentQueueIndex++;
    _pendingNavigation = true;

    const LocalQueueItem* current = getCurrentQueueItem();
    if (current) {
        QueueNavigationItem prevItem, nextItem;

        if (_currentQueueIndex > 0) {
            const LocalQueueItem* prev = getPreviousQueueItem();
            if (prev) {
                prevItem = QueueNavigationItem(prev->name, prev->grade, "");
            }
        }

        if (_currentQueueIndex < _queueCount - 1) {
            const LocalQueueItem* next = getNextQueueItem();
            if (next) {
                nextItem = QueueNavigationItem(next->name, next->grade, "");
            }
        }

        setNavigationContext(prevItem, nextItem, _currentQueueIndex, _queueCount);
    }

    return true;
}

bool DisplayBase::navigateToIndex(int index) {
    if (!canNavigateToIndex(index)) {
        return false;
    }

    _currentQueueIndex = index;
    _pendingNavigation = true;

    const LocalQueueItem* current = getCurrentQueueItem();
    if (current) {
        QueueNavigationItem prevItem, nextItem;

        if (_currentQueueIndex > 0) {
            const LocalQueueItem* prev = getPreviousQueueItem();
            if (prev) {
                prevItem = QueueNavigationItem(prev->name, prev->grade, "");
            }
        }

        if (_currentQueueIndex < _queueCount - 1) {
            const LocalQueueItem* next = getNextQueueItem();
            if (next) {
                nextItem = QueueNavigationItem(next->name, next->grade, "");
            }
        }

        setNavigationContext(prevItem, nextItem, _currentQueueIndex, _queueCount);
    }

    return true;
}

void DisplayBase::setCurrentQueueIndex(int index) {
    if (index >= 0 && index < _queueCount) {
        _currentQueueIndex = index;
    }
}

const char* DisplayBase::getPendingQueueItemUuid() const {
    const LocalQueueItem* current = getCurrentQueueItem();
    return current ? current->uuid : nullptr;
}

// ============================================
// QR Code
// ============================================

void DisplayBase::setQRCodeUrl(const char* url) {
    _qrUrl = url;
    _hasQRCode = true;
}

// ============================================
// Utility
// ============================================

uint16_t DisplayBase::hexToRgb565(const char* hex) {
    if (!hex || strlen(hex) < 7 || hex[0] != '#') {
        return COLOR_TEXT;  // Default to white if invalid
    }

    char r_str[3] = {hex[1], hex[2], 0};
    char g_str[3] = {hex[3], hex[4], 0};
    char b_str[3] = {hex[5], hex[6], 0};

    uint8_t r = strtol(r_str, NULL, 16);
    uint8_t g = strtol(g_str, NULL, 16);
    uint8_t b = strtol(b_str, NULL, 16);

    return ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3);
}
