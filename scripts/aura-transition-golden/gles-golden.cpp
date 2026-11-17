// One offscreen correctness fixture. No app/account/network/preference APIs.
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl31.h>
#include "aura_gpu_packet_layout.h"
#include <algorithm>
#include <array>
#include <cctype>
#include <cerrno>
#include <csignal>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>

namespace {
static_assert(AURA_GPU_DESCRIPTOR_BYTES == 224 && AURA_GPU_UNIFORM_BYTES == 144, "Unexpected packet ABI");
constexpr int width = 1080, height = 1504;
constexpr std::array<int, 3> counts{6, 7, 7};
using Bytes = std::vector<uint8_t>;
size_t ownedBytes = 0;
std::string inputs;
void check(bool condition, const std::string& message) { if (!condition) throw std::runtime_error(message); }
void glCheck(const std::string& phase) { const auto error = glGetError(); check(error == GL_NO_ERROR, phase + " GL error " + std::to_string(error)); }
bool safeName(const std::string& name) {
  return !name.empty() && name.size() <= 64 && std::all_of(name.begin(), name.end(), [](unsigned char character) { return std::islower(character) || std::isdigit(character) || character == '-'; });
}
Bytes read(const std::string& name, size_t maximum = AURA_GPU_MAX_GPU_BYTES) {
  check(name.find('/') == std::string::npos && name != "." && name != "..", "Unsafe input filename");
  std::ifstream stream(inputs + "/" + name, std::ios::binary | std::ios::ate);
  check(stream.good(), "Missing input " + name);
  const auto length = stream.tellg();
  check(length >= 0 && static_cast<uint64_t>(length) <= maximum, "Input length bound " + name);
  Bytes bytes(static_cast<size_t>(length)); stream.seekg(0);
  if (!bytes.empty()) stream.read(reinterpret_cast<char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
  check(stream.good(), "Input read failed " + name); return bytes;
}
std::string escape(const std::string& text) {
  std::string output;
  for (const unsigned char character : text) { if (character == '"' || character == '\\') output.push_back('\\'); if (character >= 32) output.push_back(static_cast<char>(character)); }
  return output;
}
std::string text(const Bytes& bytes) { return std::string(bytes.begin(), bytes.end()); }
GLuint shader(GLenum kind, const Bytes& bytes) {
  const auto source = text(bytes); const char* pointer = source.c_str(); const auto length = static_cast<GLint>(source.size());
  const auto handle = glCreateShader(kind); check(handle != 0, "Shader allocation"); glShaderSource(handle, 1, &pointer, &length); glCompileShader(handle);
  GLint success = 0; glGetShaderiv(handle, GL_COMPILE_STATUS, &success);
  if (!success) { std::array<char, 8192> log{}; glGetShaderInfoLog(handle, static_cast<GLsizei>(log.size()), nullptr, log.data()); throw std::runtime_error("Shader compile: " + std::string(log.data())); }
  return handle;
}
GLuint program(const std::string& mode) {
  const auto vertex = shader(GL_VERTEX_SHADER, read(mode + ".vert", 64 * 1024));
  const auto fragment = shader(GL_FRAGMENT_SHADER, read(mode + ".frag", 64 * 1024));
  const auto handle = glCreateProgram(); glAttachShader(handle, vertex); glAttachShader(handle, fragment); glLinkProgram(handle);
  GLint success = 0; glGetProgramiv(handle, GL_LINK_STATUS, &success); glDeleteShader(vertex); glDeleteShader(fragment);
  check(success == GL_TRUE, "Shader program link"); return handle;
}
GLuint buffer(GLenum target, const Bytes& bytes) {
  check(!bytes.empty() && ownedBytes + bytes.size() <= AURA_GPU_MAX_GPU_BYTES, "Owned buffer admission");
  if (target == GL_SHADER_STORAGE_BUFFER) { GLint64 maximum = 0; glGetInteger64v(GL_MAX_SHADER_STORAGE_BLOCK_SIZE, &maximum); check(bytes.size() <= static_cast<uint64_t>(maximum), "Actual SSBO block limit"); }
  GLuint handle = 0; glGenBuffers(1, &handle); glBindBuffer(target, handle); glBufferData(target, static_cast<GLsizeiptr>(bytes.size()), bytes.data(), GL_STATIC_DRAW); glCheck("Buffer allocation");
  GLint64 actual = 0; glGetBufferParameteri64v(target, GL_BUFFER_SIZE, &actual); check(actual == static_cast<GLint64>(bytes.size()), "Actual buffer length"); ownedBytes += bytes.size(); return handle;
}
struct Mode { GLuint program = 0, pixels = 0, resources = 0; std::array<std::array<GLuint, 3>, 2> descriptors{}; };
Mode loadMode(const std::string& name) {
  Mode mode; mode.program = program(name); mode.pixels = buffer(GL_SHADER_STORAGE_BUFFER, read(name + "-pixels.bin")); mode.resources = buffer(GL_SHADER_STORAGE_BUFFER, read(name + "-resources.bin", 8 * 1024 * 1024));
  for (int variant = 0; variant < 2; variant++) {
    const auto all = read(name + "-descriptors-" + (variant ? "editor" : "transition") + ".bin", 384 * AURA_GPU_DESCRIPTOR_BYTES);
    check(all.size() == 20 * AURA_GPU_DESCRIPTOR_BYTES, "Descriptor count/stride"); size_t offset = 0;
    for (size_t slot = 0; slot < counts.size(); slot++) { const size_t length = counts[slot] * AURA_GPU_DESCRIPTOR_BYTES; mode.descriptors[variant][slot] = buffer(GL_SHADER_STORAGE_BUFFER, Bytes(all.begin() + offset, all.begin() + offset + length)); offset += length; }
  }
  return mode;
}
struct Sample { std::string name; int lower = 0, upper = 0, editor = 0; };
std::vector<Sample> samples() {
  std::istringstream stream(text(read("samples.tsv", 8192))); std::vector<Sample> output; std::string line;
  while (std::getline(stream, line)) { if (line.empty()) continue; std::istringstream fields(line); Sample sample; std::string extra; check(static_cast<bool>(fields >> sample.name >> sample.lower >> sample.upper >> sample.editor) && !(fields >> extra), "Invalid sample row");
    check(safeName(sample.name) && sample.lower >= 0 && sample.lower < 3 && sample.upper >= 0 && sample.upper < 3 && (sample.editor == 0 || sample.editor == 1), "Invalid sample source");
    check(std::none_of(output.begin(), output.end(), [&](const Sample& prior) { return prior.name == sample.name; }), "Duplicate sample"); output.push_back(sample); }
  check(output.size() == 42, "Exactly forty-two samples"); return output;
}
void save(const std::string& path, const Bytes& bytes) {
  std::ofstream stream(path, std::ios::binary); check(stream.good(), "Output open failed"); stream.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size())); stream.close(); check(stream.good(), "Output write failed");
}
Bytes render(const Mode& mode, GLuint uniforms, const Sample& sample, const std::string& modeName) {
  const auto parameters = read(modeName + "-uniforms-" + sample.name + ".bin", AURA_GPU_UNIFORM_BYTES); check(parameters.size() == AURA_GPU_UNIFORM_BYTES, "Uniform stride");
  glUseProgram(mode.program);
  glBindBufferBase(GL_SHADER_STORAGE_BUFFER, AURA_GPU_GLES_STORAGE_BINDINGS_PIXELS, mode.pixels);
  glBindBufferBase(GL_SHADER_STORAGE_BUFFER, AURA_GPU_GLES_STORAGE_BINDINGS_LOWER, mode.descriptors[sample.editor][sample.lower]);
  glBindBufferBase(GL_SHADER_STORAGE_BUFFER, AURA_GPU_GLES_STORAGE_BINDINGS_UPPER, mode.descriptors[sample.editor][sample.upper]);
  glBindBufferBase(GL_SHADER_STORAGE_BUFFER, AURA_GPU_GLES_STORAGE_BINDINGS_RESOURCES, mode.resources);
  glBindBuffer(GL_UNIFORM_BUFFER, uniforms); glBufferSubData(GL_UNIFORM_BUFFER, 0, AURA_GPU_UNIFORM_BYTES, parameters.data()); glBindBufferBase(GL_UNIFORM_BUFFER, AURA_GPU_GLES_UNIFORM_BINDINGS_UNIFORMS, uniforms);
  glClearColor(0, 0, 0, 0); glClear(GL_COLOR_BUFFER_BIT); glDrawArrays(GL_TRIANGLES, 0, 3); glFinish(); glCheck("Render completion");
  Bytes bottomUp(width * height * 4), topDown(bottomUp.size()); glPixelStorei(GL_PACK_ALIGNMENT, 1); glReadPixels(0, 0, width, height, GL_RGBA, GL_UNSIGNED_BYTE, bottomUp.data()); glCheck("Readback");
  for (int row = 0; row < height; row++) std::copy_n(bottomUp.data() + (height - 1 - row) * width * 4, width * 4, topDown.data() + row * width * 4);
  return topDown;
}
}
int main(int argc, char** argv) {
  alarm(150); // Survives a disconnected host; this test cannot run unbounded.
  try {
    check(argc == 2, "Expected one owned staging directory"); const std::string root(argv[1]); const std::string prefix = "/data/local/tmp/boardsesh-aura-lazy-golden-";
    check(root.size() == prefix.size() + 12 && root.compare(0, prefix.size(), prefix) == 0 && std::all_of(root.begin() + static_cast<std::ptrdiff_t>(prefix.size()), root.end(), [](unsigned char character) { return std::isdigit(character) || (character >= 'a' && character <= 'f'); }), "Unowned staging path");
    std::cout << "{\"phase\":\"starting\",\"processId\":" << getpid() << "}" << std::endl;
    inputs = root + "/inputs"; const auto output = root + "/renders"; check(mkdir(output.c_str(), 0700) == 0, "Preserve existing output or cannot create it");
    const auto display = eglGetDisplay(EGL_DEFAULT_DISPLAY); check(display != EGL_NO_DISPLAY, "EGL display unavailable");
    EGLint major = 0, minor = 0; check(eglInitialize(display, &major, &minor) == EGL_TRUE, "EGL initialization failed"); check(eglBindAPI(EGL_OPENGL_ES_API) == EGL_TRUE, "EGL API unavailable");
    const EGLint attributes[]{EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT_KHR, EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8, EGL_NONE};
    EGLConfig config{}; EGLint configCount = 0; check(eglChooseConfig(display, attributes, &config, 1, &configCount) == EGL_TRUE && configCount == 1, "No GLES3 pbuffer configuration");
    const EGLint surfaceAttributes[]{EGL_WIDTH, 1, EGL_HEIGHT, 1, EGL_NONE}, contextAttributes[]{EGL_CONTEXT_CLIENT_VERSION, 3, EGL_NONE};
    const auto surface = eglCreatePbufferSurface(display, config, surfaceAttributes); const auto context = eglCreateContext(display, config, EGL_NO_CONTEXT, contextAttributes);
    check(surface != EGL_NO_SURFACE && context != EGL_NO_CONTEXT && eglMakeCurrent(display, surface, surface, context) == EGL_TRUE, "EGL context unavailable");
    GLint glMajor = 0, glMinor = 0; glGetIntegerv(GL_MAJOR_VERSION, &glMajor); glGetIntegerv(GL_MINOR_VERSION, &glMinor); check(glMajor > 3 || (glMajor == 3 && glMinor >= 1), "Actual GLES3.1 required");
    const std::string renderer(reinterpret_cast<const char*>(glGetString(GL_RENDERER))), vendor(reinterpret_cast<const char*>(glGetString(GL_VENDOR))), version(reinterpret_cast<const char*>(glGetString(GL_VERSION)));
    std::string lowercase = renderer; std::transform(lowercase.begin(), lowercase.end(), lowercase.begin(), [](unsigned char character) { return static_cast<char>(std::tolower(character)); });
    check(lowercase.find("swiftshader") == std::string::npos && lowercase.find("llvmpipe") == std::string::npos && lowercase.find("software") == std::string::npos, "Software renderer rejected");
    auto old = loadMode("old"), fresh = loadMode("new"); const auto uniformBuffer = buffer(GL_UNIFORM_BUFFER, Bytes(AURA_GPU_UNIFORM_BYTES));
    check(ownedBytes + width * height * 4 <= AURA_GPU_MAX_GPU_BYTES, "Owned render target admission");
    GLuint texture = 0, framebuffer = 0, vertexArray = 0; glGenTextures(1, &texture); glBindTexture(GL_TEXTURE_2D, texture); glTexStorage2D(GL_TEXTURE_2D, 1, GL_RGBA8, width, height); glGenFramebuffers(1, &framebuffer); glBindFramebuffer(GL_FRAMEBUFFER, framebuffer); glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, texture, 0); check(glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE, "Offscreen framebuffer incomplete"); ownedBytes += width * height * 4;
    glGenVertexArrays(1, &vertexArray); glBindVertexArray(vertexArray); glViewport(0, 0, width, height); glDisable(GL_BLEND); glDisable(GL_DEPTH_TEST); glDisable(GL_DITHER); glDisable(GL_SCISSOR_TEST); glDisable(GL_STENCIL_TEST);
    int maximumError = 0; uint64_t totalOverOne = 0; std::ostringstream rows; bool first = true;
    for (const auto& sample : samples()) {
      const auto reference = render(old, uniformBuffer, sample, "old"), actual = render(fresh, uniformBuffer, sample, "new");
      int localMaximum = 0; uint64_t overOne = 0, changed = 0;
      for (size_t pixel = 0; pixel < reference.size(); pixel += 4) { int error = 0; for (size_t channel = 0; channel < 4; channel++) error = std::max(error, std::abs(static_cast<int>(reference[pixel + channel]) - static_cast<int>(actual[pixel + channel]))); localMaximum = std::max(localMaximum, error); overOne += error > 1; changed += error > 0; }
      save(output + "/" + sample.name + "-old.rgba", reference); save(output + "/" + sample.name + "-new.rgba", actual);
      maximumError = std::max(maximumError, localMaximum); totalOverOne += overOne;
      if (!first) rows << ','; first = false; rows << "{\"name\":\"" << sample.name << "\",\"maxChannelError\":" << localMaximum << ",\"pixelsOverOne\":" << overOne << ",\"changedPixels\":" << changed << '}';
      std::cout << "{\"sample\":\"" << sample.name << "\",\"completed\":true}" << std::endl;
      check(localMaximum <= 1 && overOne == 0, "First shader mismatch; raw images retained");
    }
    std::ofstream report(output + "/result.json"); check(report.good(), "Report open failed");
    report << "{\"status\":\"PASS_ACTUAL_GLES_RICH_42\",\"compiledContractSha256\":\"" << AURA_GPU_CONTRACT_SHA256 << "\",\"processId\":" << getpid() << ",\"renderer\":\"" << escape(renderer) << "\",\"vendor\":\"" << escape(vendor) << "\",\"version\":\"" << escape(version) << "\",\"width\":" << width << ",\"height\":" << height << ",\"commandsCompleted\":84,\"maximumChannelError\":" << maximumError << ",\"pixelsOverOne\":" << totalOverOne << ",\"trackedOwnedAllocationBytes\":" << ownedBytes << ",\"samples\":[" << rows.str() << "]}"; report.close(); check(report.good(), "Report write failed");
    glFinish(); eglMakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT); eglDestroyContext(display, context); eglDestroySurface(display, surface); eglTerminate(display); return 0;
  } catch (const std::exception& error) { std::cerr << error.what() << std::endl; return 1; }
}
