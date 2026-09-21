import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../models/processed_clip.dart';
import '../models/quality_profile.dart';

class DeliveryResult {
  const DeliveryResult({
    required this.activationCode,
    required this.whatsAppUrl,
    required this.fileCount,
    required this.expiresAt,
  });

  final String activationCode;
  final Uri whatsAppUrl;
  final int fileCount;
  final DateTime expiresAt;
}

class MobileApiException implements Exception {
  const MobileApiException(this.message, {this.statusCode});

  final String message;
  final int? statusCode;

  bool get isRetryable =>
      statusCode == null ||
      statusCode == 408 ||
      statusCode == 409 ||
      statusCode == 429 ||
      statusCode! >= 500;

  @override
  String toString() => message;
}

class MobileApi {
  MobileApi({
    HttpClient? client,
    this.baseUri = const String.fromEnvironment(
      'STATUSDROP_API_URL',
      defaultValue: 'https://api.wastatusvideo.com',
    ),
  }) : _client = client ?? HttpClient() {
    _client.connectionTimeout = const Duration(seconds: 30);
  }

  static const _maxClips = 20;
  static const _maxClipBytes = 15800000;
  static const _maxTotalBytes = 300 * 1024 * 1024;
  static const _maxResponseBytes = 1024 * 1024;

  final HttpClient _client;
  final String baseUri;

  Future<DeliveryResult> uploadAndFinalize({
    required List<ProcessedClip> clips,
    required QualityProfile profile,
    required void Function(double value, String message) onProgress,
  }) async {
    final orderedClips = await _validateLocalClips(clips, profile);
    final totalBytes = orderedClips.fold<int>(
      0,
      (sum, clip) => sum + clip.sizeBytes,
    );
    var lastProgress = 0.0;

    void report(double value, String message) {
      final bounded = value.clamp(0.0, 1.0);
      if (bounded < lastProgress) return;
      lastProgress = bounded;
      onProgress(bounded, message);
    }

    report(0.01, 'Creating a secure upload session.');
    final createBody = await _retry<Map<String, Object?>>(
      () => _requestJson(
        'POST',
        _endpoint('/api/mobile/sessions'),
        body: {
          'profile': profile.id,
          'clips': orderedClips
              .map(
                (clip) => {
                  'order': clip.order,
                  'name': clip.name,
                  'sizeBytes': clip.sizeBytes,
                  'durationSeconds': clip.durationSeconds,
                  'sha256': clip.sha256,
                },
              )
              .toList(growable: false),
        },
        expectedStatuses: const {201},
      ),
      attempts: 2,
    );

    final sessionId = _requiredString(createBody, 'sessionId');
    final uploadToken = _requiredString(createBody, 'uploadToken');
    final uploadExpiresAt = DateTime.tryParse(
      _requiredString(createBody, 'uploadExpiresAt'),
    )?.toUtc();
    final uploadAbsoluteExpiresAt = DateTime.tryParse(
      _requiredString(createBody, 'uploadAbsoluteExpiresAt'),
    )?.toUtc();
    final now = DateTime.now().toUtc();
    if (uploadExpiresAt == null ||
        uploadAbsoluteExpiresAt == null ||
        !uploadExpiresAt.isAfter(now) ||
        !uploadAbsoluteExpiresAt.isAfter(uploadExpiresAt)) {
      throw const MobileApiException(
        'The server returned an invalid upload deadline.',
      );
    }
    final rawUploads = createBody['uploads'];
    if (rawUploads is! List || rawUploads.length != orderedClips.length) {
      throw const MobileApiException(
        'The server returned an invalid upload plan.',
      );
    }

    final uploadsByOrder = <int, Uri>{};
    for (final raw in rawUploads) {
      if (raw is! Map) {
        throw const MobileApiException(
          'The server returned an invalid upload slot.',
        );
      }
      final slot = Map<String, Object?>.from(raw);
      final order = (slot['order'] as num?)?.toInt();
      final urlText = slot['url'];
      if (order == null || urlText is! String) {
        throw const MobileApiException(
          'The server returned an incomplete upload slot.',
        );
      }
      final uri = Uri.tryParse(urlText);
      if (uri == null || !_isTrustedApiUri(uri)) {
        throw const MobileApiException(
          'The server returned an unsafe upload address.',
        );
      }
      uploadsByOrder[order] = uri;
    }

    var committedBytes = 0;
    for (final clip in orderedClips) {
      if (!uploadAbsoluteExpiresAt.isAfter(DateTime.now().toUtc())) {
        throw const MobileApiException(
          'The secure upload session expired. Tap upload to try again.',
        );
      }
      final uploadUri = uploadsByOrder[clip.order];
      if (uploadUri == null) {
        throw MobileApiException('Upload slot ${clip.order} is missing.');
      }
      await _retry<void>(
        () => _uploadClip(
          uri: uploadUri,
          token: uploadToken,
          clip: clip,
          onBytesSent: (sent) {
            final byteProgress = (committedBytes + sent) / totalBytes;
            report(
              0.05 + byteProgress * 0.85,
              'Uploading clip ${clip.order} of ${orderedClips.length}.',
            );
          },
        ),
        attempts: 3,
      );
      committedBytes += clip.sizeBytes;
      report(
        0.05 + (committedBytes / totalBytes) * 0.85,
        'Uploaded clip ${clip.order} of ${orderedClips.length}.',
      );
    }

    if (!uploadAbsoluteExpiresAt.isAfter(DateTime.now().toUtc())) {
      throw const MobileApiException(
        'The secure upload session expired. Tap upload to try again.',
      );
    }
    report(0.94, 'Verifying clips and creating your activation code.');
    final finalizeBody = await _retry<Map<String, Object?>>(
      () => _requestJson(
        'POST',
        _endpoint(
          '/api/mobile/sessions/${Uri.encodeComponent(sessionId)}/finalize',
        ),
        bearerToken: uploadToken,
        body: const <String, Object?>{},
      ),
      attempts: 3,
    );

    final activationCode = _requiredString(finalizeBody, 'activationCode');
    final whatsAppUrl = Uri.tryParse(
      _requiredString(finalizeBody, 'whatsAppUrl'),
    );
    final fileCount = (finalizeBody['fileCount'] as num?)?.toInt();
    final expiresAt = DateTime.tryParse(
      _requiredString(finalizeBody, 'expiresAt'),
    );
    if (!RegExp(r'^[A-Z0-9]{9}$').hasMatch(activationCode) ||
        whatsAppUrl == null ||
        whatsAppUrl.scheme != 'https' ||
        whatsAppUrl.host.toLowerCase() != 'wa.me' ||
        fileCount != orderedClips.length ||
        expiresAt == null) {
      throw const MobileApiException(
        'The server returned an invalid activation result.',
      );
    }

    report(1, 'Activation code ready.');
    return DeliveryResult(
      activationCode: activationCode,
      whatsAppUrl: whatsAppUrl,
      fileCount: fileCount!,
      expiresAt: expiresAt.toUtc(),
    );
  }

  Future<List<ProcessedClip>> _validateLocalClips(
    List<ProcessedClip> clips,
    QualityProfile profile,
  ) async {
    if (clips.isEmpty) {
      throw const MobileApiException('There are no processed clips to upload.');
    }
    if (clips.length > _maxClips) {
      throw const MobileApiException(
        'A delivery can contain at most 20 clips. Choose shorter videos.',
      );
    }
    final ordered = [...clips]..sort((a, b) => a.order.compareTo(b.order));
    var totalBytes = 0;
    for (var index = 0; index < ordered.length; index++) {
      final clip = ordered[index];
      if (clip.order != index + 1 ||
          clip.sizeBytes < 1 ||
          clip.sizeBytes > _maxClipBytes ||
          clip.durationSeconds <= 0 ||
          clip.durationSeconds > profile.clipSeconds + 0.75 ||
          !RegExp(r'^[0-9a-f]{64}$').hasMatch(clip.sha256)) {
        throw MobileApiException('Processed clip ${index + 1} is invalid.');
      }
      final file = File(clip.path);
      final stat = await file.stat();
      if (stat.type != FileSystemEntityType.file ||
          stat.size != clip.sizeBytes) {
        throw MobileApiException(
          'Processed clip ${clip.order} is no longer available. Compress again.',
        );
      }
      totalBytes += clip.sizeBytes;
      if (totalBytes > _maxTotalBytes) {
        throw const MobileApiException(
          'Processed clips exceed the 300 MB total limit.',
        );
      }
    }
    return List.unmodifiable(ordered);
  }

  Future<void> _uploadClip({
    required Uri uri,
    required String token,
    required ProcessedClip clip,
    required void Function(int bytes) onBytesSent,
  }) async {
    HttpClientRequest? request;
    try {
      request = await _client
          .openUrl('PUT', uri)
          .timeout(const Duration(seconds: 30));
      request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
      request.headers.contentType = ContentType('video', 'mp4');
      request.contentLength = clip.sizeBytes;

      var sent = 0;
      final countedStream = File(clip.path).openRead().map((chunk) {
        sent += chunk.length;
        onBytesSent(sent.clamp(0, clip.sizeBytes));
        return chunk;
      });
      // addStream awaits IOSink backpressure instead of queueing the entire clip
      // in memory on a slow mobile connection.
      await request
          .addStream(countedStream)
          .timeout(const Duration(minutes: 6));
      final response = await request.close().timeout(
        const Duration(minutes: 6),
      );
      final body = await _readJsonResponse(response);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw MobileApiException(
          _errorMessage(body, 'Clip upload failed.'),
          statusCode: response.statusCode,
        );
      }
    } on TimeoutException {
      request?.abort();
      throw const MobileApiException(
        'Clip upload timed out. Check your connection.',
      );
    } on SocketException {
      request?.abort();
      throw const MobileApiException(
        'Could not connect while uploading the clip.',
      );
    } on HttpException catch (error) {
      request?.abort();
      throw MobileApiException(error.message);
    }
  }

  Future<Map<String, Object?>> _requestJson(
    String method,
    Uri uri, {
    Map<String, Object?>? body,
    String? bearerToken,
    Set<int>? expectedStatuses,
  }) async {
    HttpClientRequest? request;
    try {
      request = await _client
          .openUrl(method, uri)
          .timeout(const Duration(seconds: 30));
      request.headers.contentType = ContentType.json;
      request.headers.set(HttpHeaders.acceptHeader, 'application/json');
      if (bearerToken != null) {
        request.headers.set(
          HttpHeaders.authorizationHeader,
          'Bearer $bearerToken',
        );
      }
      final encoded = utf8.encode(jsonEncode(body ?? const {}));
      request.contentLength = encoded.length;
      request.add(encoded);

      final response = await request.close().timeout(
        const Duration(seconds: 90),
      );
      final responseBody = await _readJsonResponse(response);
      final accepted =
          expectedStatuses?.contains(response.statusCode) ??
          (response.statusCode >= 200 && response.statusCode < 300);
      if (!accepted) {
        throw MobileApiException(
          _errorMessage(responseBody, 'The server rejected the request.'),
          statusCode: response.statusCode,
        );
      }
      return responseBody;
    } on TimeoutException {
      request?.abort();
      throw const MobileApiException('The server took too long to respond.');
    } on SocketException {
      request?.abort();
      throw const MobileApiException('Could not connect to StatusDrop.');
    } on HttpException catch (error) {
      request?.abort();
      throw MobileApiException(error.message);
    }
  }

  Future<Map<String, Object?>> _readJsonResponse(
    HttpClientResponse response,
  ) async {
    final bytes = <int>[];
    await for (final chunk in response) {
      if (bytes.length + chunk.length > _maxResponseBytes) {
        throw const MobileApiException('The server response was too large.');
      }
      bytes.addAll(chunk);
    }
    if (bytes.isEmpty) return const {};
    try {
      final decoded = jsonDecode(utf8.decode(bytes));
      if (decoded is! Map) {
        throw const FormatException('Expected a JSON object.');
      }
      return Map<String, Object?>.from(decoded);
    } on FormatException {
      throw MobileApiException(
        'The server returned an unreadable response (${response.statusCode}).',
        statusCode: response.statusCode,
      );
    }
  }

  Future<T> _retry<T>(
    Future<T> Function() operation, {
    required int attempts,
  }) async {
    Object? lastError;
    for (var attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await operation();
      } on MobileApiException catch (error) {
        lastError = error;
        if (!error.isRetryable || attempt == attempts) rethrow;
      }
      await Future<void>.delayed(Duration(seconds: attempt * 2));
    }
    throw lastError ?? const MobileApiException('The operation failed.');
  }

  Uri _endpoint(String path) {
    final base = Uri.tryParse(baseUri);
    if (base == null || !base.hasScheme || base.host.isEmpty) {
      throw const MobileApiException('The StatusDrop API address is invalid.');
    }
    return base.resolve(path);
  }

  bool _isTrustedApiUri(Uri uri) {
    final base = Uri.tryParse(baseUri);
    if (base == null) return false;
    return uri.scheme == base.scheme &&
        uri.host.toLowerCase() == base.host.toLowerCase() &&
        uri.port == base.port;
  }

  String _requiredString(Map<String, Object?> body, String key) {
    final value = body[key];
    if (value is! String || value.isEmpty) {
      throw MobileApiException('The server response is missing $key.');
    }
    return value;
  }

  String _errorMessage(Map<String, Object?> body, String fallback) {
    final value = body['error'];
    return value is String && value.isNotEmpty ? value : fallback;
  }

  void close() => _client.close(force: true);
}
