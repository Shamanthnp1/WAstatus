import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../edition.dart';
import '../models/self_host.dart';
import '../services/self_host_bridge.dart';
import '../widgets/tutorial_guide.dart';

/// Chooses how clips reach WhatsApp, and links / unlinks the self-host number.
class SelfHostScreen extends StatefulWidget {
  const SelfHostScreen({
    super.key,
    required this.bridge,
    required this.initialSettings,
    this.onOpenLink,
  });

  final SelfHostBridge bridge;
  final SelfHostSettings initialSettings;

  /// Opens an allowed external link (the MAX page in the Play build).
  final Future<void> Function(Uri uri)? onOpenLink;

  @override
  State<SelfHostScreen> createState() => _SelfHostScreenState();
}

class _SelfHostScreenState extends State<SelfHostScreen> {
  final _numberController = TextEditingController();
  late SelfHostSettings _settings;
  StreamSubscription<SelfHostEvent>? _events;
  Timer? _ticker;

  SelfHostStatus? _status;
  bool _starting = false;
  bool _working = false;
  String? _pairingCode;
  DateTime? _pairingExpiresAt;
  String? _qrData;
  String? _notice;
  bool _noticeIsError = false;

  SelfHostBridge get _bridge => widget.bridge;
  bool get _linked => _status?.linked ?? false;
  String? get _linkedNumber => _status?.me ?? _settings.linkedNumber;

  @override
  void initState() {
    super.initState();
    _settings = widget.initialSettings;
    _events = _bridge.events.listen(_onEvent);
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted &&
          (_pairingExpiresAt != null || _status?.pairingRetryAt != null)) {
        setState(() {});
      }
    });
    if (_settings.mode.isSelfHost) unawaited(_refresh());
  }

  @override
  void dispose() {
    _events?.cancel();
    _ticker?.cancel();
    _numberController.dispose();
    // The bot stops by itself once nothing needs it.
    unawaited(_bridge.disconnect());
    super.dispose();
  }

  // ---------------------------------------------------------------------
  // Bot state
  // ---------------------------------------------------------------------
  Future<void> _refresh() async {
    setState(() => _starting = true);
    try {
      await _bridge.requestNotificationPermission();
      final status = await _bridge.status();
      if (!mounted) return;
      _applyStatus(status);
    } catch (error) {
      _showNotice(_text(error), error: true);
    } finally {
      if (mounted) setState(() => _starting = false);
    }
  }

  void _applyStatus(SelfHostStatus status) {
    setState(() {
      _status = status;
      if (status.linkingMethod == 'code' && status.pairingCode != null) {
        _pairingCode = status.pairingCode;
        _pairingExpiresAt = status.pairingExpiresAt;
      }
      if (status.linkingMethod == null) {
        _pairingCode = null;
        _pairingExpiresAt = null;
        _qrData = null;
      }
    });
    final number = status.linked ? status.me : null;
    if (number != _settings.linkedNumber) {
      _saveSettings(
        _settings.copyWith(
          linkedNumber: number,
          clearLinkedNumber: number == null,
        ),
      );
    }
  }

  void _onEvent(SelfHostEvent event) {
    if (!mounted) return;
    switch (event.name) {
      case 'state':
        final status = event.status;
        if (status != null) _applyStatus(status);
      case 'pairingCode':
        setState(() {
          _pairingCode = event.string('code');
          _pairingExpiresAt = event.date('expiresAt');
          _qrData = null;
        });
      case 'qr':
        setState(() => _qrData = event.string('data'));
      case 'linked':
        setState(() {
          _pairingCode = null;
          _pairingExpiresAt = null;
          _qrData = null;
        });
        _showNotice('Linked. This phone can now send clips from that number.');
      case 'linkEnded':
        setState(() {
          _pairingCode = null;
          _pairingExpiresAt = null;
          _qrData = null;
        });
        final message = switch (event.string('reason')) {
          'expired' =>
            'The code expired before it was entered. Ask for a new one.',
          'rateLimited' =>
            'WhatsApp is limiting new codes for this number. Try again in an hour, or link with a QR code from another phone.',
          'refused' =>
            'WhatsApp refused the code request. Try again later, or link with a QR code.',
          'cancelled' || 'restarted' => null,
          _ => 'Linking stopped. Try again.',
        };
        if (message != null) _showNotice(message, error: true);
      case 'loggedOut':
        _showNotice(
          event.string('reason') == 'user'
              ? 'Disconnected. StatusDrop no longer has access to that number.'
              : 'WhatsApp logged this phone out of that number. Link it again to keep using self-host delivery.',
          error: event.string('reason') != 'user',
        );
      case 'disconnected':
        // The bot stops itself when idle. Keep showing the linked number
        // (the next action starts it again); a code or QR it was showing
        // is gone with it.
        setState(() {
          _pairingCode = null;
          _pairingExpiresAt = null;
          _qrData = null;
        });
    }
  }

  // ---------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------
  Future<void> _selectMode(DeliveryMode mode) async {
    if (mode == _settings.mode || _working) return;
    await _saveSettings(_settings.copyWith(mode: mode));
    setState(() => _notice = null);
    if (mode.isSelfHost && _status == null) await _refresh();
  }

  Future<void> _saveSettings(SelfHostSettings settings) async {
    setState(() => _settings = settings);
    try {
      await _bridge.saveSettings(settings);
    } catch (_) {
      // Keep the in-memory choice; it is retried on the next change.
    }
  }

  Future<void> _requestCode() async {
    final digits = _numberController.text.replaceAll(RegExp(r'\D'), '');
    if (digits.length < 10 || digits.length > 15) {
      _showNotice(
        'Enter the full number with country code, for example +91 98765 43210.',
        error: true,
      );
      return;
    }
    await _run(() async {
      await _bridge.linkWithCode(digits);
      _showNotice('Asking WhatsApp for a code...');
    });
  }

  Future<void> _linkWithQr() => _run(() async {
    await _bridge.linkWithQr();
    _showNotice('Waiting for the QR code...');
  });

  Future<void> _cancelLink() => _run(_bridge.cancelLink);

  Future<void> _sendTest() => _run(() async {
    await _bridge.sendTest();
    _showNotice(
      'Test message sent to ${_formatNumber(_linkedNumber)}\'s own chat ("Message yourself").',
    );
  });

  Future<void> _disconnect() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Disconnect this number?'),
        content: Text(
          'StatusDrop will log out of ${_formatNumber(_linkedNumber)} and remove itself from that phone\'s Linked devices.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Keep'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Disconnect'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    await _run(() async {
      final removed = await _bridge.logout();
      await _saveSettings(_settings.copyWith(clearLinkedNumber: true));
      _showNotice(
        removed
            ? 'Disconnected and removed from Linked devices.'
            : 'Disconnected here. WhatsApp could not be reached, so also remove "Chrome (Windows)" from Linked devices on that phone.',
      );
    });
  }

  Future<void> _copyCode() async {
    final code = _pairingCode;
    if (code == null) return;
    await Clipboard.setData(ClipboardData(text: code.replaceAll('-', '')));
    _showNotice('Code copied. Paste it in WhatsApp.');
  }

  Future<void> _run(Future<void> Function() action) async {
    if (_working) return;
    setState(() => _working = true);
    try {
      await action();
      final status = await _bridge.status();
      if (mounted) _applyStatus(status);
    } catch (error) {
      _showNotice(_text(error), error: true);
    } finally {
      if (mounted) setState(() => _working = false);
    }
  }

  void _showNotice(String text, {bool error = false}) {
    if (!mounted) return;
    setState(() {
      _notice = text;
      _noticeIsError = error;
    });
  }

  static String _text(Object error) {
    if (error is SelfHostException) {
      if (error.code == 'RATE_LIMITED') {
        return 'To avoid a WhatsApp block, StatusDrop asks for at most 2 codes every 10 minutes. Try again in a few minutes, or use a QR code.';
      }
      return error.message;
    }
    if (error is PlatformException) return error.message ?? error.code;
    return error.toString();
  }

  static String _formatNumber(String? digits) =>
      digits == null || digits.isEmpty ? 'that number' : '+$digits';

  // ---------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------
  @override
  Widget build(BuildContext context) {
    final mode = _settings.mode;
    return Scaffold(
      appBar: AppBar(title: const Text('Delivery method')),
      body: SafeArea(
        top: false,
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 720),
            child: ListView(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 40),
              children: [
                Text(
                  'Choose who sends your finished clips to WhatsApp.',
                  style: Theme.of(context).textTheme.bodyLarge,
                ),
                const SizedBox(height: 16),
                for (final option in DeliveryMode.values) ...[
                  _ModeCard(
                    mode: option,
                    selected: option == mode,
                    enabled: !_working,
                    // The Play build shows self-host methods but can't use them.
                    locked: option.isSelfHost && !Edition.current.hasSelfHost,
                    onTap: () => _selectMode(option),
                  ),
                  const SizedBox(height: 10),
                ],
                if (!Edition.current.hasSelfHost) ...[
                  const SizedBox(height: 6),
                  _MaxEditionCard(
                    onLearnMore: widget.onOpenLink == null
                        ? null
                        : () => unawaited(widget.onOpenLink!(maxEditionPage)),
                  ),
                ],
                if (mode.isSelfHost) ...[
                  const SizedBox(height: 10),
                  _buildLinkCard(context, mode),
                  if (_notice != null) ...[
                    const SizedBox(height: 12),
                    _Notice(text: _notice!, error: _noticeIsError),
                  ],
                  const SizedBox(height: 16),
                  TutorialGuide(
                    key: ValueKey(mode),
                    steps: TutorialSteps.forMode(mode),
                    title: 'How it works',
                    hint: TutorialSteps.hintFor(mode),
                    icon: Icons.menu_book_outlined,
                    heroScope: 'delivery',
                  ),
                  const SizedBox(height: 16),
                  const _RiskCard(),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildLinkCard(BuildContext context, DeliveryMode mode) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final ownNumber = mode == DeliveryMode.ownNumber;
    final title = ownNumber ? 'Your WhatsApp number' : 'Your bot number';

    Widget body;
    if (_starting && _status == null) {
      body = const Row(
        children: [
          SizedBox.square(
            dimension: 22,
            child: CircularProgressIndicator(strokeWidth: 2.5),
          ),
          SizedBox(width: 14),
          Expanded(child: Text('Starting self-host delivery on this phone...')),
        ],
      );
    } else if (_linked) {
      body = Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Icon(Icons.check_circle, color: scheme.primary),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  'Linked: ${_formatNumber(_linkedNumber)}',
                  style: theme.textTheme.titleMedium,
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            'It shows as "Chrome (Windows)" in that phone\'s Linked devices.',
            style: theme.textTheme.bodySmall?.copyWith(
              color: scheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 16),
          OutlinedButton.icon(
            onPressed: _working ? null : _sendTest,
            icon: const Icon(Icons.chat_outlined),
            label: const Text('Send a test message'),
          ),
          const SizedBox(height: 8),
          TextButton.icon(
            onPressed: _working ? null : _disconnect,
            icon: const Icon(Icons.link_off),
            label: const Text('Disconnect this number'),
          ),
        ],
      );
    } else if (_pairingCode != null) {
      body = _PairingCodePanel(
        code: _pairingCode!,
        expiresAt: _pairingExpiresAt,
        onCopy: _copyCode,
        onCancel: _working ? null : _cancelLink,
      );
    } else if (_qrData != null) {
      body = Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            'On the phone with that WhatsApp: Settings > Linked devices > Link a device, then scan this code.',
            style: theme.textTheme.bodyMedium,
          ),
          const SizedBox(height: 14),
          Center(
            child: Semantics(
              label: 'QR code to link WhatsApp. It refreshes every 20 seconds.',
              child: Container(
                padding: const EdgeInsets.all(12),
                color: Colors.white,
                child: QrImageView(
                  data: _qrData!,
                  size: 250,
                  backgroundColor: Colors.white,
                ),
              ),
            ),
          ),
          const SizedBox(height: 10),
          Text(
            'The code refreshes by itself. This phone\'s own camera cannot scan it: use another phone, or link with a code instead.',
            style: theme.textTheme.bodySmall?.copyWith(
              color: scheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 10),
          TextButton(
            onPressed: _working ? null : _cancelLink,
            child: const Text('Cancel'),
          ),
        ],
      );
    } else {
      final retryAt = _status?.pairingRetryAt;
      final waiting =
          retryAt != null && retryAt.isAfter(DateTime.now().toUtc());
      body = Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          TextField(
            controller: _numberController,
            enabled: !_working,
            keyboardType: TextInputType.phone,
            autofillHints: const [AutofillHints.telephoneNumber],
            decoration: InputDecoration(
              labelText: ownNumber
                  ? 'Phone number with country code'
                  : 'Bot phone number with country code',
              hintText: '+91 98765 43210',
              helperText: 'For example +91 98765 43210.',
              border: const OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 14),
          FilledButton.icon(
            onPressed: _working || waiting ? null : _requestCode,
            icon: _working
                ? const SizedBox.square(
                    dimension: 20,
                    child: CircularProgressIndicator(strokeWidth: 2.5),
                  )
                : const Icon(Icons.pin_outlined),
            label: const Text('Get a linking code'),
          ),
          if (waiting) ...[
            const SizedBox(height: 8),
            Text(
              'You can ask for another code in ${_untilText(retryAt)}.',
              style: theme.textTheme.bodySmall,
            ),
          ],
          const SizedBox(height: 6),
          TextButton(
            onPressed: _working ? null : _linkWithQr,
            child: const Text(
              'Use a QR code instead (WhatsApp on another phone)',
            ),
          ),
        ],
      );
    }

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Semantics(
              header: true,
              child: Text(title, style: theme.textTheme.titleLarge),
            ),
            const SizedBox(height: 14),
            body,
          ],
        ),
      ),
    );
  }

  static String _untilText(DateTime until) {
    final remaining = until.difference(DateTime.now().toUtc());
    if (remaining.inMinutes >= 1) return '${remaining.inMinutes + 1} min';
    return '${remaining.inSeconds.clamp(1, 59)} s';
  }
}

class _ModeCard extends StatelessWidget {
  const _ModeCard({
    required this.mode,
    required this.selected,
    required this.enabled,
    required this.onTap,
    this.locked = false,
  });

  final DeliveryMode mode;
  final bool selected;
  final bool enabled;
  final VoidCallback onTap;

  /// Shown but not selectable: a MAX-only method in the Play build.
  final bool locked;

  static const lockedNote = '(only available in MAX version)';

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final description = switch (mode) {
      DeliveryMode.statusDrop =>
        'Default. Finished clips upload securely and a StatusDrop WhatsApp number sends them to you.',
      DeliveryMode.ownNumber =>
        'Link your own WhatsApp. This phone sends the clips to your "Message yourself" chat. Nothing uploads to StatusDrop.',
      DeliveryMode.secondNumber =>
        'Link a second WhatsApp number you own as your bot. Send it the code from your main WhatsApp and it replies with your clips.',
    };
    final icon = switch (mode) {
      DeliveryMode.statusDrop => Icons.cloud_outlined,
      DeliveryMode.ownNumber => Icons.person_outline,
      DeliveryMode.secondNumber => Icons.smart_toy_outlined,
    };
    final active = enabled && !locked;
    return Semantics(
      button: true,
      selected: selected,
      enabled: active,
      label: '${mode.label}${locked ? ', $lockedNote' : ''}. $description',
      child: ExcludeSemantics(
        child: Opacity(
          opacity: locked ? 0.5 : 1,
          child: Material(
            color: selected
                ? scheme.primaryContainer
                : scheme.surfaceContainerLow,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(17),
              side: BorderSide(
                color: selected ? scheme.primary : scheme.outlineVariant,
                width: selected ? 2 : 1,
              ),
            ),
            child: InkWell(
              onTap: active ? onTap : null,
              borderRadius: BorderRadius.circular(17),
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(
                      locked
                          ? Icons.lock_outline
                          : selected
                          ? Icons.radio_button_checked
                          : Icons.radio_button_off,
                      color: selected
                          ? scheme.primary
                          : scheme.onSurfaceVariant,
                    ),
                    const SizedBox(width: 13),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              Icon(icon, size: 20),
                              const SizedBox(width: 8),
                              Expanded(
                                child: Text(
                                  mode.label,
                                  style: theme.textTheme.titleMedium,
                                ),
                              ),
                            ],
                          ),
                          if (locked) ...[
                            const SizedBox(height: 2),
                            Text(
                              lockedNote,
                              style: theme.textTheme.labelMedium?.copyWith(
                                color: scheme.tertiary,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                          ],
                          const SizedBox(height: 4),
                          Text(
                            description,
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: selected
                                  ? scheme.onPrimaryContainer
                                  : scheme.onSurfaceVariant,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Play build: says the self-host methods are in StatusDrop MAX and links to
/// the website page that explains and offers it (never straight to an APK).
class _MaxEditionCard extends StatelessWidget {
  const _MaxEditionCard({required this.onLearnMore});

  final VoidCallback? onLearnMore;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Icon(Icons.workspace_premium_outlined, color: scheme.tertiary),
                const SizedBox(width: 10),
                Expanded(
                  child: Semantics(
                    header: true,
                    child: Text(
                      'StatusDrop MAX',
                      style: theme.textTheme.titleMedium,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              'The MAX version adds delivery from your own WhatsApp number: '
              'Message yourself, or a second number as your bot. It is free '
              'and available from our website.',
              style: theme.textTheme.bodyMedium?.copyWith(
                color: scheme.onSurfaceVariant,
                height: 1.35,
              ),
            ),
            const SizedBox(height: 14),
            OutlinedButton.icon(
              onPressed: onLearnMore,
              icon: const Icon(Icons.open_in_new),
              label: const Text('Learn more at wastatusvideo.com'),
            ),
          ],
        ),
      ),
    );
  }
}

class _PairingCodePanel extends StatelessWidget {
  const _PairingCodePanel({
    required this.code,
    required this.expiresAt,
    required this.onCopy,
    required this.onCancel,
  });

  final String code;
  final DateTime? expiresAt;
  final VoidCallback onCopy;
  final VoidCallback? onCancel;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final remaining = expiresAt?.difference(DateTime.now().toUtc());
    final seconds = remaining == null || remaining.isNegative
        ? 0
        : remaining.inSeconds;
    final timeText =
        '${seconds ~/ 60}:${(seconds % 60).toString().padLeft(2, '0')}';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: scheme.primaryContainer,
            borderRadius: BorderRadius.circular(18),
          ),
          child: Column(
            children: [
              Text('Linking code', style: theme.textTheme.labelMedium),
              const SizedBox(height: 6),
              Semantics(
                liveRegion: true,
                label: 'Linking code ${code.split('').join(' ')}',
                child: ExcludeSemantics(
                  child: SelectableText(
                    code,
                    textAlign: TextAlign.center,
                    style: theme.textTheme.headlineMedium?.copyWith(
                      fontWeight: FontWeight.w900,
                      letterSpacing: 3,
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 4),
              Text(
                seconds > 0
                    ? 'Valid for about $timeText'
                    : 'This code has probably expired',
                style: theme.textTheme.bodySmall,
              ),
              const SizedBox(height: 10),
              OutlinedButton.icon(
                onPressed: onCopy,
                icon: const Icon(Icons.copy_outlined),
                label: const Text('Copy code'),
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        Text(
          'In WhatsApp for that number:\n'
          '1. Tap the WhatsApp notification asking for a code, or open Settings > Linked devices > Link a device.\n'
          '2. Tap "Link with phone number instead".\n'
          '3. Paste or type the code.',
          style: theme.textTheme.bodyMedium,
        ),
        const SizedBox(height: 10),
        TextButton(onPressed: onCancel, child: const Text('Cancel')),
      ],
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice({required this.text, required this.error});

  final String text;
  final bool error;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Semantics(
      liveRegion: true,
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: error ? scheme.errorContainer : scheme.secondaryContainer,
          borderRadius: BorderRadius.circular(16),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(
              error ? Icons.error_outline : Icons.info_outline,
              color: error
                  ? scheme.onErrorContainer
                  : scheme.onSecondaryContainer,
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                text,
                style: TextStyle(
                  color: error
                      ? scheme.onErrorContainer
                      : scheme.onSecondaryContainer,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _RiskCard extends StatelessWidget {
  const _RiskCard();

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: scheme.tertiaryContainer,
        borderRadius: BorderRadius.circular(18),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.warning_amber_outlined, color: scheme.onTertiaryContainer),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              'Your number, your responsibility. Self-host delivery uses an unofficial WhatsApp connection, the same kind StatusDrop\'s own numbers use. WhatsApp may log out or restrict numbers that behave like bots, and brand-new numbers are the most at risk. While StatusDrop sends, a notification stays visible; keep it, or Android may stop the send. Your login stays only on this phone.',
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: scheme.onTertiaryContainer,
                height: 1.4,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
