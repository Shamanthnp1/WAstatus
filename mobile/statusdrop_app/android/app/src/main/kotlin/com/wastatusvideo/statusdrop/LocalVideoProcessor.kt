package com.wastatusvideo.statusdrop

import android.content.Context
import android.media.MediaMetadataRetriever
import android.os.PowerManager
import com.arthenica.ffmpegkit.FFmpegKit
import com.arthenica.ffmpegkit.FFmpegSession
import com.arthenica.ffmpegkit.FFmpegSessionCompleteCallback
import com.arthenica.ffmpegkit.LogCallback
import com.arthenica.ffmpegkit.ReturnCode
import com.arthenica.ffmpegkit.StatisticsCallback
import java.io.File
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.ceil
import kotlin.math.min

/** Runs one bounded, sequential FFmpeg job and owns all generated app-cache files. */
class LocalVideoProcessor(
    context: Context,
    private val emitOnPlatformThread: (Map<String, Any?>) -> Unit,
) {
    companion object {
        private const val MAX_FILES = 3
        private const val MAX_TOTAL_BYTES = 300L * 1024L * 1024L
        private const val MAX_CLIP_BYTES = 15_800_000L
        private const val MAX_OUTPUT_CLIPS = 20
        private const val MAX_ATTEMPTS = 3
        private const val WAKE_LOCK_WINDOW_MS = 30L * 60L * 1000L
    }

    private val cacheDir = context.cacheDir
    private val processingExecutor = Executors.newSingleThreadExecutor()
    private val progressLock = Any()
    private val wakeLock = context.getSystemService(PowerManager::class.java).newWakeLock(
        PowerManager.PARTIAL_WAKE_LOCK,
        "StatusDrop::LocalCompression",
    )

    @Volatile
    var isProcessing: Boolean = false
        private set

    @Volatile
    private var cancelRequested = false

    private var terminalCommitted = false

    @Volatile
    private var activeSessionId: Long? = null

    @Volatile
    private var publishedClips: List<Map<String, Any?>> = emptyList()

    private var lastProgress = 0.0

    @Synchronized
    fun start(rawVideos: List<*>?, profileId: String?) {
        check(!isProcessing) { "A video job is already running." }
        val profile = EncodingProfile.fromId(profileId)
            ?: throw IllegalArgumentException("Unknown quality profile.")
        val sourceArguments = rawVideos?.toList()
            ?: throw IllegalArgumentException("Choose at least one video.")
        require(sourceArguments.isNotEmpty()) { "Choose at least one video." }
        require(sourceArguments.size <= MAX_FILES) { "Choose no more than $MAX_FILES videos." }

        isProcessing = true
        cancelRequested = false
        terminalCommitted = false
        activeSessionId = null
        publishedClips = emptyList()
        synchronized(progressLock) { lastProgress = 0.0 }

        processingExecutor.execute {
            runJob(sourceArguments, profile)
        }
    }

    fun getProcessedClips(): List<Map<String, Any?>> = publishedClips.map { HashMap(it) }

    @Synchronized
    fun cancel() {
        if (!isProcessing || terminalCommitted) return
        cancelRequested = true
        activeSessionId?.let(FFmpegKit::cancel)
    }

    @Synchronized
    fun clearProcessedOutputs() {
        check(!isProcessing) { "Cannot clear files while processing." }
        publishedClips = emptyList()
        File(cacheDir, "processed").deleteRecursively()
    }

    fun shutdown() {
        cancel()
        processingExecutor.shutdownNow()
    }

    private fun runJob(rawVideos: List<*>, profile: EncodingProfile) {
        val outputDir = File(cacheDir, "processed")
        try {
            ensureWakeLock()
            outputDir.deleteRecursively()
            require(outputDir.mkdirs() || outputDir.isDirectory) {
                "Could not prepare private processing storage."
            }

            val sources = parseSources(rawVideos)
            val plans = createPlans(sources, profile)
            emit(
                type = "started",
                message = "Compressing ${sources.size} ${if (sources.size == 1) "video" else "videos"} into ${plans.size} ${if (plans.size == 1) "clip" else "clips"}.",
                progress = 0.0,
                currentClip = 0,
                totalClips = plans.size,
            )

            val totalDuration = plans.sumOf { it.durationSeconds }.coerceAtLeast(0.001)
            var completedDuration = 0.0
            val completed = mutableListOf<Map<String, Any?>>()

            plans.forEachIndexed { index, plan ->
                throwIfCancelled()
                val order = index + 1
                val output = File(
                    outputDir,
                    String.format(
                        Locale.US,
                        "%03d_%02d_%s_part_%03d.mp4",
                        order,
                        plan.sourceIndex + 1,
                        safeBaseName(plan.source.name),
                        plan.partIndex + 1,
                    ),
                )

                val acceptedAttempt = encodeWithRetries(
                    plan = plan,
                    output = output,
                    profile = profile,
                    completedDuration = completedDuration,
                    totalDuration = totalDuration,
                    currentClip = order,
                    totalClips = plans.size,
                )
                throwIfCancelled()

                val metadata = readMetadata(output)
                val clip = mapOf<String, Any?>(
                    "order" to order,
                    "path" to output.absolutePath,
                    "name" to output.name,
                    "sizeBytes" to output.length(),
                    "durationSeconds" to metadata.durationSeconds,
                    "sha256" to sha256(output),
                )
                completed.add(clip)
                completedDuration += plan.durationSeconds
                reportProgress(
                    progress = completedDuration / totalDuration,
                    message = "Clip $order of ${plans.size} is ready.",
                    currentClip = order,
                    totalClips = plans.size,
                    type = "clipReady",
                    payload = mapOf("clip" to clip, "attempt" to acceptedAttempt),
                )
            }

            throwIfCancelled()
            if (!publishSuccessfulResult(completed)) {
                throw ProcessingCancelledException()
            }
            emit(
                type = "completed",
                message = "Local compression complete.",
                progress = 1.0,
                currentClip = plans.size,
                totalClips = plans.size,
            )
        } catch (_: ProcessingCancelledException) {
            publishedClips = emptyList()
            outputDir.deleteRecursively()
            emit(
                type = "cancelled",
                message = "Processing cancelled. Selected videos were kept.",
                progress = currentProgress(),
            )
        } catch (error: InterruptedException) {
            Thread.currentThread().interrupt()
            publishedClips = emptyList()
            outputDir.deleteRecursively()
            emit(
                type = "cancelled",
                message = "Processing cancelled. Selected videos were kept.",
                progress = currentProgress(),
            )
        } catch (error: LinkageError) {
            publishedClips = emptyList()
            outputDir.deleteRecursively()
            emit(
                type = "error",
                message = "The local video engine could not start on this device.",
                progress = currentProgress(),
            )
        } catch (error: Exception) {
            publishedClips = emptyList()
            outputDir.deleteRecursively()
            if (cancelRequested) {
                emit(
                    type = "cancelled",
                    message = "Processing cancelled. Selected videos were kept.",
                    progress = currentProgress(),
                )
            } else {
                emit(
                    type = "error",
                    message = error.message?.takeIf { it.isNotBlank() }
                        ?: "Video processing failed. Try the 720p option.",
                    progress = currentProgress(),
                )
            }
        } finally {
            activeSessionId = null
            cancelRequested = false
            isProcessing = false
            if (wakeLock.isHeld) wakeLock.release()
        }
    }

    private fun parseSources(rawVideos: List<*>): List<SourceVideo> {
        val selectedRoot = File(cacheDir, "selected").canonicalFile
        var totalBytes = 0L
        return rawVideos.mapIndexed { index, raw ->
            throwIfCancelled()
            val map = raw as? Map<*, *>
                ?: throw IllegalArgumentException("Video ${index + 1} has invalid details.")
            val path = map["path"] as? String
                ?: throw IllegalArgumentException("Video ${index + 1} has no local path.")
            val file = File(path).canonicalFile
            require(file.path.startsWith(selectedRoot.path + File.separator)) {
                "Video ${index + 1} is outside private app storage."
            }
            require(file.isFile && file.length() > 0L) {
                "Video ${index + 1} is no longer available. Choose it again."
            }
            totalBytes += file.length()
            require(totalBytes <= MAX_TOTAL_BYTES) {
                "Selected videos exceed the 300 MB limit."
            }
            val metadata = readMetadata(file)
            require(
                metadata.durationSeconds > 0.0 && metadata.width > 0 && metadata.height > 0,
            ) {
                "Could not read playable video content from video ${index + 1}."
            }
            SourceVideo(
                file = file,
                name = (map["name"] as? String)?.takeIf { it.isNotBlank() }
                    ?: "video_${index + 1}.mp4",
                durationSeconds = metadata.durationSeconds,
            )
        }
    }

    private fun createPlans(
        sources: List<SourceVideo>,
        profile: EncodingProfile,
    ): List<ClipPlan> {
        val plans = mutableListOf<ClipPlan>()
        sources.forEachIndexed { sourceIndex, source ->
            val count = ceil(source.durationSeconds / profile.clipSeconds).toInt().coerceAtLeast(1)
            repeat(count) { partIndex ->
                val start = partIndex * profile.clipSeconds.toDouble()
                val remaining = source.durationSeconds - start
                if (remaining > 0.01) {
                    plans.add(
                        ClipPlan(
                            source = source,
                            sourceIndex = sourceIndex,
                            partIndex = partIndex,
                            startSeconds = start,
                            durationSeconds = min(profile.clipSeconds.toDouble(), remaining),
                        ),
                    )
                }
            }
        }
        require(plans.isNotEmpty()) { "No playable video content was found." }
        require(plans.size <= MAX_OUTPUT_CLIPS) {
            "These videos would create more than $MAX_OUTPUT_CLIPS clips. Choose shorter videos."
        }
        return plans
    }

    private fun encodeWithRetries(
        plan: ClipPlan,
        output: File,
        profile: EncodingProfile,
        completedDuration: Double,
        totalDuration: Double,
        currentClip: Int,
        totalClips: Int,
    ): Int {
        var lastFailure = "FFmpeg could not create this clip."
        for (attemptIndex in 0 until MAX_ATTEMPTS) {
            throwIfCancelled()
            ensureWakeLock()
            output.delete()
            val attempt = RetryAttempt.forIndex(attemptIndex, profile)
            emit(
                type = "progress",
                message = if (attemptIndex == 0) {
                    "Compressing clip $currentClip of $totalClips."
                } else {
                    "Optimizing clip $currentClip to fit WhatsApp (attempt ${attemptIndex + 1} of $MAX_ATTEMPTS)."
                },
                progress = currentProgress(),
                currentClip = currentClip,
                totalClips = totalClips,
            )

            val outcome = runFfmpegAttempt(
                command = buildCommand(plan, output, profile, attempt),
                attemptIndex = attemptIndex,
                completedDuration = completedDuration,
                clipDuration = plan.durationSeconds,
                totalDuration = totalDuration,
                currentClip = currentClip,
                totalClips = totalClips,
            )
            throwIfCancelled()

            if (outcome.success && output.isFile) {
                lastFailure = when {
                    output.length() <= 0L -> "Clip $currentClip was empty after encoding."
                    output.length() > MAX_CLIP_BYTES ->
                        "Clip $currentClip remained larger than 15.8 MB after $MAX_ATTEMPTS attempts."
                    isConformingOutput(output, plan.durationSeconds) -> return attemptIndex + 1
                    else -> "Clip $currentClip was incomplete after encoding."
                }
            } else if (outcome.message.isNotBlank()) {
                lastFailure = outcome.message
            }
        }
        output.delete()
        throw IllegalStateException(lastFailure)
    }

    private fun runFfmpegAttempt(
        command: String,
        attemptIndex: Int,
        completedDuration: Double,
        clipDuration: Double,
        totalDuration: Double,
        currentClip: Int,
        totalClips: Int,
    ): AttemptOutcome {
        val completedSession = AtomicReference<FFmpegSession?>()
        val latestEncodedSeconds = AtomicReference(0.0)
        val completionLatch = CountDownLatch(1)
        val session = FFmpegKit.executeAsync(
            command,
            FFmpegSessionCompleteCallback { finished ->
                completedSession.set(finished)
                completionLatch.countDown()
            },
            LogCallback { },
            StatisticsCallback { statistics ->
                latestEncodedSeconds.set(
                    (statistics.time.toDouble() / 1000.0).coerceIn(0.0, clipDuration),
                )
            },
        )
        activeSessionId = session.sessionId

        val previewBase = when (attemptIndex) {
            0 -> 0.0
            1 -> 0.75
            else -> 0.85
        }
        val previewSpan = when (attemptIndex) {
            0 -> 0.75
            else -> 0.10
        }
        while (!completionLatch.await(250, TimeUnit.MILLISECONDS)) {
            if (cancelRequested) {
                FFmpegKit.cancel(session.sessionId)
            } else {
                val encodedFraction = latestEncodedSeconds.get() / clipDuration
                val previewFraction = previewBase + encodedFraction * previewSpan
                reportProgress(
                    progress = (completedDuration + clipDuration * previewFraction) / totalDuration,
                    message = "Compressing clip $currentClip of $totalClips.",
                    currentClip = currentClip,
                    totalClips = totalClips,
                )
            }
        }
        if (activeSessionId == session.sessionId) activeSessionId = null

        val finished = completedSession.get() ?: session
        val returnCode = finished.returnCode
        if (cancelRequested || ReturnCode.isCancel(returnCode)) {
            throw ProcessingCancelledException()
        }
        return if (ReturnCode.isSuccess(returnCode)) {
            AttemptOutcome(success = true, message = "")
        } else {
            AttemptOutcome(
                success = false,
                message = "FFmpeg failed while creating clip $currentClip (code ${returnCode?.value ?: "unknown"}).",
            )
        }
    }

    private fun buildCommand(
        plan: ClipPlan,
        output: File,
        profile: EncodingProfile,
        attempt: RetryAttempt,
    ): String {
        val filter = "scale=w=${profile.width}:h=${profile.height}:force_original_aspect_ratio=decrease," +
            "pad=${profile.width}:${profile.height}:(ow-iw)/2:(oh-ih)/2," +
            "scale=trunc(iw/2)*2:trunc(ih/2)*2"
        return listOf(
            "-y",
            "-hide_banner",
            "-loglevel", "warning",
            "-ss", decimal(plan.startSeconds),
            "-t", decimal(plan.durationSeconds),
            "-i", quote(plan.source.file.absolutePath),
            "-map", "0:v:0",
            "-map", quote("0:a:0?"),
            "-sn",
            "-dn",
            "-vf", quote(filter),
            "-c:v", "libx264",
            // The website does not pass -preset, so libx264 uses medium.
            // Keep it explicit on Android so both paths use the same profile.
            "-preset", "medium",
            "-pix_fmt", "yuv420p",
            "-color_range", "tv",
            "-color_primaries", "bt470bg",
            "-color_trc", "bt709",
            "-colorspace", "bt470bg",
            "-crf", attempt.crf.toString(),
            "-maxrate", "${attempt.maxRateKbps}k",
            "-bufsize", "${attempt.bufferKbps}k",
            "-g", "250",
            "-profile:v", "high",
            "-level:v", "4.0",
            "-x264-params", "sei=0",
            "-r", "29.97",
            "-c:a", "aac",
            "-ar", "44100",
            "-ac", "2",
            "-b:a", "128k",
            "-brand", "isom",
            "-movflags", "+faststart",
            "-f", "mp4",
            "-threads", "2",
            quote(output.absolutePath),
        ).joinToString(" ")
    }

    private fun isConformingOutput(output: File, expectedDurationSeconds: Double): Boolean {
        val metadata = try {
            readMetadata(output)
        } catch (_: IllegalArgumentException) {
            return false
        }
        val durationTolerance = min(1.0, (expectedDurationSeconds * 0.05).coerceAtLeast(0.15))
        return metadata.width > 0 &&
            metadata.height > 0 &&
            metadata.durationSeconds > 0.0 &&
            metadata.durationSeconds >= expectedDurationSeconds - durationTolerance &&
            metadata.durationSeconds <= expectedDurationSeconds + 1.0
    }

    private fun readMetadata(file: File): MediaMetadata {
        val retriever = MediaMetadataRetriever()
        return try {
            retriever.setDataSource(file.absolutePath)
            val durationMs = retriever
                .extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
                ?.toLongOrNull()
                ?: 0L
            val width = retriever
                .extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)
                ?.toIntOrNull()
                ?: 0
            val height = retriever
                .extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)
                ?.toIntOrNull()
                ?: 0
            MediaMetadata(
                durationSeconds = durationMs / 1000.0,
                width = width,
                height = height,
            )
        } catch (error: Exception) {
            throw IllegalArgumentException("${file.name} is not a readable video.", error)
        } finally {
            retriever.release()
        }
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().buffered().use { input ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        return digest.digest().joinToString("") { byte -> "%02x".format(byte) }
    }

    private fun reportProgress(
        progress: Double,
        message: String,
        currentClip: Int,
        totalClips: Int,
        type: String = "progress",
        payload: Map<String, Any?> = emptyMap(),
    ) {
        val monotonicProgress = synchronized(progressLock) {
            val bounded = progress.coerceIn(0.0, 1.0)
            if (bounded > lastProgress) lastProgress = bounded
            lastProgress
        }
        emit(type, message, monotonicProgress, currentClip, totalClips, payload)
    }

    private fun currentProgress(): Double = synchronized(progressLock) { lastProgress }

    private fun emit(
        type: String,
        message: String,
        progress: Double,
        currentClip: Int = 0,
        totalClips: Int = 0,
        payload: Map<String, Any?> = emptyMap(),
    ) {
        emitOnPlatformThread(
            mapOf(
                "type" to type,
                "message" to message,
                "progress" to progress.coerceIn(0.0, 1.0),
                "currentClip" to currentClip,
                "totalClips" to totalClips,
                "payload" to payload,
            ),
        )
    }

    @Synchronized
    private fun publishSuccessfulResult(clips: List<Map<String, Any?>>): Boolean {
        if (cancelRequested) return false
        publishedClips = clips.toList()
        terminalCommitted = true
        return true
    }

    private fun ensureWakeLock() {
        if (wakeLock.isHeld) wakeLock.release()
        wakeLock.acquire(WAKE_LOCK_WINDOW_MS)
    }

    private fun throwIfCancelled() {
        if (cancelRequested || Thread.currentThread().isInterrupted) {
            throw ProcessingCancelledException()
        }
    }

    private fun safeBaseName(name: String): String = name
        .substringBeforeLast('.')
        .replace(Regex("[^A-Za-z0-9_-]"), "_")
        .trim('_')
        .take(50)
        .ifBlank { "video" }

    private fun quote(value: String): String = "'${value.replace("'", "'\\''")}'"

    private fun decimal(value: Double): String = String.format(Locale.US, "%.3f", value)

    private data class SourceVideo(
        val file: File,
        val name: String,
        val durationSeconds: Double,
    )

    private data class ClipPlan(
        val source: SourceVideo,
        val sourceIndex: Int,
        val partIndex: Int,
        val startSeconds: Double,
        val durationSeconds: Double,
    )

    private data class MediaMetadata(
        val durationSeconds: Double,
        val width: Int,
        val height: Int,
    )

    private data class AttemptOutcome(val success: Boolean, val message: String)

    private data class EncodingProfile(
        val id: String,
        val width: Int,
        val height: Int,
        val clipSeconds: Int,
        val crf: Int,
        val maxRateKbps: Int,
        val bufferKbps: Int,
    ) {
        companion object {
            private val profiles = listOf(
                EncodingProfile("hd29", 1080, 1920, 29, 23, 3800, 5700),
                EncodingProfile("long59", 720, 1280, 59, 24, 2200, 3300),
            )

            fun fromId(id: String?): EncodingProfile? = profiles.firstOrNull { it.id == id }
        }
    }

    private data class RetryAttempt(
        val crf: Int,
        val maxRateKbps: Int,
        val bufferKbps: Int,
    ) {
        companion object {
            fun forIndex(index: Int, profile: EncodingProfile): RetryAttempt {
                val rateFactor = when (index) {
                    0 -> 1.0
                    1 -> 0.90
                    else -> 0.72
                }
                val crfIncrease = when (index) {
                    0 -> 0
                    1 -> 1
                    else -> 3
                }
                return RetryAttempt(
                    crf = profile.crf + crfIncrease,
                    maxRateKbps = (profile.maxRateKbps * rateFactor).toInt(),
                    bufferKbps = (profile.bufferKbps * rateFactor).toInt(),
                )
            }
        }
    }

    private class ProcessingCancelledException : RuntimeException()
}
