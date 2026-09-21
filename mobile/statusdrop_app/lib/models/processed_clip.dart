class ProcessedClip {
  const ProcessedClip({
    required this.order,
    required this.path,
    required this.name,
    required this.sizeBytes,
    required this.durationSeconds,
    required this.sha256,
  });

  final int order;
  final String path;
  final String name;
  final int sizeBytes;
  final double durationSeconds;
  final String sha256;

  factory ProcessedClip.fromMap(Map<Object?, Object?> map) => ProcessedClip(
    order: (map['order']! as num).toInt(),
    path: map['path']! as String,
    name: map['name']! as String,
    sizeBytes: (map['sizeBytes']! as num).toInt(),
    durationSeconds: (map['durationSeconds']! as num).toDouble(),
    sha256: map['sha256']! as String,
  );

  Map<String, Object?> toMap() => {
    'order': order,
    'path': path,
    'name': name,
    'sizeBytes': sizeBytes,
    'durationSeconds': durationSeconds,
    'sha256': sha256,
  };
}
