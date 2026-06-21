cmake_minimum_required(VERSION 3.22)
project(board_renderer_jni)

add_library(board_renderer_jni SHARED jni_bridge.cpp)

# Link by library name so Android records DT_NEEDED as
# libboard_renderer_ffi.so, not this machine's absolute source path.
target_link_directories(board_renderer_jni PRIVATE ${CMAKE_SOURCE_DIR}/../jniLibs/${ANDROID_ABI})
target_link_libraries(board_renderer_jni PRIVATE board_renderer_ffi log)

# 16 KB-align LOAD segments for Android 15+ 16 KB-page devices / Play upload (the
# NDK that ships with RN still defaults to 4 KB); mirrors the FFI flag in
# scripts/build-native-renderer.sh, and is a no-op on 4 KB devices.
target_link_options(board_renderer_jni PRIVATE "-Wl,-z,max-page-size=16384")
