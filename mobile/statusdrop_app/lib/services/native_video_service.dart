import 'dart:async';

import 'package:flutter/services.dart';

import '../models/native_video_event.dart';
import '../models/processed_clip.dart';
import '../models/quality_profile.dart';
import '../models/video_source.dart';

class NativeVideoService {
  NativeVideoService({MethodChannel? methods, EventChannel? events})
    : _methods = methods ?? const MethodChannel(_methodChannelName),
      _events = events ?? const EventChannel(_eventChannelName);

  static const _methodChannelName = 'com.wastatusvideo.statusdrop/video';
  static const _eventChannelName = 'com.wastatusvideo.statusdrop/video_events';

  final MethodChannel _methods;
  final EventChannel _events;

  Stream<NativeVideoEvent>? _eventStream;

  Stream<NativeVideoEvent> get events => _eventStream ??= _events
      .receiveBroadcastStream()
      .map(
        (event) =>
            NativeVideoEvent.fromMap(Map<Object?, Object?>.from(event as Map)),
      )
      .asBroadcastStream();

  Future<List<VideoSource>> pickVideos({int maxFiles = 3}) =>
      _pick('pickVideos', maxFiles);

  /// Photos become 5-second video clips (profile photo5).
  Future<List<VideoSource>> pickPhotos({int maxFiles = 10}) =>
      _pick('pickPhotos', maxFiles);

  Future<List<VideoSource>> _pick(String method, int maxFiles) async {
    final result = await _methods.invokeListMethod<Object?>(method, {
      'maxFiles': maxFiles,
    });
    return (result ?? const [])
        .map(
          (item) =>
              VideoSource.fromMap(Map<Object?, Object?>.from(item! as Map)),
        )
        .toList(growable: false);
  }

  Future<void> startProcessing({
    required List<VideoSource> videos,
    required QualityProfile profile,
  }) => _methods.invokeMethod<void>('startProcessing', {
    'videos': videos.map((video) => video.toMap()).toList(growable: false),
    'profile': profile.id,
  });

  Future<List<ProcessedClip>> getProcessedClips() async {
    final result = await _methods.invokeListMethod<Object?>(
      'getProcessedClips',
    );
    return (result ?? const [])
        .map(
          (item) =>
              ProcessedClip.fromMap(Map<Object?, Object?>.from(item! as Map)),
        )
        .toList(growable: false);
  }

  Future<void> cancelProcessing() =>
      _methods.invokeMethod<void>('cancelProcessing');

  Future<void> clearProcessedClips() =>
      _methods.invokeMethod<void>('clearProcessedClips');

  Future<void> deleteCachedFile(String path) =>
      _methods.invokeMethod<void>('deleteCachedFile', {'path': path});

  Future<void> openExternalUrl(Uri uri) =>
      _methods.invokeMethod<void>('openExternalUrl', {'url': uri.toString()});

  /// Small app state as JSON (for example, rating-prompt progress).
  Future<String?> getAppState() => _methods.invokeMethod<String>('getAppState');

  Future<void> setAppState(String json) =>
      _methods.invokeMethod<void>('setAppState', {'json': json});

  Future<void> clearCache() => _methods.invokeMethod<void>('clearCache');
}
