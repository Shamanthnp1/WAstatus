package com.wastatusvideo.statusdrop

import android.app.Activity
import io.flutter.plugin.common.BinaryMessenger

/**
 * Global (Google Play) edition: self-host delivery is not part of this build.
 * The MAX edition's version in src/max registers the real channel. The Dart
 * side never calls it in this edition.
 */
@Suppress("UNUSED_PARAMETER")
class SelfHostChannel(activity: Activity) {
    fun register(messenger: BinaryMessenger) = Unit

    fun dispose() = Unit
}
