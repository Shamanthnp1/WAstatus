enum QualityProfile {
  hd29(
    id: 'hd29',
    label: '1080p HD',
    description: 'Best quality · 29-second parts',
    width: 1080,
    height: 1920,
    clipSeconds: 29,
    crf: 23,
    maxRateKbps: 3800,
    bufferKbps: 5700,
  ),
  long59(
    id: 'long59',
    label: '720p longer clips',
    description: 'Fewer parts · up to 59 seconds',
    width: 720,
    height: 1280,
    clipSeconds: 59,
    crf: 24,
    maxRateKbps: 2200,
    bufferKbps: 3300,
  );

  const QualityProfile({
    required this.id,
    required this.label,
    required this.description,
    required this.width,
    required this.height,
    required this.clipSeconds,
    required this.crf,
    required this.maxRateKbps,
    required this.bufferKbps,
  });

  final String id;
  final String label;
  final String description;
  final int width;
  final int height;
  final int clipSeconds;
  final int crf;
  final int maxRateKbps;
  final int bufferKbps;

  static QualityProfile fromId(String value) => values.firstWhere(
    (profile) => profile.id == value,
    orElse: () => QualityProfile.hd29,
  );
}
