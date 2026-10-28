#pragma once
#include "Arduino.h"

#include <map>
#include <vector>
struct FixtureJsonNode {
    std::string text;
    int number = 0;
    std::map<std::string, FixtureJsonNode> object;
    std::vector<FixtureJsonNode> array;
    FixtureJsonNode() = default;
    FixtureJsonNode(const char* text) : text(text) {}
    FixtureJsonNode(int number) : number(number) {}
};
class JsonArrayConst;
class JsonVariantConst {
  public:
    const FixtureJsonNode* node = nullptr;
    JsonVariantConst() = default;
    JsonVariantConst(const FixtureJsonNode* node) : node(node) {}
    JsonVariantConst operator[](const char* key) const {
        if (!node)
            return {};
        auto found = node->object.find(key);
        return found == node->object.end() ? JsonVariantConst{} : JsonVariantConst(&found->second);
    }
    template <typename T> T as() const;
};
class JsonArrayConst {
  public:
    const FixtureJsonNode* node = nullptr;
    size_t size() const { return node ? node->array.size() : 0; }
    JsonVariantConst operator[](size_t index) const { return JsonVariantConst(&node->array[index]); }
};
struct Sink {
    template <typename T> Sink& operator=(const T&) { return *this; }
};
struct JsonObject {
    Sink operator[](const char*) { return {}; }
};
struct JsonArray {
    size_t size() const { return 0; }
    JsonVariantConst operator[](size_t) const { return {}; }
    template <typename T> T add() { return {}; }
};
template <typename T> T JsonVariantConst::as() const {
    if constexpr (std::is_same_v<T, String>)
        return String(node ? node->text.c_str() : "");
    else if constexpr (std::is_same_v<T, int>)
        return node ? node->number : 0;
    else if constexpr (std::is_same_v<T, JsonArrayConst>)
        return JsonArrayConst{node};
    else
        return T{};
}
