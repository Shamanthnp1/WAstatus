/// Encoding profiles. Must match `EncodingProfile` in LocalVideoProcessor.kt
/// and `PROFILES` in the server's src/server/mobileUpload.js.
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
  hd90(
    id: 'hd90',
    label: '1080p, no splitting',
    description:
        'One clip up to 90 seconds (the Status limit) · same 1080p bitrate',
    width: 1080,
    height: 1920,
    clipSeconds: 89,
    crf: 23,
    maxRateKbps: 3800,
    bufferKbps: 5700,
    maxClipBytes: 60000000,
    note:
        'Needs fast internet. Each clip can be about 45 MB to send and download, so use Wi-Fi or fast mobile data.',
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
  ),

  /// Photos: each becomes a 5-second 1080p video. Chosen automatically when
  /// the user picks photos; never shown as a quality option.
  photo5(
    id: 'photo5',
    label: 'Photo clips',
    description: 'Each photo becomes a 5-second 1080p video',
    width: 1080,
    height: 1920,
    clipSeconds: 5,
    crf: 18,
    maxRateKbps: 3800,
    bufferKbps: 5700,
    isPhoto: true,
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
    this.maxClipBytes = 15800000,
    this.isPhoto = false,
    this.note,
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

  /// Largest finished clip this profile may upload.
  final int maxClipBytes;
  final bool isPhoto;

  /// A caution shown under the option, if any.
  final String? note;

  /// Profiles offered for videos, in display order.
  static List<QualityProfile> get videoProfiles =>
      values.where((profile) => !profile.isPhoto).toList(growable: false);

  static QualityProfile fromId(String value) => values.firstWhere(
    (profile) => profile.id == value,
    orElse: () => QualityProfile.hd29,
  );
}
