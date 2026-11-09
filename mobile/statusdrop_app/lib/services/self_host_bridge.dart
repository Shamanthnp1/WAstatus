import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/services.dart';

import '../edition.dart';
import '../models/self_host.dart';

/// Talks to the self-host WhatsApp bot.
///
/// The bot runs in the app's ":selfhost" foreground service (Kotlin
/// SelfHostService, Node.js + Baileys). It listens on a random port on
/// 127.0.0.1 and writes the port and a random token to a private file, which
/// MainActivity reads for us. Messages are newline-delimited JSON.
class SelfHostBridge {
  SelfHostBridge({MethodChannel? methods})
    : _methods = methods ?? const MethodChannel(_channelName);

  static const _channelName = 'com.wastatusvideo.statusdrop/selfhost';

  final MethodChannel _methods;
  final _events = StreamController<SelfHostEvent>.broadcast();
  final _pending = <int, Completer<Object?>>{};
  Socket? _socket;
  StreamSubscription<String>? _lines;
  Future<void>? _connecting;
  int _nextId = 1;

  Stream<SelfHostEvent> get events => _events.stream;

  bool get isConnected => _socket != null;

  // ---------------------------------------------------------------------
  // Settings and platform helpers (no bot needed)
  // ---------------------------------------------------------------------
  Future<SelfHostSettings> loadSettings() async {
    // The Play (global) build has no self-host delivery and no native
    // channel for it: delivery is always the StatusDrop number.
    if (!Edition.current.hasSelfHost) return const SelfHostSettings();
    try {
      final json = await _methods.invokeMethod<String>('getSettings');
      return SelfHostSettings.fromJson(json);
    } on MissingPluginException {
      return const SelfHostSettings();
    } on PlatformException {
      return const SelfHostSettings();
    }
  }

  Future<void> saveSettings(SelfHostSettings settings) async {
    if (!Edition.current.hasSelfHost) return;
    await _methods.invokeMethod<void>('setSettings', {
      'json': settings.toJson(),
    });
  }

  Future<void> requestNotificationPermission() async {
    try {
      await _methods.invokeMethod<bool>('requestNotificationPermission');
    } on PlatformException {
      // The bot still runs without the permission; only the notification hides.
    }
  }

  Future<String?> clipThumbnail(String path) async {
    try {
      return await _methods.invokeMethod<String>('clipThumbnail', {
        'path': path,
      });
    } on PlatformException {
      return null;
    }
  }

  /// True when the bot process is up (its bridge file exists).
  Future<bool> isRunning() async {
    try {
      return await _methods.invokeMethod<Object?>('bridgeInfo') != null;
    } on MissingPluginException {
      return false;
    } on PlatformException {
      return false;
    }
  }

  // ---------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------

  /// Starts the bot if needed and connects to it.
  Future<void> connect({bool startIfStopped = true}) {
    if (_socket != null) return Future.value();
    return _connecting ??= _connect(startIfStopped).whenComplete(() {
      _connecting = null;
    });
  }

  Future<void> _connect(bool startIfStopped) async {
    var startRequested = false;
    Future<void> requestStart() async {
      if (startRequested) return;
      if (!startIfStopped) {
        throw const SelfHostException(
          'Self-host delivery is not running.',
          code: 'NOT_RUNNING',
        );
      }
      startRequested = true;
      await _methods.invokeMethod<void>('start');
    }

    final deadline = DateTime.now().add(const Duration(seconds: 45));
    while (DateTime.now().isBefore(deadline)) {
      final info = await _bridgeInfo();
      if (info == null) {
        await requestStart();
      } else {
        try {
          await _open(info.$1, info.$2);
          return;
        } on SocketException {
          // The bot is not listening: it was killed and left its address
          // file behind, or it is still starting. Start a fresh one once,
          // then keep trying until it answers.
          await requestStart();
        }
      }
      await Future<void>.delayed(const Duration(milliseconds: 400));
    }
    throw const SelfHostException(
      'StatusDrop could not start self-host delivery on this phone. Try again; if it keeps failing, restart the app.',
      code: 'START_FAILED',
    );
  }

  Future<(int, String)?> _bridgeInfo() async {
    final raw = await _methods.invokeMethod<Object?>('bridgeInfo');
    if (raw is! Map) return null;
    final port = raw['port'];
    final token = raw['token'];
    if (port is! int || token is! String) return null;
    return (port, token);
  }

  Future<void> _open(int port, String token) async {
    final socket = await Socket.connect(
      InternetAddress.loopbackIPv4,
      port,
      timeout: const Duration(seconds: 3),
    );
    _socket = socket;
    _lines = socket
        .cast<List<int>>()
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen(_onLine, onDone: _onClosed, onError: (_) => _onClosed());
    try {
      final status = await _send('hello', {'token': token});
      if (status is Map) {
        _events.add(SelfHostEvent('state', {'status': status}));
      }
    } catch (_) {
      await _close();
      rethrow;
    }
  }

  void _onLine(String line) {
    if (line.isEmpty) return;
    final Object? message;
    try {
      message = jsonDecode(line);
    } on FormatException {
      return;
    }
    if (message is! Map) return;
    final event = message['event'];
    if (event is String) {
      _events.add(SelfHostEvent(event, Map<String, Object?>.from(message)));
      return;
    }
    final completer = _pending.remove(message['id']);
    if (completer == null) return;
    if (message['ok'] == true) {
      completer.complete(message['result']);
    } else {
      completer.completeError(
        SelfHostException(
          (message['error'] as String?) ?? 'Self-host delivery failed.',
          code: message['code'] as String?,
        ),
      );
    }
  }

  void _onClosed() {
    _socket = null;
    _lines?.cancel();
    _lines = null;
    final pending = Map.of(_pending);
    _pending.clear();
    for (final completer in pending.values) {
      completer.completeError(
        const SelfHostException(
          'Self-host delivery stopped.',
          code: 'DISCONNECTED',
        ),
      );
    }
    _events.add(const SelfHostEvent('disconnected', {}));
  }

  Future<Object?> _send(
    String cmd, [
    Map<String, Object?> args = const {},
    Duration timeout = const Duration(seconds: 60),
  ]) {
    final socket = _socket;
    if (socket == null) {
      return Future.error(
        const SelfHostException(
          'Self-host delivery is not connected.',
          code: 'DISCONNECTED',
        ),
      );
    }
    final id = _nextId++;
    final completer = Completer<Object?>();
    _pending[id] = completer;
    socket.write('${jsonEncode({'id': id, 'cmd': cmd, ...args})}\n');
    return completer.future.timeout(
      timeout,
      onTimeout: () {
        _pending.remove(id);
        throw const SelfHostException(
          'Self-host delivery did not answer in time.',
          code: 'TIMEOUT',
        );
      },
    );
  }

  Future<Object?> _command(
    String cmd, [
    Map<String, Object?> args = const {},
    Duration timeout = const Duration(seconds: 60),
  ]) async {
    await connect();
    return _send(cmd, args, timeout);
  }

  /// Closes our connection; the bot stops by itself when it has nothing to do.
  Future<void> disconnect() => _close();

  Future<void> _close() async {
    final socket = _socket;
    _socket = null;
    await _lines?.cancel();
    _lines = null;
    socket?.destroy();
  }

  /// Stops the bot right away.
  Future<void> stop() async {
    try {
      if (_socket != null) await _send('shutdown');
    } catch (_) {
      // Fall back to the service stop below.
    }
    await _close();
    try {
      await _methods.invokeMethod<void>('stop');
    } on PlatformException {
      // Already stopped.
    }
  }

  void dispose() {
    _close();
    _events.close();
  }

  // ---------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------
  Future<SelfHostStatus> status({bool verify = false}) async {
    final result = await _command(
      verify ? 'verify' : 'status',
      const {},
      const Duration(seconds: 60),
    );
    return SelfHostStatus.fromMap(Map<Object?, Object?>.from(result! as Map));
  }

  Future<void> linkWithCode(String number) =>
      _command('linkCode', {'number': number}, const Duration(seconds: 40));

  Future<void> linkWithQr() =>
      _command('linkQr', const {}, const Duration(seconds: 40));

  Future<void> cancelLink() => _command('cancelLink');

  /// Returns true when WhatsApp confirmed the device was removed.
  Future<bool> logout() async {
    final result = await _command(
      'logout',
      const {},
      const Duration(seconds: 60),
    );
    return result is Map && result['removedFromPhone'] == true;
  }

  Future<void> sendTest() =>
      _command('sendTest', const {}, const Duration(seconds: 70));

  /// Method 1. Completes when every clip is sent and returns the number they
  /// went to; progress arrives as `sendProgress` events.
  Future<String?> sendToSelf(List<SelfHostClip> clips) async {
    final result = await _command('sendToSelf', {
      'clips': clips.map((clip) => clip.toMap()).toList(growable: false),
    }, Duration(minutes: 2 + clips.length * 4));
    return result is Map ? result['to'] as String? : null;
  }

  /// Method 2. Returns the bot number that should receive the code.
  Future<String?> armDelivery({
    required String code,
    required List<SelfHostClip> clips,
    required DateTime expiresAt,
  }) async {
    final result = await _command('armDelivery', {
      'code': code,
      'clips': clips.map((clip) => clip.toMap()).toList(growable: false),
      'expiresAt': expiresAt.toUtc().toIso8601String(),
    }, const Duration(seconds: 70));
    return result is Map ? result['botNumber'] as String? : null;
  }

  Future<void> cancelDelivery() async {
    if (!await isRunning()) return;
    try {
      await _command('cancelDelivery');
    } on SelfHostException {
      // The bot stopped meanwhile; nothing is armed.
    }
  }

  /// A 9-character code in the same style as the server's (A-Z, 0-9, at
  /// least one digit), so the bot's matcher and the user's habit agree.
  static String newActivationCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    final random = Random.secure();
    final buffer = List.generate(9, (_) => chars[random.nextInt(chars.length)]);
    if (!buffer.any((char) => RegExp('[0-9]').hasMatch(char))) {
      buffer[random.nextInt(buffer.length)] = random.nextInt(10).toString();
    }
    return buffer.join();
  }
}
