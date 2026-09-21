package com.wastatusvideo.statusdrop

import android.app.Activity
import android.content.Intent
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.provider.OpenableColumns
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

class MainActivity : FlutterActivity() {
    companion object {
        const val METHOD_CHANNEL = "com.wastatusvideo.statusdrop/video"
        const val EVENT_CHANNEL = "com.wastatusvideo.statusdrop/video_events"
        const val MAX_FILES = 3
        const val PICK_VIDEOS_REQUEST = 4107
    }

    private val ioExecutor = Executors.newSingleThreadExecutor()
    private var eventSink: EventChannel.EventSink? = null
    private var pendingPickResult: MethodChannel.Result? = null
    private var pendingMaxFiles = MAX_FILES
    private val videoProcessor by lazy {
        LocalVideoProcessor(applicationContext) { event ->
            runOnUiThread { eventSink?.success(event) }
        }
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        EventChannel(flutterEngine.dartExecutor.binaryMessenger, EVENT_CHANNEL)
            .setStreamHandler(object : EventChannel.StreamHandler {
                override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
                    eventSink = events
                }

                override fun onCancel(arguments: Any?) {
                    eventSink = null
                }
            })

        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, METHOD_CHANNEL)
            .setMethodCallHandler(::handleMethodCall)
    }

    private fun handleMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "platformReady" -> result.success(true)
            "pickVideos" -> pickVideos(call, result)
            "startProcessing" -> startProcessing(call, result)
            "getProcessedClips" -> result.success(videoProcessor.getProcessedClips())
            "cancelProcessing" -> {
                videoProcessor.cancel()
                result.success(null)
            }
            "clearProcessedClips" -> clearProcessedClips(result)
            "openExternalUrl" -> openExternalUrl(call, result)
            "deleteCachedFile" -> deleteCachedFile(call, result)
            "clearCache" -> clearAppCache(result)
            else -> result.notImplemented()
        }
    }

    private fun startProcessing(call: MethodCall, result: MethodChannel.Result) {
        try {
            videoProcessor.start(
                rawVideos = call.argument<List<Any?>>("videos"),
                profileId = call.argument<String>("profile"),
            )
            result.success(null)
        } catch (error: IllegalStateException) {
            result.error("PROCESSING_BUSY", error.message, null)
        } catch (error: IllegalArgumentException) {
            result.error("INVALID_PROCESSING_REQUEST", error.message, null)
        }
    }

    private fun openExternalUrl(call: MethodCall, result: MethodChannel.Result) {
        val url = call.argument<String>("url")
        val uri = url?.let(Uri::parse)
        val scheme = uri?.scheme?.lowercase()
        val host = uri?.host?.lowercase()
        val path = uri?.path.orEmpty().trimEnd('/')
        val mailAddress = uri?.schemeSpecificPart
            ?.substringBefore('?')
            ?.lowercase()

        val allowed = when {
            scheme == "https" && host == "wa.me" -> true
            scheme == "https" && host == "ig.me" && path == "/m/xd.sapphire" -> true
            scheme == "https" && host in setOf("wastatusvideo.com", "www.wastatusvideo.com") &&
                path == "/privacy.html" -> true
            scheme == "https" && host == "github.com" &&
                path == "/Shamanthnp1/WAstatus/tree/main/mobile/statusdrop_app" -> true
            scheme == "mailto" && mailAddress == "shamanthnadumane@gmail.com" -> true
            else -> false
        }
        if (uri == null || !allowed) {
            result.error("INVALID_URL", "This external link is not allowed.", null)
            return
        }

        try {
            val action = if (scheme == "mailto") Intent.ACTION_SENDTO else Intent.ACTION_VIEW
            startActivity(Intent(action, uri))
            result.success(null)
        } catch (error: Exception) {
            result.error("OPEN_URL_FAILED", "Could not open this link on your phone.", null)
        }
    }

    @Suppress("DEPRECATION")
    private fun pickVideos(call: MethodCall, result: MethodChannel.Result) {
        if (pendingPickResult != null) {
            result.error("PICK_IN_PROGRESS", "The video picker is already open.", null)
            return
        }
        pendingPickResult = result
        pendingMaxFiles = (call.argument<Int>("maxFiles") ?: MAX_FILES).coerceIn(1, MAX_FILES)

        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "video/*"
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, pendingMaxFiles > 1)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        }
        try {
            startActivityForResult(intent, PICK_VIDEOS_REQUEST)
        } catch (error: Exception) {
            pendingPickResult = null
            result.error("PICKER_UNAVAILABLE", "No video picker is available on this device.", null)
        }
    }

    @Deprecated("Uses the Android document picker callback supported by FlutterActivity")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != PICK_VIDEOS_REQUEST) {
            super.onActivityResult(requestCode, resultCode, data)
            return
        }

        val result = pendingPickResult
        pendingPickResult = null
        if (result == null) return
        if (resultCode != Activity.RESULT_OK) {
            result.success(emptyList<Map<String, Any?>>())
            return
        }

        val uris = mutableListOf<Uri>()
        val clipData = data?.clipData
        if (clipData != null) {
            for (index in 0 until clipData.itemCount) {
                uris.add(clipData.getItemAt(index).uri)
            }
        } else {
            data?.data?.let(uris::add)
        }

        if (uris.isEmpty()) {
            result.success(emptyList<Map<String, Any?>>())
            return
        }

        val selected = uris.take(pendingMaxFiles.coerceIn(1, MAX_FILES))
        ioExecutor.execute {
            val videos = mutableListOf<Map<String, Any?>>()
            try {
                selected.forEach { uri -> videos.add(copyPickedVideo(uri)) }
                runOnUiThread { result.success(videos) }
            } catch (error: Exception) {
                videos.forEach { video ->
                    (video["path"] as? String)?.let { path -> File(path).delete() }
                }
                runOnUiThread {
                    result.error(
                        "PICK_FAILED",
                        error.message ?: "Could not read the selected video.",
                        null,
                    )
                }
            }
        }
    }

    private fun copyPickedVideo(uri: Uri): Map<String, Any?> {
        try {
            contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (_: SecurityException) {
            // Some document providers grant only temporary permission; copying now is sufficient.
        }

        val originalName = queryDisplayName(uri) ?: "video_${System.currentTimeMillis()}.mp4"
        val safeName = originalName
            .replace(Regex("[^A-Za-z0-9._-]"), "_")
            .takeLast(120)
            .ifBlank { "video.mp4" }
        val selectedDir = File(cacheDir, "selected").apply { mkdirs() }
        val target = File(selectedDir, "${UUID.randomUUID()}_$safeName")

        try {
            contentResolver.openInputStream(uri).use { input ->
                requireNotNull(input) { "The selected video could not be opened." }
                target.outputStream().use { output -> input.copyTo(output) }
            }

            if (target.length() <= 0) {
                error("The selected video is empty.")
            }

            val metadata = readVideoMetadata(target)
            return mapOf(
                "id" to UUID.randomUUID().toString(),
                "path" to target.absolutePath,
                "name" to originalName,
                "sizeBytes" to target.length(),
                "durationSeconds" to metadata.durationSeconds,
                "width" to metadata.width,
                "height" to metadata.height,
            )
        } catch (error: Exception) {
            target.delete()
            throw error
        }
    }

    private fun queryDisplayName(uri: Uri): String? =
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { cursor ->
                if (!cursor.moveToFirst()) return@use null
                val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (index < 0) null else cursor.getString(index)
            }

    private fun readVideoMetadata(file: File): VideoMetadata {
        val retriever = MediaMetadataRetriever()
        return try {
            retriever.setDataSource(file.absolutePath)
            val durationMs = retriever
                .extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
                ?.toLongOrNull()
                ?: 0L
            var width = retriever
                .extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)
                ?.toIntOrNull()
                ?: 0
            var height = retriever
                .extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)
                ?.toIntOrNull()
                ?: 0
            val rotation = retriever
                .extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)
                ?.toIntOrNull()
                ?: 0
            if (rotation == 90 || rotation == 270) {
                val oldWidth = width
                width = height
                height = oldWidth
            }
            VideoMetadata(durationMs / 1000.0, width, height)
        } finally {
            retriever.release()
        }
    }

    private fun clearProcessedClips(result: MethodChannel.Result) {
        if (videoProcessor.isProcessing) {
            result.error("PROCESSING_BUSY", "Cancel processing before changing the selection.", null)
            return
        }
        ioExecutor.execute {
            try {
                videoProcessor.clearProcessedOutputs()
                runOnUiThread { result.success(null) }
            } catch (error: Exception) {
                runOnUiThread { result.error("CLEAR_PROCESSED_FAILED", error.message, null) }
            }
        }
    }

    private fun deleteCachedFile(call: MethodCall, result: MethodChannel.Result) {
        if (videoProcessor.isProcessing) {
            result.error("PROCESSING_BUSY", "Wait for processing to finish before removing files.", null)
            return
        }
        val path = call.argument<String>("path")
        if (path.isNullOrBlank()) {
            result.error("INVALID_PATH", "A cached file path is required.", null)
            return
        }
        ioExecutor.execute {
            try {
                val deleted = deleteIfInsideCache(path)
                runOnUiThread { result.success(deleted) }
            } catch (error: Exception) {
                runOnUiThread { result.error("DELETE_FAILED", error.message, null) }
            }
        }
    }

    private fun clearAppCache(result: MethodChannel.Result) {
        if (videoProcessor.isProcessing) {
            result.error("PROCESSING_BUSY", "Cancel processing before clearing files.", null)
            return
        }
        ioExecutor.execute {
            try {
                videoProcessor.clearProcessedOutputs()
                listOf("selected", "processed").forEach { name ->
                    File(cacheDir, name).deleteRecursively()
                }
                runOnUiThread { result.success(null) }
            } catch (error: Exception) {
                runOnUiThread { result.error("CLEAR_FAILED", error.message, null) }
            }
        }
    }

    private fun deleteIfInsideCache(path: String): Boolean {
        val file = File(path).canonicalFile
        val ownedRoots = listOf("selected", "processed").map { name ->
            File(cacheDir, name).canonicalFile
        }
        require(ownedRoots.any { root -> file.path.startsWith(root.path + File.separator) }) {
            "Refusing to delete a file outside StatusDrop media storage."
        }
        return !file.exists() || file.delete()
    }

    override fun onDestroy() {
        pendingPickResult?.error("ACTIVITY_DESTROYED", "The picker was closed.", null)
        pendingPickResult = null
        videoProcessor.shutdown()
        ioExecutor.shutdownNow()
        super.onDestroy()
    }

    private data class VideoMetadata(
        val durationSeconds: Double,
        val width: Int,
        val height: Int,
    )
}
