// Board motion lab previews, GLES side: renders prepared frames offscreen with the
// Android shader strings exported from the real Kotlin objects, the swap look's
// words from the real OverlaySwapLook.kt, and Rust packets; and renders the Aura
// transition golden's 42 samples through the baseline shader, today's base program
// and today's look program with no look. Runs on an Android emulator (gles.mjs);
// no app, settings or network.
//
//   gles-look frames <root>   root/shaders/{after,base}.{vert,frag}, root/frames.tsv,
//                             root/packets/..., root/frames/<name>.{uniforms,look}
//                             -> root/out/<name>.rgba (top row first, premultiplied).
//                             A look with a zero header draws with the base program,
//                             as OverlayRenderer does; any other with the look (after).
//   gles-look parity <root>   root/shaders/{baseline,base,after}.{vert,frag}, root/golden/...
//                             -> root/out/parity.json
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl31.h>
#include <algorithm>
#include <array>
#include <cctype>
#include <chrono>
#include <csignal>
#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>

namespace {
using Bytes = std::vector<uint8_t>;
constexpr size_t uniformBytes = 144;
// OverlaySwapLook.GLES_BYTES: 129 uvec4s, the header plus two full climbs.
constexpr size_t lookBytes = 129 * 16;
constexpr GLuint lookBinding = 1;

void check(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}
void glCheck(const std::string& phase) {
  const auto error = glGetError();
  check(error == GL_NO_ERROR, phase + " GL error " + std::to_string(error));
}
bool safePath(const std::string& path) {
  return !path.empty() && path.size() < 200 && path.find("..") == std::string::npos && path[0] != '/' &&
         std::all_of(path.begin(), path.end(), [](unsigned char character) {
           return std::isalnum(character) || character == '-' || character == '_' || character == '.' || character == '/';
         });
}
Bytes read(const std::string& root, const std::string& name, size_t maximum = 128u << 20) {
  check(safePath(name), "Unsafe input path " + name);
  std::ifstream stream(root + "/" + name, std::ios::binary | std::ios::ate);
  check(stream.good(), "Missing input " + name);
  const auto length = stream.tellg();
  check(length >= 0 && static_cast<uint64_t>(length) <= maximum, "Input length bound " + name);
  Bytes bytes(static_cast<size_t>(length));
  stream.seekg(0);
  if (!bytes.empty()) stream.read(reinterpret_cast<char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
  check(stream.good(), "Input read failed " + name);
  return bytes;
}
void save(const std::string& path, const Bytes& bytes) {
  std::ofstream stream(path, std::ios::binary);
  check(stream.good(), "Output open failed " + path);
  stream.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
  stream.close();
  check(stream.good(), "Output write failed " + path);
}
GLuint shader(GLenum kind, const Bytes& bytes) {
  const std::string source(bytes.begin(), bytes.end());
  const char* pointer = source.c_str();
  const auto length = static_cast<GLint>(source.size());
  const auto handle = glCreateShader(kind);
  check(handle != 0, "Shader allocation");
  glShaderSource(handle, 1, &pointer, &length);
  glCompileShader(handle);
  GLint success = 0;
  glGetShaderiv(handle, GL_COMPILE_STATUS, &success);
  if (!success) {
    std::array<char, 8192> log{};
    glGetShaderInfoLog(handle, static_cast<GLsizei>(log.size()), nullptr, log.data());
    throw std::runtime_error("Shader compile: " + std::string(log.data()));
  }
  return handle;
}
GLuint program(const std::string& root, const std::string& name) {
  const auto vertex = shader(GL_VERTEX_SHADER, read(root, "shaders/" + name + ".vert", 64 * 1024));
  const auto fragment = shader(GL_FRAGMENT_SHADER, read(root, "shaders/" + name + ".frag", 64 * 1024));
  const auto handle = glCreateProgram();
  glAttachShader(handle, vertex);
  glAttachShader(handle, fragment);
  glLinkProgram(handle);
  GLint success = 0;
  glGetProgramiv(handle, GL_LINK_STATUS, &success);
  glDeleteShader(vertex);
  glDeleteShader(fragment);
  check(success == GL_TRUE, "Shader program link " + name);
  return handle;
}
GLuint buffer(GLenum target, const uint8_t* data, size_t length, size_t capacity = 0) {
  GLuint handle = 0;
  glGenBuffers(1, &handle);
  glBindBuffer(target, handle);
  glBufferData(target, static_cast<GLsizeiptr>(std::max(length, capacity)), nullptr, GL_DYNAMIC_DRAW);
  if (length > 0) glBufferSubData(target, 0, static_cast<GLsizeiptr>(length), data);
  glCheck("Buffer allocation");
  return handle;
}
GLuint buffer(GLenum target, const Bytes& bytes) { return buffer(target, bytes.data(), bytes.size()); }

/** One RGBA8 render target per size, plus the two uniform blocks every draw binds. */
struct Target {
  int width = 0, height = 0;
  GLuint texture = 0, framebuffer = 0;
};
struct Context {
  EGLDisplay display = EGL_NO_DISPLAY;
  GLuint uniforms = 0, look = 0, vertexArray = 0;
  std::map<std::pair<int, int>, Target> targets;
  std::string renderer, version;
};
Context start() {
  Context context;
  context.display = eglGetDisplay(EGL_DEFAULT_DISPLAY);
  check(context.display != EGL_NO_DISPLAY, "EGL display unavailable");
  EGLint major = 0, minor = 0;
  check(eglInitialize(context.display, &major, &minor) == EGL_TRUE, "EGL initialization failed");
  check(eglBindAPI(EGL_OPENGL_ES_API) == EGL_TRUE, "EGL API unavailable");
  const EGLint attributes[]{EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT_KHR, EGL_RED_SIZE, 8,
                            EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8, EGL_NONE};
  EGLConfig config{};
  EGLint count = 0;
  check(eglChooseConfig(context.display, attributes, &config, 1, &count) == EGL_TRUE && count == 1, "No GLES3 pbuffer config");
  const EGLint surfaceAttributes[]{EGL_WIDTH, 1, EGL_HEIGHT, 1, EGL_NONE};
  const EGLint contextAttributes[]{EGL_CONTEXT_CLIENT_VERSION, 3, EGL_NONE};
  const auto surface = eglCreatePbufferSurface(context.display, config, surfaceAttributes);
  const auto created = eglCreateContext(context.display, config, EGL_NO_CONTEXT, contextAttributes);
  check(surface != EGL_NO_SURFACE && created != EGL_NO_CONTEXT &&
          eglMakeCurrent(context.display, surface, surface, created) == EGL_TRUE,
        "EGL context unavailable");
  GLint glMajor = 0, glMinor = 0;
  glGetIntegerv(GL_MAJOR_VERSION, &glMajor);
  glGetIntegerv(GL_MINOR_VERSION, &glMinor);
  check(glMajor > 3 || (glMajor == 3 && glMinor >= 1), "GLES 3.1 required");
  context.renderer = reinterpret_cast<const char*>(glGetString(GL_RENDERER));
  context.version = reinterpret_cast<const char*>(glGetString(GL_VERSION));
  context.uniforms = buffer(GL_UNIFORM_BUFFER, nullptr, 0, uniformBytes);
  context.look = buffer(GL_UNIFORM_BUFFER, nullptr, 0, lookBytes);
  glGenVertexArrays(1, &context.vertexArray);
  glBindVertexArray(context.vertexArray);
  glDisable(GL_BLEND);
  glDisable(GL_DEPTH_TEST);
  glDisable(GL_DITHER);
  glDisable(GL_SCISSOR_TEST);
  glDisable(GL_STENCIL_TEST);
  return context;
}
const Target& target(Context& context, int width, int height) {
  auto& entry = context.targets[{width, height}];
  if (entry.texture != 0) return entry;
  entry.width = width;
  entry.height = height;
  glGenTextures(1, &entry.texture);
  glBindTexture(GL_TEXTURE_2D, entry.texture);
  glTexStorage2D(GL_TEXTURE_2D, 1, GL_RGBA8, width, height);
  glGenFramebuffers(1, &entry.framebuffer);
  glBindFramebuffer(GL_FRAMEBUFFER, entry.framebuffer);
  glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, entry.texture, 0);
  check(glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE, "Offscreen framebuffer incomplete");
  return entry;
}
/**
 * One draw, bound as OverlayRenderer.encode binds it (storage blocks 0-3 and
 * uniform block 0 from the generated GLES contract, the look at block 1), read
 * back top row first.
 */
Bytes draw(Context& context, GLuint program, int width, int height, GLuint pixels, GLuint lower, GLuint upper,
           GLuint resources, const Bytes& uniforms, const Bytes& look) {
  check(uniforms.size() == uniformBytes, "Uniform stride");
  check(look.size() >= 8 && look.size() <= lookBytes && look.size() % 8 == 0, "Look block length");
  const auto& output = target(context, width, height);
  glBindFramebuffer(GL_FRAMEBUFFER, output.framebuffer);
  glViewport(0, 0, width, height);
  glUseProgram(program);
  glBindBufferBase(GL_SHADER_STORAGE_BUFFER, 0, pixels);
  glBindBufferBase(GL_SHADER_STORAGE_BUFFER, 1, lower);
  glBindBufferBase(GL_SHADER_STORAGE_BUFFER, 2, upper);
  glBindBufferBase(GL_SHADER_STORAGE_BUFFER, 3, resources);
  glBindBuffer(GL_UNIFORM_BUFFER, context.uniforms);
  glBufferSubData(GL_UNIFORM_BUFFER, 0, uniformBytes, uniforms.data());
  glBindBufferBase(GL_UNIFORM_BUFFER, 0, context.uniforms);
  glBindBuffer(GL_UNIFORM_BUFFER, context.look);
  glBufferSubData(GL_UNIFORM_BUFFER, 0, static_cast<GLsizeiptr>(look.size()), look.data());
  glBindBufferBase(GL_UNIFORM_BUFFER, lookBinding, context.look);
  glClearColor(0, 0, 0, 0);
  glClear(GL_COLOR_BUFFER_BIT);
  glDrawArrays(GL_TRIANGLES, 0, 3);
  glFinish();
  glCheck("Render");
  Bytes bottomUp(static_cast<size_t>(width) * height * 4), topDown(bottomUp.size());
  glPixelStorei(GL_PACK_ALIGNMENT, 1);
  glReadPixels(0, 0, width, height, GL_RGBA, GL_UNSIGNED_BYTE, bottomUp.data());
  glCheck("Readback");
  for (int row = 0; row < height; row++)
    std::copy_n(bottomUp.data() + static_cast<size_t>(height - 1 - row) * width * 4, static_cast<size_t>(width) * 4,
                topDown.data() + static_cast<size_t>(row) * width * 4);
  return topDown;
}
std::vector<std::vector<std::string>> rows(const Bytes& bytes, size_t columns) {
  std::istringstream stream(std::string(bytes.begin(), bytes.end()));
  std::vector<std::vector<std::string>> output;
  std::string line;
  while (std::getline(stream, line)) {
    if (line.empty()) continue;
    std::istringstream fields(line);
    std::vector<std::string> row;
    std::string field;
    while (fields >> field) row.push_back(field);
    check(row.size() == columns, "Bad row: " + line);
    output.push_back(row);
  }
  return output;
}
struct Packet {
  GLuint pixels = 0, resources = 0;
  Bytes descriptors;
  std::map<std::pair<size_t, size_t>, GLuint> scenes;
  GLuint scene(size_t offset, size_t length) {
    auto& handle = scenes[{offset, length}];
    if (handle == 0) {
      check(offset + length <= descriptors.size() && length % 224 == 0 && length > 0, "Scene range");
      handle = buffer(GL_SHADER_STORAGE_BUFFER, descriptors.data() + offset, length);
    }
    return handle;
  }
};

int frames(const std::string& root) {
  auto context = start();
  const auto after = program(root, "after");
  const auto base = program(root, "base");
  size_t lookFrames = 0;
  std::map<std::string, Packet> packets;
  mkdir((root + "/out").c_str(), 0700);
  const auto list = rows(read(root, "frames.tsv", 1 << 20), 8);
  const auto started = std::chrono::steady_clock::now();
  for (const auto& row : list) {
    const auto& name = row[0];
    auto& packet = packets[row[1]];
    if (packet.pixels == 0) {
      packet.pixels = buffer(GL_SHADER_STORAGE_BUFFER, read(root, row[1] + "/pixels.bin"));
      packet.resources = buffer(GL_SHADER_STORAGE_BUFFER, read(root, row[1] + "/resources.bin"));
      packet.descriptors = read(root, row[1] + "/descriptors.bin", 1 << 20);
    }
    const int width = std::stoi(row[2]), height = std::stoi(row[3]);
    const auto lower = packet.scene(std::stoul(row[4]), std::stoul(row[5]));
    const auto upper = packet.scene(std::stoul(row[6]), std::stoul(row[7]));
    const auto look = read(root, "frames/" + name + ".look", lookBytes);
    const bool shaped = look.size() >= 2 && (look[0] | look[1]) != 0;
    lookFrames += shaped;
    const auto rgba = draw(context, shaped ? after : base, width, height, packet.pixels, lower, upper, packet.resources,
                           read(root, "frames/" + name + ".uniforms", uniformBytes), look);
    save(root + "/out/" + name + ".rgba", rgba);
  }
  const auto seconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();
  std::cout << "{\"status\":\"RENDERED\",\"frames\":" << list.size() << ",\"lookFrames\":" << lookFrames << ",\"seconds\":" << seconds << ",\"renderer\":\""
            << context.renderer << "\",\"version\":\"" << context.version << "\"}" << std::endl;
  return 0;
}

/** Pixels that differ between two renders, and the largest channel error. */
struct Difference {
  uint64_t changed = 0;
  int maximum = 0;
};
Difference difference(const Bytes& before, const Bytes& now) {
  Difference result;
  for (size_t pixel = 0; pixel < before.size(); pixel += 4) {
    int error = 0;
    for (size_t channel = 0; channel < 4; channel++)
      error = std::max(error, std::abs(static_cast<int>(before[pixel + channel]) - static_cast<int>(now[pixel + channel])));
    result.changed += error > 0;
    result.maximum = std::max(result.maximum, error);
  }
  return result;
}

/**
 * Every golden sample through the baseline shader, today's base program (every
 * frame without the look) and today's look program with a zero header: both must
 * match the baseline byte for byte.
 */
int parity(const std::string& root) {
  auto context = start();
  const auto baseline = program(root, "baseline"), base = program(root, "base"), after = program(root, "after");
  const auto pixels = buffer(GL_SHADER_STORAGE_BUFFER, read(root, "golden/pixels.bin"));
  const auto resources = buffer(GL_SHADER_STORAGE_BUFFER, read(root, "golden/resources.bin"));
  std::map<std::string, Packet> variants;
  for (const auto* name : {"transition", "editor"}) variants[name].descriptors = read(root, std::string("golden/descriptors-") + name + ".bin", 1 << 20);
  const Bytes off(8, 0);
  const auto samples = rows(read(root, "golden/samples.tsv", 1 << 16), 8);
  size_t identicalBase = 0, identicalLook = 0;
  uint64_t changedBase = 0, changedLook = 0;
  int maximumBase = 0, maximumLook = 0;
  std::ostringstream report;
  for (const auto& row : samples) {
    auto& packet = variants.at(row[7]);
    const int width = std::stoi(row[1]), height = std::stoi(row[2]);
    const auto lower = packet.scene(std::stoul(row[3]), std::stoul(row[4]));
    const auto upper = packet.scene(std::stoul(row[5]), std::stoul(row[6]));
    const auto uniforms = read(root, "golden/uniforms-" + row[0] + ".bin", uniformBytes);
    const auto before = draw(context, baseline, width, height, pixels, lower, upper, resources, uniforms, off);
    const auto viaBase = draw(context, base, width, height, pixels, lower, upper, resources, uniforms, off);
    const auto viaLook = draw(context, after, width, height, pixels, lower, upper, resources, uniforms, off);
    const auto baseDifference = difference(before, viaBase), lookDifference = difference(before, viaLook);
    identicalBase += before == viaBase;
    identicalLook += before == viaLook;
    changedBase += baseDifference.changed;
    changedLook += lookDifference.changed;
    maximumBase = std::max(maximumBase, baseDifference.maximum);
    maximumLook = std::max(maximumLook, lookDifference.maximum);
    report << (report.tellp() > 0 ? "," : "") << "{\"name\":\"" << row[0] << "\",\"baseIdentical\":" << (before == viaBase ? "true" : "false")
           << ",\"lookOffIdentical\":" << (before == viaLook ? "true" : "false") << ",\"lookOffChangedPixels\":" << lookDifference.changed
           << ",\"lookOffMaxChannelError\":" << lookDifference.maximum << "}";
  }
  const bool passed = identicalBase == samples.size() && identicalLook == samples.size();
  std::ostringstream summary;
  summary << "{\"status\":\"" << (passed ? "PASS_LOOK_OFF_IDENTICAL" : "FAIL_LOOK_OFF_DIFFERS") << "\",\"samples\":" << samples.size()
          << ",\"base\":{\"identicalSamples\":" << identicalBase << ",\"changedPixels\":" << changedBase << ",\"maxChannelError\":" << maximumBase
          << "},\"lookProgramOff\":{\"identicalSamples\":" << identicalLook << ",\"changedPixels\":" << changedLook
          << ",\"maxChannelError\":" << maximumLook << "},\"renderer\":\"" << context.renderer << "\",\"version\":\"" << context.version
          << "\",\"rows\":[" << report.str() << "]}";
  mkdir((root + "/out").c_str(), 0700);
  std::ofstream(root + "/out/parity.json") << summary.str();
  std::cout << summary.str() << std::endl;
  return passed ? 0 : 3;
}
}  // namespace

int main(int argc, char** argv) {
  alarm(3600);  // A lost host connection cannot leave this running.
  try {
    check(argc == 3, "Usage: gles-look frames|parity <root>");
    const std::string mode(argv[1]), root(argv[2]);
    check(root.rfind("/data/local/tmp/board-motion-gles-", 0) == 0 && root.find("..") == std::string::npos, "Unowned root");
    if (mode == "frames") return frames(root);
    if (mode == "parity") return parity(root);
    throw std::runtime_error("Unknown mode " + mode);
  } catch (const std::exception& error) {
    std::cerr << error.what() << std::endl;
    return 1;
  }
}
