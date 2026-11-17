#include <jni.h>
#include <cstdint>
#include <mutex>
#include <unordered_map>
#include <array>
#include <new>
#include "gpu_packet_ownership.h"

namespace {
std::mutex owned_mutex;
std::unordered_map<void *, uint32_t> owned_buffers;

void close_metadata(const AuraGpuBytes &handles) {
    if (!handles.pointer || handles.length % 8 || handles.length > 769 * 8) return;
    for (uint32_t at=0; at<handles.length; at+=8) {
        uint64_t id=0;
        for (uint32_t byte=0; byte<8; ++byte) id |= uint64_t(handles.pointer[at+byte]) << (byte*8);
        board_renderer_gpu_handle_close(id);
    }
}
void cleanup(std::array<AuraGpuBytes,3> &buffers, uint64_t handle, int metadata) {
    if (metadata>=0) close_metadata(buffers[metadata]);
    if (handle) board_renderer_gpu_handle_close(handle);
    for (const auto &buffer: buffers) board_renderer_free(buffer.pointer,buffer.length);
}

jobject result(JNIEnv *env,int32_t status,uint64_t handle,std::array<AuraGpuBytes,3> buffers,jsize count,int metadata=-1) {
    jclass buffer_class=env->FindClass("java/nio/ByteBuffer");
    jobjectArray array=buffer_class ? env->NewObjectArray(count,buffer_class,nullptr) : nullptr;
    if (!array) { cleanup(buffers,handle,metadata);return nullptr; }
    for (jsize index=0;index<count;++index) {
        const auto &buffer=buffers[index];
        if(buffer.length && !buffer.pointer) {
            cleanup(buffers,handle,metadata);
            jclass error=env->FindClass("java/lang/IllegalStateException");
            if(error)env->ThrowNew(error,"Invalid native GPU buffer ownership");
            return nullptr;
        }
        jobject direct=env->NewDirectByteBuffer(aura_gpu_direct_buffer_address(buffer),buffer.length);
        if (!direct) { cleanup(buffers,handle,metadata);return nullptr; }
        env->SetObjectArrayElement(array,index,direct);
        env->DeleteLocalRef(direct);
        if (env->ExceptionCheck()) { cleanup(buffers,handle,metadata);return nullptr; }
    }
    jclass type=env->FindClass("com/boardsesh/boardrenderer/GpuPacketResult");
    jmethodID constructor=type ? env->GetMethodID(type,"<init>","(IJ[Ljava/nio/ByteBuffer;)V") : nullptr;
    jobject output=constructor ? env->NewObject(type,constructor,status,static_cast<jlong>(handle),array) : nullptr;
    if (!output || env->ExceptionCheck()) { cleanup(buffers,handle,metadata);return nullptr; }
    try {
        std::lock_guard<std::mutex> lock(owned_mutex);
        for (const auto &buffer:buffers) if (buffer.pointer && buffer.length) owned_buffers.emplace(buffer.pointer,buffer.length);
    } catch (const std::bad_alloc &) {
        { std::lock_guard<std::mutex> lock(owned_mutex);for(const auto &buffer:buffers)owned_buffers.erase(buffer.pointer); }
        cleanup(buffers,handle,metadata);
        if (!env->ExceptionCheck()) { jclass error=env->FindClass("java/lang/OutOfMemoryError");if(error)env->ThrowNew(error,"GPU transfer ownership allocation failed"); }
        return nullptr;
    }
    return output;
}

jlongArray id_result(JNIEnv *env,int32_t status,uint64_t id) {
    jlongArray output=env->NewLongArray(2);
    if (!output) { if(id)board_renderer_gpu_handle_close(id);return nullptr; }
    jlong entries[]={status,static_cast<jlong>(id)};
    env->SetLongArrayRegion(output,0,2,entries);
    if (env->ExceptionCheck()) { if(id)board_renderer_gpu_handle_close(id);return nullptr; }
    return output;
}

struct Input {
    JNIEnv *env;
    jbyteArray array;
    jbyte *bytes;
    jsize length;
    Input(JNIEnv *environment,jbyteArray input,uint32_t maximum):env(environment),array(input),bytes(nullptr),length(0) {
        if (!input) return;
        length=env->GetArrayLength(input);
        if(length<0 || static_cast<uint32_t>(length)>maximum)return;
        bytes=env->GetByteArrayElements(input,nullptr);
    }
    ~Input(){if(bytes)env->ReleaseByteArrayElements(array,bytes,JNI_ABORT);}
    const uint8_t *pointer()const{return reinterpret_cast<const uint8_t *>(bytes);}
    bool valid()const{return bytes!=nullptr;}
};
}

extern "C" JNIEXPORT jlongArray JNICALL
Java_com_boardsesh_boardrenderer_GpuPacketBridge_nativeCancelCreate(JNIEnv *env,jobject) {
    uint64_t id=0;int32_t status=board_renderer_gpu_cancel_create(&id);return id_result(env,status,id);
}
extern "C" JNIEXPORT jlongArray JNICALL
Java_com_boardsesh_boardrenderer_GpuPacketBridge_nativeSessionCreate(JNIEnv *env,jobject,jbyteArray config,jlong cancel) {
    Input input(env,config,8*1024*1024);if(!input.valid())return env->ExceptionCheck()?nullptr:id_result(env,-1,0);
    uint64_t id=0;int32_t status=board_renderer_gpu_session_create(input.pointer(),input.length,static_cast<uint64_t>(cancel),&id);
    return id_result(env,status,id);
}
extern "C" JNIEXPORT jobject JNICALL
Java_com_boardsesh_boardrenderer_GpuPacketBridge_nativePlanCreate(JNIEnv *env,jobject,jlong session,jbyteArray request,jlong cancel) {
    Input input(env,request,128*1024);if(env->ExceptionCheck())return nullptr;AuraGpuPlan output{};
    int32_t status=input.valid()?board_renderer_gpu_plan_create(session,input.pointer(),input.length,cancel,&output):-1;
    return result(env,status,output.handle,{output.header,{},{}},1);
}
extern "C" JNIEXPORT jobject JNICALL
Java_com_boardsesh_boardrenderer_GpuPacketBridge_nativePlanPrepare(JNIEnv *env,jobject,jlong plan,jbyteArray resident,jlong cancel) {
    Input input(env,resident,256*1024);if(env->ExceptionCheck())return nullptr;AuraGpuChunks output{};
    int32_t status=input.valid()?board_renderer_gpu_plan_prepare(plan,input.pointer(),input.length,cancel,&output):-1;
    return result(env,status,0,{output.header,output.pixels,output.handles},3,2);
}
extern "C" JNIEXPORT jobject JNICALL
Java_com_boardsesh_boardrenderer_GpuPacketBridge_nativePlanEncode(JNIEnv *env,jobject,jlong plan,jbyteArray placements,jlong cancel) {
    Input input(env,placements,256*1024);if(env->ExceptionCheck())return nullptr;AuraGpuPacket output{};
    int32_t status=input.valid()?board_renderer_gpu_plan_encode(plan,input.pointer(),input.length,cancel,&output):-1;
    return result(env,status,output.handle,{output.header,output.descriptors,output.resources},3);
}
extern "C" JNIEXPORT void JNICALL
Java_com_boardsesh_boardrenderer_GpuPacketBridge_cancel(JNIEnv *,jobject,jlong handle){board_renderer_gpu_cancel(handle);}
extern "C" JNIEXPORT void JNICALL
Java_com_boardsesh_boardrenderer_GpuPacketBridge_closeHandle(JNIEnv *,jobject,jlong handle){board_renderer_gpu_handle_close(handle);}
extern "C" JNIEXPORT void JNICALL
Java_com_boardsesh_boardrenderer_GpuPacketBridge_freeBuffer(JNIEnv *env,jobject,jobject buffer){
    void *pointer=env->GetDirectBufferAddress(buffer);const jlong length=env->GetDirectBufferCapacity(buffer);uint32_t owned=0;
    {std::lock_guard<std::mutex> lock(owned_mutex);auto entry=owned_buffers.find(pointer);
     if(entry==owned_buffers.end()||length!=entry->second)return;owned=entry->second;owned_buffers.erase(entry);}
    board_renderer_free(static_cast<uint8_t *>(pointer),owned);
}
extern "C" JNIEXPORT jint JNICALL
Java_com_boardsesh_boardrenderer_GpuPacketBridge_setCacheDirectory(JNIEnv *env,jobject,jlong session,jbyteArray path){
    Input input(env,path,4096);return input.valid()?board_renderer_gpu_session_set_cache_directory(session,input.pointer(),input.length):-1;
}
extern "C" JNIEXPORT jint JNICALL
Java_com_boardsesh_boardrenderer_GpuPacketBridge_schedulePersist(JNIEnv *,jobject,jlong session){return board_renderer_gpu_session_schedule_persist(session);}
extern "C" JNIEXPORT jint JNICALL
Java_com_boardsesh_boardrenderer_GpuPacketBridge_encodeUniforms(JNIEnv *env,jobject,jlong packet,jint lower,jint upper,jint revealMode,jfloat progress,jfloat swapLower,jfloat swapUpper,jfloat swapShared,jfloat pulse,jfloat width,jfloat height,jboolean empty,jboolean mirrored,jobject destination,jint length){
    void *pointer=env->GetDirectBufferAddress(destination);jlong capacity=env->GetDirectBufferCapacity(destination);
    if(!pointer||length<0||capacity<length||revealMode<0)return -1;
    return board_renderer_gpu_packet_shared_reveal_uniforms(packet,lower,upper,revealMode,progress,swapLower,swapUpper,swapShared,pulse,width,height,empty?1:0,mirrored?1:0,static_cast<uint8_t *>(pointer),length);
}
extern "C" JNIEXPORT jobject JNICALL
Java_com_boardsesh_boardrenderer_GpuPacketBridge_nativeContract(JNIEnv *env,jobject){
    AuraGpuBytes output{};int32_t status=board_renderer_gpu_packet_contract(&output);
    return result(env,status,0,{output,{},{}},1);
}
extern "C" JNIEXPORT jint JNICALL
Java_com_boardsesh_boardrenderer_GpuPacketBridge_packetApiVersion(JNIEnv *,jobject){return board_renderer_gpu_packet_api_version();}
extern "C" JNIEXPORT jobject JNICALL
Java_com_boardsesh_boardrenderer_GpuPacketBridge_nativeStats(JNIEnv *env,jobject) {
    AuraGpuBytes output{};int32_t status=board_renderer_gpu_packet_stats(&output);
    return result(env,status,0,{output,{},{}},1);
}
