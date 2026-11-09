import 'dart:convert';

/// How finished clips reach the user's WhatsApp.
enum DeliveryMode {
  /// Default: clips upload to StatusDrop and our WhatsApp numbers send them.
  statusDrop('statusdrop'),

  /// Self-host method 1: the user's own WhatsApp sends to "Message yourself".
  ownNumber('own'),

  /// Self-host method 2: a second number the user owns acts as the bot.
  secondNumber('second');

  const DeliveryMode(this.id);

  final String id;

  bool get isSelfHost => this != DeliveryMode.statusDrop;

  String get label => switch (this) {
    DeliveryMode.statusDrop => 'StatusDrop number',
    DeliveryMode.ownNumber => 'My WhatsApp (Message yourself)',
    DeliveryMode.secondNumber => 'My second number as a bot',
  };

  static DeliveryMode fromId(Object? value) => DeliveryMode.values.firstWhere(
    (mode) => mode.id == value,
    orElse: () => DeliveryMode.statusDrop,
  );
}

/// Persisted self-host choice. The linked number mirrors what the bot last
/// reported, so the app can show it without starting the bot.
class SelfHostSettings {
  const SelfHostSettings({
    this.mode = DeliveryMode.statusDrop,
    this.linkedNumber,
  });

  final DeliveryMode mode;
  final String? linkedNumber;

  SelfHostSettings copyWith({
    DeliveryMode? mode,
    String? linkedNumber,
    bool clearLinkedNumber = false,
  }) => SelfHostSettings(
    mode: mode ?? this.mode,
    linkedNumber: clearLinkedNumber ? null : linkedNumber ?? this.linkedNumber,
  );

  String toJson() =>
      jsonEncode({'mode': mode.id, 'linkedNumber': linkedNumber});

  factory SelfHostSettings.fromJson(String? json) {
    if (json == null || json.isEmpty) return const SelfHostSettings();
    try {
      final map = jsonDecode(json);
      if (map is! Map) return const SelfHostSettings();
      final number = map['linkedNumber'];
      return SelfHostSettings(
        mode: DeliveryMode.fromId(map['mode']),
        linkedNumber: number is String && number.isNotEmpty ? number : null,
      );
    } on FormatException {
      return const SelfHostSettings();
    }
  }
}

/// A snapshot of the bot, as reported over the bridge.
class SelfHostStatus {
  const SelfHostStatus({
    required this.linked,
    required this.me,
    required this.connection,
    required this.linkingMethod,
    required this.pairingCode,
    required this.pairingExpiresAt,
    required this.armedCode,
    required this.armedTotal,
    required this.armedExpiresAt,
    required this.armedInProgress,
    required this.sending,
    required this.pairingRetryAt,
    required this.lastDeliveryCode,
    required this.lastDeliveryOutcome,
    required this.lastDeliveryTotal,
  });

  final bool linked;
  final String? me;
  final String connection;
  final String? linkingMethod;
  final String? pairingCode;
  final DateTime? pairingExpiresAt;
  final String? armedCode;
  final int armedTotal;
  final DateTime? armedExpiresAt;
  final bool armedInProgress;
  final bool sending;
  final DateTime? pairingRetryAt;

  /// How the last armed (method 2) delivery ended: 'delivered' or 'expired'.
  final String? lastDeliveryCode;
  final String? lastDeliveryOutcome;
  final int lastDeliveryTotal;

  bool get isArmed => armedCode != null;

  factory SelfHostStatus.fromMap(Map<Object?, Object?> map) {
    final linking = map['linking'];
    final armed = map['armed'];
    final last = map['lastDelivery'];
    final linkingMap = linking is Map ? linking : const {};
    final armedMap = armed is Map ? armed : const {};
    final lastMap = last is Map ? last : const {};
    return SelfHostStatus(
      linked: map['linked'] == true,
      me: map['me'] as String?,
      connection: (map['connection'] as String?) ?? 'closed',
      linkingMethod: linkingMap['method'] as String?,
      pairingCode: linkingMap['code'] as String?,
      pairingExpiresAt: _date(linkingMap['expiresAt']),
      armedCode: armedMap['code'] as String?,
      armedTotal: (armedMap['total'] as num?)?.toInt() ?? 0,
      armedExpiresAt: _date(armedMap['expiresAt']),
      armedInProgress: armedMap['inProgress'] == true,
      sending: map['sending'] == true,
      pairingRetryAt: _date(map['pairingRetryAt']),
      lastDeliveryCode: lastMap['code'] as String?,
      lastDeliveryOutcome: lastMap['outcome'] as String?,
      lastDeliveryTotal: (lastMap['total'] as num?)?.toInt() ?? 0,
    );
  }

  static DateTime? _date(Object? value) =>
      value is String ? DateTime.tryParse(value)?.toUtc() : null;
}

/// An event pushed by the bot.
class SelfHostEvent {
  const SelfHostEvent(this.name, this.data);

  final String name;
  final Map<String, Object?> data;

  SelfHostStatus? get status {
    final value = data['status'];
    return value is Map ? SelfHostStatus.fromMap(value) : null;
  }

  String? string(String key) => data[key] as String?;

  int? integer(String key) => (data[key] as num?)?.toInt();

  DateTime? date(String key) {
    final value = data[key];
    return value is String ? DateTime.tryParse(value)?.toUtc() : null;
  }
}

/// A clip handed to the bot, with the metadata WhatsApp expects.
class SelfHostClip {
  const SelfHostClip({
    required this.path,
    required this.width,
    required this.height,
    required this.seconds,
    this.thumbnail,
  });

  final String path;
  final int width;
  final int height;
  final int seconds;
  final String? thumbnail;

  Map<String, Object?> toMap() => {
    'path': path,
    'width': width,
    'height': height,
    'seconds': seconds,
    if (thumbnail != null) 'thumb': thumbnail,
  };
}

/// A bot reply that carries an error code (for example NOT_LINKED).
class SelfHostException implements Exception {
  const SelfHostException(this.message, {this.code});

  final String message;
  final String? code;

  bool get notLinked => code == 'NOT_LINKED';

  @override
  String toString() => message;
}
