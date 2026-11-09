class VideoSource {
  const VideoSource({
    required this.id,
    required this.path,
    required this.name,
    required this.sizeBytes,
    this.durationSeconds,
    this.width,
    this.height,
    this.isPhoto = false,
  });

  final String id;
  final String path;
  final String name;
  final int sizeBytes;
  final double? durationSeconds;
  final int? width;
  final int? height;

  /// A photo that becomes a short video clip (picked with "Choose photos").
  final bool isPhoto;

  factory VideoSource.fromMap(Map<Object?, Object?> map) => VideoSource(
    id: map['id']! as String,
    path: map['path']! as String,
    name: map['name']! as String,
    sizeBytes: (map['sizeBytes']! as num).toInt(),
    durationSeconds: (map['durationSeconds'] as num?)?.toDouble(),
    width: (map['width'] as num?)?.toInt(),
    height: (map['height'] as num?)?.toInt(),
    isPhoto: map['kind'] == 'photo',
  );

  Map<String, Object?> toMap() => {
    'id': id,
    'path': path,
    'name': name,
    'sizeBytes': sizeBytes,
    'durationSeconds': durationSeconds,
    'width': width,
    'height': height,
    'kind': isPhoto ? 'photo' : 'video',
  };
}
