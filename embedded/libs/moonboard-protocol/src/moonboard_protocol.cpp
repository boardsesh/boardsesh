#include "moonboard_protocol.h"

#include <log_buffer.h>

namespace {

constexpr int MOONBOARD_NUM_COLUMNS = 11;
constexpr int MOONBOARD_NUM_ROWS = 18;
constexpr int MOONBOARD_HOLD_COUNT = MOONBOARD_NUM_COLUMNS * MOONBOARD_NUM_ROWS;
constexpr int MOONBOARD_STRIP_LED_COUNT = 200;

// Additional LED positions from the ArduinoMoonBoardLED reference project.
constexpr int MOONBOARD_ADDITIONAL_LED_OFFSETS[MOONBOARD_STRIP_LED_COUNT] = {
    0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 0, 0, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 0, 0, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0,
};

constexpr uint8_t COLOR_GREEN[3] = {0, 255, 0};
constexpr uint8_t COLOR_BLUE[3] = {0, 0, 255};
constexpr uint8_t COLOR_RED[3] = {255, 0, 0};
// Amber, not cyan, for FOOT. On an RGB strip a cyan foot sits right next to the
// blue HAND and the two are hard to call apart mid-climb. Kept byte-identical to
// HOLD_STATE_MAP.moonboard[45].color in packages/board-constants, which is what
// the app draws for the same role — moonboard-firmware-color-parity.test.ts
// fails if the two ever drift.
constexpr uint8_t COLOR_AMBER[3] = {255, 170, 0};
constexpr uint8_t COLOR_YELLOW[3] = {255, 255, 0};
constexpr uint8_t COLOR_VIOLET[3] = {128, 0, 255};
constexpr uint8_t COLOR_PINK[3] = {255, 0, 160};

int findCharFromIndex(const String& value, char needle, int startIndex) {
    for (int i = startIndex; i < static_cast<int>(value.length()); i++) {
        if (value.charAt(i) == needle) {
            return i;
        }
    }
    return -1;
}

int parseStringInt(const String& value) {
    char buffer[16];
    value.toCharArray(buffer, sizeof(buffer));
    return atoi(buffer);
}

}  // namespace

MoonBoardProtocol MoonBoard;

MoonBoardProtocol::MoonBoardProtocol()
    : parserState(PARSER_IDLE), pendingLightsAboveHolds(false), debugEnabled(false) {}

void MoonBoardProtocol::clear() {
    resetParser();
    decodedProblem = MoonBoardDecodedProblem{};
}

void MoonBoardProtocol::setDebug(bool enabled) {
    debugEnabled = enabled;
}

const std::vector<LedCommand>& MoonBoardProtocol::getLedCommands() const {
    return decodedProblem.ledCommands;
}

const MoonBoardDecodedProblem& MoonBoardProtocol::getDecodedProblem() const {
    return decodedProblem;
}

const String& MoonBoardProtocol::getFrames() const {
    return decodedProblem.frames;
}

const String& MoonBoardProtocol::getRawPayload() const {
    return decodedProblem.rawPayload;
}

const String& MoonBoardProtocol::getProblemPayload() const {
    return decodedProblem.problemPayload;
}

bool MoonBoardProtocol::getLightsAboveHolds() const {
    return decodedProblem.lightsAboveHolds;
}

bool MoonBoardProtocol::processPacket(const uint8_t* data, size_t length) {
    return addData(data, length);
}

void MoonBoardProtocol::resetParser() {
    parserState = PARSER_IDLE;
    pendingLightsAboveHolds = false;
    rawPayloadBuffer = "";
    problemPayloadBuffer = "";
}

bool MoonBoardProtocol::addData(const uint8_t* data, size_t length) {
    bool completedPayload = false;

    for (size_t i = 0; i < length; i++) {
        const char ch = static_cast<char>(data[i]);

        switch (parserState) {
            case PARSER_IDLE:
                if (ch == '~') {
                    pendingLightsAboveHolds = false;
                    rawPayloadBuffer = "~";
                    parserState = PARSER_CONFIG;
                } else if (ch == 'l') {
                    pendingLightsAboveHolds = false;
                    rawPayloadBuffer = "l";
                    parserState = PARSER_WAIT_FOR_PAYLOAD_START;
                }
                break;

            case PARSER_CONFIG:
                if (ch == '~') {
                    pendingLightsAboveHolds = false;
                    rawPayloadBuffer = "~";
                } else if (ch == 'D') {
                    pendingLightsAboveHolds = true;
                    rawPayloadBuffer += ch;
                } else if (ch == 'l') {
                    rawPayloadBuffer += ch;
                    parserState = PARSER_WAIT_FOR_PAYLOAD_START;
                } else {
                    rawPayloadBuffer += ch;
                }
                break;

            case PARSER_WAIT_FOR_PAYLOAD_START:
                if (ch == '#') {
                    rawPayloadBuffer += ch;
                    problemPayloadBuffer = "";
                    parserState = PARSER_READING_PAYLOAD;
                } else if (ch == '~') {
                    pendingLightsAboveHolds = false;
                    rawPayloadBuffer = "~";
                    parserState = PARSER_CONFIG;
                } else if (ch == 'l') {
                    pendingLightsAboveHolds = false;
                    rawPayloadBuffer = "l";
                }
                break;

            case PARSER_READING_PAYLOAD:
                if (ch == '#') {
                    rawPayloadBuffer += ch;
                    completedPayload = finalizePayload() || completedPayload;
                    resetParser();
                } else if (ch == '~') {
                    pendingLightsAboveHolds = false;
                    rawPayloadBuffer = "~";
                    problemPayloadBuffer = "";
                    parserState = PARSER_CONFIG;
                } else {
                    rawPayloadBuffer += ch;
                    problemPayloadBuffer += ch;
                }
                break;
        }
    }

    return completedPayload;
}

bool MoonBoardProtocol::finalizePayload() {
    if (debugEnabled) {
        Logger.logln("[MoonBoard] Payload complete: %s", rawPayloadBuffer.c_str());
    }

    return decodeProblem(problemPayloadBuffer, pendingLightsAboveHolds);
}

bool MoonBoardProtocol::decodeProblem(const String& payload, bool lightsAboveHolds) {
    decodedProblem = MoonBoardDecodedProblem{};
    decodedProblem.rawPayload = rawPayloadBuffer;
    decodedProblem.problemPayload = payload;
    decodedProblem.lightsAboveHolds = lightsAboveHolds;

    if (payload.length() == 0) {
        return true;
    }

    int tokenStart = 0;
    while (tokenStart < payload.length()) {
        int tokenEnd = findCharFromIndex(payload, ',', tokenStart);
        if (tokenEnd < 0) {
            tokenEnd = payload.length();
        }

        if (tokenEnd > tokenStart) {
            const char token = payload.charAt(tokenStart);
            const int serialPosition = parseStringInt(payload.substring(tokenStart + 1, tokenEnd));
            const uint8_t roleCode = tokenToRoleCode(token);

            if (roleCode != 0) {
                const int holdId = serialPositionToHoldId(serialPosition);
                if (holdId > 0) {
                    uint8_t r = 0;
                    uint8_t g = 0;
                    uint8_t b = 0;
                    tokenToColor(token, r, g, b);

                    decodedProblem.holds.push_back(MoonBoardParsedHold{
                        static_cast<uint16_t>(serialPosition),
                        static_cast<uint16_t>(holdId),
                        static_cast<uint16_t>(serialPosition),
                        token,
                        roleCode,
                        false,
                    });
                    decodedProblem.ledCommands.push_back(LedCommand{serialPosition, r, g, b});
                    decodedProblem.frames += "p";
                    decodedProblem.frames += String(holdId);
                    decodedProblem.frames += "r";
                    decodedProblem.frames += String(roleCode);

                    const bool shouldAddAuxMarker = lightsAboveHolds && token != 'E' && token != 'e' &&
                        serialPosition >= 0 && serialPosition < MOONBOARD_STRIP_LED_COUNT;
                    if (shouldAddAuxMarker) {
                        const int additionalOffset = MOONBOARD_ADDITIONAL_LED_OFFSETS[serialPosition];
                        if (additionalOffset != 0) {
                            const int auxLedIndex = serialPosition + additionalOffset;
                            if (auxLedIndex >= 0 && auxLedIndex < MOONBOARD_STRIP_LED_COUNT) {
                                decodedProblem.ledCommands.push_back(LedCommand{
                                    auxLedIndex,
                                    COLOR_YELLOW[0],
                                    COLOR_YELLOW[1],
                                    COLOR_YELLOW[2],
                                });
                                decodedProblem.holds.back().hasAuxMarker = true;
                                decodedProblem.frames += "p";
                                decodedProblem.frames += String(holdId);
                                decodedProblem.frames += "r";
                                decodedProblem.frames += String(MOONBOARD_ROLE_AUX);
                            }
                        }
                    }
                }
            }
        }

        tokenStart = tokenEnd + 1;
    }

    if (debugEnabled) {
        Logger.logln("[MoonBoard] Parsed %zu holds, %zu LEDs, frames=%s", decodedProblem.holds.size(),
                     decodedProblem.ledCommands.size(), decodedProblem.frames.c_str());
    }

    return true;
}

uint8_t MoonBoardProtocol::tokenToRoleCode(char token) {
    switch (token) {
        case 'S':
        case 's':
            return MOONBOARD_ROLE_START;
        case 'R':
        case 'r':
        case 'P':
        case 'p':
            return MOONBOARD_ROLE_HAND;
        case 'L':
        case 'l':
            return MOONBOARD_ROLE_LEFT;
        case 'M':
        case 'm':
            return MOONBOARD_ROLE_MATCH;
        case 'F':
        case 'f':
            return MOONBOARD_ROLE_FOOT;
        case 'E':
        case 'e':
            return MOONBOARD_ROLE_FINISH;
        default:
            return 0;
    }
}

void MoonBoardProtocol::tokenToColor(char token, uint8_t& r, uint8_t& g, uint8_t& b) {
    const uint8_t* color = COLOR_BLUE;

    switch (token) {
        case 'S':
        case 's':
            color = COLOR_GREEN;
            break;
        case 'F':
        case 'f':
            color = COLOR_AMBER;
            break;
        case 'E':
        case 'e':
            color = COLOR_RED;
            break;
        case 'L':
        case 'l':
            color = COLOR_VIOLET;
            break;
        case 'M':
        case 'm':
            color = COLOR_PINK;
            break;
        default:
            color = COLOR_BLUE;
            break;
    }

    r = color[0];
    g = color[1];
    b = color[2];
}

int MoonBoardProtocol::serialPositionToHoldId(int serialPosition) {
    if (serialPosition < 0 || serialPosition >= MOONBOARD_HOLD_COUNT) {
        return -1;
    }

    const int columnIndex = serialPosition / MOONBOARD_NUM_ROWS;
    const int columnOffset = serialPosition % MOONBOARD_NUM_ROWS;
    const int rowIndex = (columnIndex % 2 == 0) ? columnOffset : (MOONBOARD_NUM_ROWS - 1 - columnOffset);

    return (rowIndex * MOONBOARD_NUM_COLUMNS) + columnIndex + 1;
}

int MoonBoardProtocol::holdIdToSerialPosition(int holdId) {
    if (holdId < 1 || holdId > MOONBOARD_HOLD_COUNT) {
        return -1;
    }

    const int zeroBasedHoldId = holdId - 1;
    const int columnIndex = zeroBasedHoldId % MOONBOARD_NUM_COLUMNS;
    const int rowIndex = zeroBasedHoldId / MOONBOARD_NUM_COLUMNS;

    if (columnIndex % 2 == 0) {
        return (columnIndex * MOONBOARD_NUM_ROWS) + rowIndex;
    }

    return (columnIndex * MOONBOARD_NUM_ROWS) + (MOONBOARD_NUM_ROWS - 1 - rowIndex);
}
