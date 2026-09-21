enum NativeVideoEventType {
  started,
  progress,
  clipReady,
  completed,
  cancelled,
  error,
}

class NativeVideoEvent {
  const NativeVideoEvent({
    required this.type,
    required this.message,
    this.progress = 0,
    this.currentClip = 0,
    this.totalClips = 0,
    this.payload = const {},
  });

  final NativeVideoEventType type;
  final String message;
  final double progress;
  final int currentClip;
  final int totalClips;
  final Map<Object?, Object?> payload;

  factory NativeVideoEvent.fromMap(Map<Object?, Object?> map) {
    final rawType = map['type'] as String? ?? 'error';
    return NativeVideoEvent(
      type: NativeVideoEventType.values.firstWhere(
        (value) => value.name == rawType,
        orElse: () => NativeVideoEventType.error,
      ),
      message: map['message'] as String? ?? '',
      progress: (map['progress'] as num?)?.toDouble() ?? 0,
      currentClip: (map['currentClip'] as num?)?.toInt() ?? 0,
      totalClips: (map['totalClips'] as num?)?.toInt() ?? 0,
      payload: (map['payload'] as Map<Object?, Object?>?) ?? const {},
    );
  }
}
