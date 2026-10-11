#include <jni.h>
#include <cstdlib>
// Kept as an owned, named C++ frame so capture verification checks symbolication.
extern "C" JNIEXPORT void JNICALL
Java_com_boardsesh_diagnostics_MobileDiagnosticsModule_nativeAbort(JNIEnv*, jobject) {
    std::abort();
}
