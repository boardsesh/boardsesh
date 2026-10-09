package com.boardsesh.mobilecpuprofile

import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.Process
import android.os.SystemClock
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.InputStream
import java.security.MessageDigest

class MobileCpuProfileModule : Module() {
  private fun digest(stream: InputStream): String {
    val checksum = MessageDigest.getInstance("SHA-256")
    stream.use { input ->
      val buffer = ByteArray(65536)
      while (true) {
        val read = input.read(buffer)
        if (read < 0) break
        checksum.update(buffer, 0, read)
      }
    }
    return checksum.digest().joinToString("") { "%02x".format(it) }
  }

  override fun definition() = ModuleDefinition {
    Name("MobileCpuProfile")
    AsyncFunction("snapshot") {
      mapOf("cpuMs" to Process.getElapsedCpuTime().toDouble(),
        "monotonicMs" to SystemClock.elapsedRealtime().toDouble(), "pid" to Process.myPid())
    }
    AsyncFunction("identity") {
      val context = requireNotNull(appContext.reactContext)
      val application = context.packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA)
      val metadata = requireNotNull(application.metaData)
      check(metadata.containsKey("expo.modules.updates.ENABLED")) { "Explicit OTA setting missing" }
      val fingerprint = Build.FINGERPRINT.lowercase()
      val emulator = fingerprint.contains("generic") || fingerprint.contains("emulator") || Build.MODEL.contains("sdk_gphone") || Build.HARDWARE.contains("goldfish") || Build.HARDWARE.contains("ranchu")
      mapOf("appId" to context.packageName,
        "configuration" to if ((application.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0) "Debug" else "Release",
        "platform" to "android", "physical" to !emulator, "pid" to Process.myPid(),
        "model" to "${Build.MANUFACTURER} ${Build.MODEL}", "osVersion" to "${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})",
        "otaEnabled" to metadata.getBoolean("expo.modules.updates.ENABLED"),
        "embeddedBundleSha256" to digest(context.assets.open("index.android.bundle")),
        "artifactSha256" to digest(File(application.sourceDir).inputStream()),
        "cpuClock" to "android-process-elapsed-cpu-ms")
    }
  }
}
