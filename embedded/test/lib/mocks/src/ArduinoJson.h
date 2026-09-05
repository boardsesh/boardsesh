// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

/**
 * ArduinoJson Mock Header for Native Unit Testing
 *
 * Provides a minimal mock implementation of ArduinoJson v7 API
 * for testing code that uses JSON serialization/deserialization.
 */

#ifndef ARDUINOJSON_MOCK_H
#define ARDUINOJSON_MOCK_H

#include "Arduino.h"

#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <map>
#include <sstream>
#include <string>
#include <vector>

class JsonVariant;
class JsonObject;
class JsonArray;
class JsonDocument;

// Deserialization error class
class DeserializationError {
  public:
    enum Code { Ok = 0, EmptyInput, IncompleteInput, InvalidInput, NoMemory, TooDeep };

    DeserializationError(Code code = Ok) : code_(code) {}

    explicit operator bool() const { return code_ != Ok; }

    const char* c_str() const {
        switch (code_) {
            case Ok:
                return "Ok";
            case EmptyInput:
                return "EmptyInput";
            case IncompleteInput:
                return "IncompleteInput";
            case InvalidInput:
                return "InvalidInput";
            case NoMemory:
                return "NoMemory";
            case TooDeep:
                return "TooDeep";
            default:
                return "Unknown";
        }
    }

    Code code() const { return code_; }

  private:
    Code code_;
};

// Simple variant that can hold different JSON types
class JsonVariant {
  public:
    enum Type { TypeNull, TypeBool, TypeInt, TypeFloat, TypeString, TypeObject, TypeArray };

    JsonVariant() : type_(TypeNull), intVal_(0), parent_(nullptr) {}

    // Type checkers
    template <typename T> bool is() const;

    bool isNull() const { return type_ == TypeNull; }

    // Getters with type conversion
    template <typename T> T as() const;

    // Conversion operators
    explicit operator bool() const { return !isNull(); }
    operator int() const { return intVal_; }
    operator uint8_t() const { return (uint8_t)intVal_; }
    operator const char*() const { return stringVal_.c_str(); }
    operator String() const { return String(stringVal_.c_str()); }
    operator JsonObject();  // Forward declaration
    operator JsonArray();   // Forward declaration

    // Default value operator (for pattern: doc["key"] | default)
    const char* operator|(const char* defaultValue) const {
        return (type_ == TypeString && !stringVal_.empty()) ? stringVal_.c_str() : defaultValue;
    }
    int operator|(int defaultValue) const { return (type_ == TypeInt) ? intVal_ : defaultValue; }

    // Assignment
    JsonVariant& operator=(bool val) {
        type_ = TypeBool;
        intVal_ = val ? 1 : 0;
        return *this;
    }
    JsonVariant& operator=(int val) {
        type_ = TypeInt;
        intVal_ = val;
        return *this;
    }
    JsonVariant& operator=(long val) {
        type_ = TypeInt;
        intVal_ = (int)val;
        return *this;
    }
    JsonVariant& operator=(unsigned int val) {
        type_ = TypeInt;
        intVal_ = (int)val;
        return *this;
    }
    JsonVariant& operator=(const char* val) {
        type_ = TypeString;
        stringVal_ = val ? val : "";
        return *this;
    }
    JsonVariant& operator=(const String& val) {
        type_ = TypeString;
        stringVal_ = val.c_str();
        return *this;
    }
    JsonVariant& operator=(const JsonDocument& doc);  // Forward declaration, defined after JsonDocument

    // Object/Array accessors. The non-const key accessor returns a reference
    // into the object map (like real ArduinoJson) so wrappers built from the
    // result (JsonObject/JsonArray hold a pointer) stay valid while the
    // document is alive.
    JsonVariant& operator[](const char* key);
    JsonVariant operator[](int index);
    const JsonVariant operator[](const char* key) const;
    const JsonVariant operator[](int index) const;

    // Create nested structures
    template <typename T> T to();

    // Get size (for arrays)
    size_t size() const { return arrayVal_.size(); }

    // Add element to array
    template <typename T> T add();

    // Internal data
    Type type_;
    int intVal_;
    double floatVal_ = 0;
    std::string stringVal_;
    std::map<std::string, JsonVariant> objectVal_;
    std::vector<JsonVariant> arrayVal_;
    JsonVariant* parent_;
};

// Forward declare JsonObject and JsonArray
class JsonObject {
  public:
    JsonObject() : variant_(nullptr) {}
    JsonObject(JsonVariant* v) : variant_(v) {
        if (v)
            v->type_ = JsonVariant::TypeObject;
    }

    JsonVariant& operator[](const char* key) {
        if (!variant_) {
            sharedNullSlot() = JsonVariant();
            return sharedNullSlot();
        }
        variant_->objectVal_[key].parent_ = variant_;
        return variant_->objectVal_[key];
    }

    bool isNull() const { return variant_ == nullptr; }
    operator bool() const { return variant_ != nullptr; }

    // Fallback storage so operator[] on a null JsonObject still has something
    // to reference (reset on each access; mirrors reading a missing value).
    // The slot is a single static shared by every null subscript: do NOT hold
    // the returned reference across another null-JsonObject access — the next
    // access resets it and the held reference silently aliases the new read.
    static JsonVariant& sharedNullSlot() {
        static JsonVariant nullSlot;
        return nullSlot;
    }

    // Iterator support for range-based for loops
    class iterator {
      public:
        using map_iterator = std::map<std::string, JsonVariant>::iterator;
        iterator(map_iterator it) : it_(it) {}
        iterator& operator++() {
            ++it_;
            return *this;
        }
        bool operator!=(const iterator& other) const { return it_ != other.it_; }
        JsonVariant operator*() { return it_->second; }
        const char* key() const { return it_->first.c_str(); }

      private:
        map_iterator it_;
    };

    iterator begin() {
        return variant_ ? iterator(variant_->objectVal_.begin())
                        : iterator(std::map<std::string, JsonVariant>::iterator());
    }
    iterator end() {
        return variant_ ? iterator(variant_->objectVal_.end())
                        : iterator(std::map<std::string, JsonVariant>::iterator());
    }

    JsonVariant* variant_;
};

class JsonArray {
  public:
    JsonArray() : variant_(nullptr) {}
    JsonArray(JsonVariant* v) : variant_(v) {
        if (v)
            v->type_ = JsonVariant::TypeArray;
    }

    JsonVariant operator[](int index) {
        if (!variant_ || index < 0 || (size_t)index >= variant_->arrayVal_.size())
            return JsonVariant();
        return variant_->arrayVal_[index];
    }

    template <typename T> JsonObject add() {
        if (!variant_)
            return JsonObject();
        variant_->arrayVal_.push_back(JsonVariant());
        variant_->arrayVal_.back().type_ = JsonVariant::TypeObject;
        return JsonObject(&variant_->arrayVal_.back());
    }

    bool isNull() const { return variant_ == nullptr; }
    operator bool() const { return variant_ != nullptr; }
    size_t size() const { return variant_ ? variant_->arrayVal_.size() : 0; }

    // Iterator support for range-based for loops
    class iterator {
      public:
        using vec_iterator = std::vector<JsonVariant>::iterator;
        iterator(vec_iterator it) : it_(it) {}
        iterator& operator++() {
            ++it_;
            return *this;
        }
        bool operator!=(const iterator& other) const { return it_ != other.it_; }
        JsonObject operator*() { return JsonObject(&(*it_)); }

      private:
        vec_iterator it_;
    };

    iterator begin() {
        return variant_ ? iterator(variant_->arrayVal_.begin()) : iterator(std::vector<JsonVariant>::iterator());
    }
    iterator end() {
        return variant_ ? iterator(variant_->arrayVal_.end()) : iterator(std::vector<JsonVariant>::iterator());
    }

    JsonVariant* variant_;
};

// Template specializations for is<>
template <> inline bool JsonVariant::is<bool>() const {
    return type_ == TypeBool;
}
template <> inline bool JsonVariant::is<int>() const {
    return type_ == TypeInt;
}
template <> inline bool JsonVariant::is<const char*>() const {
    return type_ == TypeString;
}
template <> inline bool JsonVariant::is<JsonObject>() const {
    return type_ == TypeObject;
}
template <> inline bool JsonVariant::is<JsonArray>() const {
    return type_ == TypeArray;
}

// Conversion operators from JsonVariant to JsonObject/JsonArray
inline JsonVariant::operator JsonObject() {
    return JsonObject(type_ == TypeObject ? const_cast<JsonVariant*>(this) : nullptr);
}

inline JsonVariant::operator JsonArray() {
    return JsonArray(type_ == TypeArray ? const_cast<JsonVariant*>(this) : nullptr);
}

// Template specializations for as<>
template <> inline bool JsonVariant::as<bool>() const {
    return intVal_ != 0;
}
template <> inline int JsonVariant::as<int>() const {
    return intVal_;
}
template <> inline const char* JsonVariant::as<const char*>() const {
    return stringVal_.c_str();
}

// Template specializations for to<>
template <> inline JsonObject JsonVariant::to<JsonObject>() {
    type_ = TypeObject;
    return JsonObject(this);
}

template <> inline JsonArray JsonVariant::to<JsonArray>() {
    type_ = TypeArray;
    return JsonArray(this);
}

// Template specializations for add<>
template <> inline JsonObject JsonVariant::add<JsonObject>() {
    if (type_ != TypeArray)
        type_ = TypeArray;
    arrayVal_.push_back(JsonVariant());
    arrayVal_.back().type_ = TypeObject;
    return JsonObject(&arrayVal_.back());
}

// JsonVariant implementations
inline JsonVariant& JsonVariant::operator[](const char* key) {
    if (type_ != TypeObject)
        type_ = TypeObject;
    objectVal_[key].parent_ = this;
    return objectVal_[key];
}

inline JsonVariant JsonVariant::operator[](int index) {
    if (type_ != TypeArray)
        return JsonVariant();
    if (index >= 0 && (size_t)index < arrayVal_.size()) {
        return arrayVal_[index];
    }
    return JsonVariant();
}

inline const JsonVariant JsonVariant::operator[](const char* key) const {
    if (type_ != TypeObject)
        return JsonVariant();
    auto it = objectVal_.find(key);
    if (it != objectVal_.end())
        return it->second;
    return JsonVariant();
}

inline const JsonVariant JsonVariant::operator[](int index) const {
    if (type_ != TypeArray)
        return JsonVariant();
    if (index >= 0 && (size_t)index < arrayVal_.size()) {
        return arrayVal_[index];
    }
    return JsonVariant();
}

// JsonDocument class
class JsonDocument {
  public:
    JsonDocument() {}

    JsonVariant& operator[](const char* key) {
        root_.type_ = JsonVariant::TypeObject;
        root_.objectVal_[key].parent_ = &root_;
        return root_.objectVal_[key];
    }

    const JsonVariant operator[](const char* key) const {
        if (root_.type_ != JsonVariant::TypeObject)
            return JsonVariant();
        auto it = root_.objectVal_.find(key);
        if (it != root_.objectVal_.end())
            return it->second;
        return JsonVariant();
    }

    template <typename T> T to() {
        if constexpr (std::is_same_v<T, JsonObject>) {
            root_.type_ = JsonVariant::TypeObject;
            return JsonObject(&root_);
        } else if constexpr (std::is_same_v<T, JsonArray>) {
            root_.type_ = JsonVariant::TypeArray;
            return JsonArray(&root_);
        }
        return T();
    }

    template <typename T> T as() {
        if constexpr (std::is_same_v<T, JsonObject>) {
            return JsonObject(&root_);
        } else if constexpr (std::is_same_v<T, JsonArray>) {
            return JsonArray(&root_);
        }
        return T();
    }

    void clear() { root_ = JsonVariant(); }

    JsonVariant& getRoot() { return root_; }
    const JsonVariant& getRoot() const { return root_; }

  private:
    JsonVariant root_;
};

// Implementation of JsonVariant::operator=(const JsonDocument&)
inline JsonVariant& JsonVariant::operator=(const JsonDocument& doc) {
    *this = doc.getRoot();
    return *this;
}

// Simple JSON parser (minimal implementation)
inline DeserializationError deserializeJson(JsonDocument& doc, const uint8_t* input, size_t len) {
    if (!input || len == 0)
        return DeserializationError::EmptyInput;

    std::string str((const char*)input, len);
    size_t pos = 0;

    // Skip whitespace
    while (pos < str.length() && isspace(str[pos]))
        pos++;

    if (pos >= str.length())
        return DeserializationError::EmptyInput;

    if (str[pos] == '{') {
        doc.getRoot().type_ = JsonVariant::TypeObject;
        pos++;
        while (pos < str.length()) {
            while (pos < str.length() && isspace(str[pos]))
                pos++;
            if (str[pos] == '}')
                break;
            if (str[pos] == ',') {
                pos++;
                continue;
            }

            if (str[pos] != '"')
                return DeserializationError::InvalidInput;
            pos++;
            size_t keyStart = pos;
            while (pos < str.length() && str[pos] != '"')
                pos++;
            std::string key = str.substr(keyStart, pos - keyStart);
            pos++;

            while (pos < str.length() && str[pos] != ':')
                pos++;
            pos++;

            while (pos < str.length() && isspace(str[pos]))
                pos++;

            if (str[pos] == '"') {
                pos++;
                size_t valStart = pos;
                while (pos < str.length() && str[pos] != '"')
                    pos++;
                doc.getRoot().objectVal_[key].type_ = JsonVariant::TypeString;
                doc.getRoot().objectVal_[key].stringVal_ = str.substr(valStart, pos - valStart);
                pos++;
            } else if (str[pos] == 't' || str[pos] == 'f') {
                doc.getRoot().objectVal_[key].type_ = JsonVariant::TypeBool;
                doc.getRoot().objectVal_[key].intVal_ = (str[pos] == 't') ? 1 : 0;
                while (pos < str.length() && isalpha(str[pos]))
                    pos++;
            } else if (str[pos] == 'n') {
                doc.getRoot().objectVal_[key].type_ = JsonVariant::TypeNull;
                while (pos < str.length() && isalpha(str[pos]))
                    pos++;
            } else if (str[pos] == '[') {
                doc.getRoot().objectVal_[key].type_ = JsonVariant::TypeArray;
                int depth = 1;
                pos++;
                while (pos < str.length() && depth > 0) {
                    if (str[pos] == '[')
                        depth++;
                    else if (str[pos] == ']')
                        depth--;
                    pos++;
                }
            } else if (str[pos] == '{') {
                doc.getRoot().objectVal_[key].type_ = JsonVariant::TypeObject;
                int depth = 1;
                pos++;
                while (pos < str.length() && depth > 0) {
                    if (str[pos] == '{')
                        depth++;
                    else if (str[pos] == '}')
                        depth--;
                    pos++;
                }
            } else if (isdigit(str[pos]) || str[pos] == '-') {
                doc.getRoot().objectVal_[key].type_ = JsonVariant::TypeInt;
                size_t valStart = pos;
                if (str[pos] == '-')
                    pos++;
                while (pos < str.length() && (isdigit(str[pos]) || str[pos] == '.'))
                    pos++;
                doc.getRoot().objectVal_[key].intVal_ = atoi(str.substr(valStart, pos - valStart).c_str());
            }
        }
        return DeserializationError::Ok;
    } else if (str[pos] == '[') {
        // Array at root level - minimal support
        doc.getRoot().type_ = JsonVariant::TypeArray;
        return DeserializationError::Ok;
    }

    // Not valid JSON
    return DeserializationError::InvalidInput;
}

inline DeserializationError deserializeJson(JsonDocument& doc, const char* input) {
    if (!input)
        return DeserializationError::EmptyInput;
    return deserializeJson(doc, (const uint8_t*)input, strlen(input));
}

inline DeserializationError deserializeJson(JsonDocument& doc, const String& input) {
    return deserializeJson(doc, input.c_str());
}

// Simple JSON serializer
inline void serializeJsonVariant(const JsonVariant& v, std::string& output) {
    switch (v.type_) {
        case JsonVariant::TypeNull:
            output += "null";
            break;
        case JsonVariant::TypeBool:
            output += v.intVal_ ? "true" : "false";
            break;
        case JsonVariant::TypeInt:
            output += std::to_string(v.intVal_);
            break;
        case JsonVariant::TypeFloat:
            output += std::to_string(v.floatVal_);
            break;
        case JsonVariant::TypeString:
            output += "\"" + v.stringVal_ + "\"";
            break;
        case JsonVariant::TypeObject: {
            output += "{";
            bool first = true;
            for (const auto& pair : v.objectVal_) {
                if (!first)
                    output += ",";
                first = false;
                output += "\"" + pair.first + "\":";
                serializeJsonVariant(pair.second, output);
            }
            output += "}";
            break;
        }
        case JsonVariant::TypeArray: {
            output += "[";
            bool first = true;
            for (const auto& elem : v.arrayVal_) {
                if (!first)
                    output += ",";
                first = false;
                serializeJsonVariant(elem, output);
            }
            output += "]";
            break;
        }
    }
}

inline size_t serializeJson(const JsonDocument& doc, String& output) {
    std::string str;
    serializeJsonVariant(doc.getRoot(), str);
    output = str.c_str();
    return str.length();
}

inline size_t serializeJson(const JsonDocument& doc, char* output, size_t size) {
    std::string str;
    serializeJsonVariant(doc.getRoot(), str);
    size_t len = std::min(str.length(), size - 1);
    memcpy(output, str.c_str(), len);
    output[len] = '\0';
    return len;
}

#endif  // ARDUINOJSON_MOCK_H
