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

  Future<List<VideoSource>> pickVideos({int maxFiles = 3}) async {
    final result = await _methods.invokeListMethod<Object?>('pickVideos', {
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

  Future<void> clearCache() => _methods.invokeMethod<void>('clearCache');
}
