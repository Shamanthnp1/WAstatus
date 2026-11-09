package com.wastatusvideo.statusdrop

import android.Manifest
import android.app.Activity
import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import com.wastatusvideo.statusdrop.selfhost.SelfHostService
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * MAX edition: the self-host delivery channel (see SelfHostService and
 * selfhost/src/bot.mjs). The global edition has an empty version of this
 * class in src/global, so the Play build contains none of this code.
 */
class SelfHostChannel(private val activity: Activity) {
    companion object {
        const val CHANNEL = "com.wastatusvideo.statusdrop/selfhost"
        private const val PREFS = "selfhost"
        private const val SETTINGS_KEY = "settings"
        private const val NOTIFICATION_PERMISSION_REQUEST = 4108

        // Matches Baileys' own video thumbnail width, as the server sends.
        private const val THUMBNAIL_WIDTH = 32
    }

    private val executor: ExecutorService = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())

    fun register(messenger: BinaryMessenger) {
        MethodChannel(messenger, CHANNEL).setMethodCallHandler(::handle)
    }

    fun dispose() {
        executor.shutdownNow()
    }

    private fun handle(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "start" -> {
                try {
                    activity.startForegroundService(Intent(activity, SelfHostService::class.java))
                    result.success(null)
                } catch (error: Exception) {
                    result.error("SELF_HOST_START_FAILED", error.message ?: "Could not start self-host delivery.", null)
                }
            }
            "stop" -> {
                if (readBridgeInfo() != null) {
                    activity.startService(
                        Intent(activity, SelfHostService::class.java).setAction(SelfHostService.ACTION_STOP),
                    )
                }
                result.success(null)
            }
            "bridgeInfo" -> result.success(readBridgeInfo())
            "getSettings" -> result.success(
                activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(SETTINGS_KEY, null),
            )
            "setSettings" -> {
                val json = call.argument<String>("json")
                if (json == null || json.length > 4096) {
                    result.error("INVALID_SETTINGS", "Settings are missing or too large.", null)
                    return
                }
                activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().putString(SETTINGS_KEY, json).apply()
                result.success(null)
            }
            "clipThumbnail" -> clipThumbnail(call, result)
            "requestNotificationPermission" -> requestNotificationPermission(result)
            else -> result.notImplemented()
        }
    }

    /**
     * The bot's address, or null when it is not running. A bot process that
     * was killed (app update, force stop, low memory) cannot delete its
     * bridge file, so the file alone proves nothing: also check that the pid
     * in it is our live ":selfhost" process, and remove a stale file.
     */
    private fun readBridgeInfo(): Map<String, Any?>? {
        val file = SelfHostService.bridgeFile(activity)
        if (!file.isFile) return null
        return try {
            val json = JSONObject(file.readText())
            val pid = json.optInt("pid")
            if (!isSelfHostProcessAlive(pid)) {
                file.delete()
                return null
            }
            mapOf("port" to json.getInt("port"), "token" to json.getString("token"), "pid" to pid)
        } catch (_: Exception) {
            null
        }
    }

    private fun isSelfHostProcessAlive(pid: Int): Boolean {
        if (pid <= 0) return false
        val manager = activity.getSystemService(ActivityManager::class.java) ?: return false
        return manager.runningAppProcesses.orEmpty().any { process ->
            process.pid == pid && process.processName.endsWith(":selfhost")
        }
    }

    private fun clipThumbnail(call: MethodCall, result: MethodChannel.Result) {
        val path = call.argument<String>("path")
        if (path.isNullOrBlank()) {
            result.error("INVALID_PATH", "A clip path is required.", null)
            return
        }
        executor.execute {
            val retriever = MediaMetadataRetriever()
            try {
                val file = File(path).canonicalFile
                val root = File(activity.cacheDir, "processed").canonicalFile
                require(file.path.startsWith(root.path + File.separator) && file.isFile) {
                    "Thumbnails are only made for StatusDrop's own clips."
                }
                retriever.setDataSource(file.absolutePath)
                val width = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
                val height = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
                val targetHeight = if (width > 0 && height > 0) {
                    (THUMBNAIL_WIDTH * height / width).coerceAtLeast(1)
                } else {
                    THUMBNAIL_WIDTH * 16 / 9
                }
                val frame = retriever.getScaledFrameAtTime(
                    0,
                    MediaMetadataRetriever.OPTION_CLOSEST_SYNC,
                    THUMBNAIL_WIDTH,
                    targetHeight,
                ) ?: error("Could not read a frame from the clip.")
                val bytes = ByteArrayOutputStream().use { output ->
                    frame.compress(Bitmap.CompressFormat.JPEG, 80, output)
                    output.toByteArray()
                }
                frame.recycle()
                val encoded = Base64.encodeToString(bytes, Base64.NO_WRAP)
                mainHandler.post { result.success(encoded) }
            } catch (error: Exception) {
                mainHandler.post { result.error("THUMBNAIL_FAILED", error.message, null) }
            } finally {
                retriever.release()
            }
        }
    }

    private fun requestNotificationPermission(result: MethodChannel.Result) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            result.success(true)
            return
        }
        val granted = activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        if (!granted) {
            activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), NOTIFICATION_PERMISSION_REQUEST)
        }
        result.success(granted)
    }
}
