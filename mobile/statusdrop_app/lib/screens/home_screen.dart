import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../edition.dart';
import '../models/native_video_event.dart';
import '../models/processed_clip.dart';
import '../models/quality_profile.dart';
import '../models/self_host.dart';
import '../models/video_source.dart';
import '../services/mobile_api.dart';
import '../services/native_video_service.dart';
import '../services/self_host_bridge.dart';
import '../widgets/tutorial_guide.dart';
import 'self_host_screen.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({
    super.key,
    this.videoService,
    this.mobileApi,
    this.selfHostBridge,
  });

  final NativeVideoService? videoService;
  final MobileApi? mobileApi;
  final SelfHostBridge? selfHostBridge;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

/// What a finished self-host delivery reports on the home screen.
class _SelfHostOutcome {
  const _SelfHostOutcome({
    required this.clipCount,
    required this.number,
    required this.ownChat,
  });

  final int clipCount;
  final String? number;

  /// Method 1 (sent to "Message yourself") vs method 2 (bot replied).
  final bool ownChat;
}

class _HomeScreenState extends State<HomeScreen> with WidgetsBindingObserver {
  static const maxFiles = 3;
  static const maxPhotos = 10;
  static const maxBytes = 300 * 1024 * 1024;
  static const _selfHostCodeLifetime = Duration(minutes: 15);
  static const _ratingAfterDeliveries = 2;

  /// The Google Play listing (the global edition).
  static const _playPackage = 'com.wastatusvideo.statusdrop';

  late final NativeVideoService _videoService;
  late final MobileApi _mobileApi;
  late final bool _ownsMobileApi;
  late final SelfHostBridge _selfHost;
  late final bool _ownsSelfHost;
  StreamSubscription<NativeVideoEvent>? _eventSubscription;
  StreamSubscription<SelfHostEvent>? _selfHostSubscription;
  Timer? _countdownTimer;
  SelfHostSettings _deliverySettings = const SelfHostSettings();
  _SelfHostOutcome? _selfHostOutcome;

  /// True when [_delivery] is a code armed on the user's own bot (method 2),
  /// not a StatusDrop server code.
  bool _selfHostArmed = false;
  String? _botNumber;

  /// Rating prompt progress (Play build only), kept in native app state.
  int _deliveriesOpened = 0;
  bool _ratingPromptShown = false;
  bool _ratingPromptDue = false;
  String? _lastCountedCode;

  final List<VideoSource> _videos = [];
  List<ProcessedClip> _processedClips = const [];
  QualityProfile _profile = QualityProfile.hd29;

  /// The video profile to return to after a photo job is cleared.
  QualityProfile _videoProfile = QualityProfile.hd29;
  DeliveryResult? _delivery;
  Duration _activationRemaining = Duration.zero;
  bool _isPicking = false;
  bool _isProcessing = false;
  bool _isUploading = false;
  double _progress = 0;
  double _uploadProgress = 0;
  String _statusMessage = 'Choose videos to begin.';

  bool get _isBusy => _isPicking || _isProcessing || _isUploading;

  int get _totalBytes => _videos.fold(0, (sum, video) => sum + video.sizeBytes);

  int get _processedBytes =>
      _processedClips.fold(0, (sum, clip) => sum + clip.sizeBytes);

  bool get _selfHostMode => _deliverySettings.mode.isSelfHost;

  /// The current job is photos (each becomes a 5-second clip), not videos.
  bool get _photoJob => _videos.isNotEmpty && _videos.first.isPhoto;

  int get _maxCount => _photoJob ? maxPhotos : maxFiles;

  int get _currentStep {
    if (_delivery != null ||
        _selfHostOutcome != null ||
        _processedClips.isNotEmpty ||
        _isUploading) {
      return 2;
    }
    if (_videos.isNotEmpty || _isProcessing) return 1;
    return 0;
  }

  String get _stageKey {
    if (_selfHostOutcome != null) return 'selfhost-sent';
    if (_delivery != null) return 'activation';
    if (_isUploading) return 'uploading';
    if (_processedClips.isNotEmpty) return 'ready';
    if (_isProcessing) return 'processing';
    if (_videos.isNotEmpty) return 'selected';
    return 'empty';
  }

  @override
  void initState() {
    super.initState();
    _videoService = widget.videoService ?? NativeVideoService();
    _ownsMobileApi = widget.mobileApi == null;
    _mobileApi = widget.mobileApi ?? MobileApi();
    _ownsSelfHost = widget.selfHostBridge == null;
    _selfHost = widget.selfHostBridge ?? SelfHostBridge();
    _eventSubscription = _videoService.events.listen(
      _handleNativeEvent,
      onError: (Object error) {
        if (!mounted) return;
        setState(() {
          _isProcessing = false;
          _statusMessage = 'Processing failed: $error';
        });
      },
    );
    _selfHostSubscription = _selfHost.events.listen(_handleSelfHostEvent);
    WidgetsBinding.instance.addObserver(this);
    unawaited(_loadDeliverySettings());
    if (!Edition.current.hasSelfHost) unawaited(_loadAppState());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _countdownTimer?.cancel();
    _eventSubscription?.cancel();
    _selfHostSubscription?.cancel();
    if (_ownsMobileApi) _mobileApi.close();
    if (_ownsSelfHost) _selfHost.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // The bot keeps delivering while the app is in the background; catch up
    // on what happened when the user comes back.
    if (state == AppLifecycleState.resumed && _selfHostArmed) {
      unawaited(_checkArmedDelivery());
    }
    // Back from WhatsApp after a delivery: a natural moment to ask once.
    if (state == AppLifecycleState.resumed && _ratingPromptDue) {
      unawaited(
        Future<void>.delayed(
          const Duration(milliseconds: 800),
          _showRatingPrompt,
        ),
      );
    }
  }

  // -----------------------------------------------------------------------
  // Self-host delivery
  // -----------------------------------------------------------------------
  Future<void> _loadDeliverySettings() async {
    final settings = await _selfHost.loadSettings();
    if (!mounted) return;
    setState(() => _deliverySettings = settings);
    if (settings.mode == DeliveryMode.secondNumber) {
      await _restoreArmedDelivery();
    }
  }

  /// After an app restart, show a code the bot is still waiting for.
  Future<void> _restoreArmedDelivery() async {
    try {
      if (!await _selfHost.isRunning()) return;
      await _selfHost.connect(startIfStopped: false);
      final status = await _selfHost.status();
      final code = status.armedCode;
      final expiresAt = status.armedExpiresAt;
      final botNumber = status.me;
      if (!mounted ||
          code == null ||
          expiresAt == null ||
          botNumber == null ||
          _delivery != null ||
          _isBusy ||
          _videos.isNotEmpty) {
        return;
      }
      setState(() {
        _delivery = DeliveryResult(
          activationCode: code,
          whatsAppUrl: _botChatUrl(botNumber, code),
          fileCount: status.armedTotal,
          expiresAt: expiresAt,
        );
        _selfHostArmed = true;
        _botNumber = botNumber;
        _statusMessage =
            'Your bot is still waiting for this code. Send it from your main WhatsApp.';
      });
      _startActivationCountdown();
    } catch (_) {
      // Nothing to restore.
    }
  }

  Future<void> _checkArmedDelivery() async {
    final code = _delivery?.activationCode;
    if (!_selfHostArmed || code == null) return;
    try {
      // Starts the bot again if it already stopped; it remembers how the
      // last armed delivery ended.
      final status = await _selfHost.status();
      if (status.lastDeliveryCode == code &&
          status.lastDeliveryOutcome == 'delivered') {
        await _finishArmedDelivery(status.lastDeliveryTotal);
      }
    } catch (_) {
      // Try again on the next resume.
    }
  }

  Future<void> _openDeliverySettings() async {
    if (_isBusy || _delivery != null || !mounted) return;
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => SelfHostScreen(
          bridge: _selfHost,
          initialSettings: _deliverySettings,
          onOpenLink: _openSupportLink,
        ),
      ),
    );
    final settings = await _selfHost.loadSettings();
    if (!mounted) return;
    setState(() => _deliverySettings = settings);
  }

  void _handleSelfHostEvent(SelfHostEvent event) {
    if (!mounted) return;
    switch (event.name) {
      case 'sendProgress':
        final sent = event.integer('sent') ?? 0;
        final total = event.integer('total') ?? 1;
        if (!_isUploading && !_selfHostArmed) return;
        setState(() {
          _uploadProgress = total == 0 ? 0 : sent / total;
          _statusMessage = 'Sent clip $sent of $total.';
        });
      case 'deliveryStarted':
        if (!_selfHostArmed) return;
        setState(
          () => _statusMessage =
              'Code received. Your bot is sending ${event.integer('total') ?? ''} clips.',
        );
      case 'delivered':
        if (_selfHostArmed &&
            event.string('code') == _delivery?.activationCode) {
          unawaited(_finishArmedDelivery(event.integer('total') ?? 0));
        }
      case 'deliveryFailed':
        if (!_selfHostArmed) return;
        setState(
          () => _statusMessage =
              'Sending stopped: ${event.string('error') ?? 'unknown error'}. Send the code again to retry.',
        );
      case 'loggedOut':
        final settings = _deliverySettings.copyWith(clearLinkedNumber: true);
        setState(() => _deliverySettings = settings);
        unawaited(_selfHost.saveSettings(settings).catchError((_) {}));
        if (_selfHostMode) {
          _showMessage(
            'WhatsApp logged StatusDrop out of your number. Link it again in Delivery method.',
          );
        }
    }
  }

  Future<List<SelfHostClip>> _selfHostClips() async {
    final clips = <SelfHostClip>[];
    for (final clip in _processedClips) {
      clips.add(
        SelfHostClip(
          path: clip.path,
          width: _profile.width,
          height: _profile.height,
          seconds: clip.durationSeconds.round(),
          thumbnail: await _selfHost.clipThumbnail(clip.path),
        ),
      );
    }
    return clips;
  }

  static Uri _botChatUrl(String botNumber, String code) => Uri.https(
    'wa.me',
    '/$botNumber',
    {'text': 'Hi! My StatusDrop code is $code'},
  );

  Future<void> _deliver() => switch (_deliverySettings.mode) {
    DeliveryMode.statusDrop => _uploadAndFinalize(),
    DeliveryMode.ownNumber => _sendToOwnChat(),
    DeliveryMode.secondNumber => _armBotDelivery(),
  };

  /// Method 1: this phone sends the clips to the user's own chat.
  Future<void> _sendToOwnChat() async {
    if (_processedClips.isEmpty || _isBusy || _delivery != null) return;
    setState(() {
      _isUploading = true;
      _uploadProgress = 0;
      _statusMessage = 'Starting self-host delivery on this phone.';
    });
    try {
      final clips = await _selfHostClips();
      if (!mounted) return;
      setState(() => _statusMessage = 'Connecting to your WhatsApp.');
      final number = await _selfHost.sendToSelf(clips);
      try {
        await _videoService.clearProcessedClips();
      } catch (_) {
        // Start over clears anything left behind.
      }
      if (!mounted) return;
      setState(() {
        _isUploading = false;
        _uploadProgress = 1;
        _processedClips = const [];
        _selfHostOutcome = _SelfHostOutcome(
          clipCount: clips.length,
          number: number ?? _deliverySettings.linkedNumber,
          ownChat: true,
        );
        _statusMessage = 'Clips sent to your "Message yourself" chat.';
      });
    } catch (error) {
      _selfHostFailed(error);
    } finally {
      unawaited(_selfHost.disconnect());
    }
  }

  /// Method 2: arm a code on the user's bot number, then wait for it.
  Future<void> _armBotDelivery() async {
    if (_processedClips.isEmpty || _isBusy || _delivery != null) return;
    setState(() {
      _isUploading = true;
      _uploadProgress = 0;
      _statusMessage = 'Starting your bot on this phone.';
    });
    try {
      final clips = await _selfHostClips();
      final code = SelfHostBridge.newActivationCode();
      final expiresAt = DateTime.now().toUtc().add(_selfHostCodeLifetime);
      if (!mounted) return;
      setState(() => _statusMessage = 'Connecting your bot to WhatsApp.');
      final botNumber = await _selfHost.armDelivery(
        code: code,
        clips: clips,
        expiresAt: expiresAt,
      );
      if (botNumber == null) {
        throw const SelfHostException('Your bot did not report its number.');
      }
      if (!mounted) return;
      setState(() {
        _isUploading = false;
        _delivery = DeliveryResult(
          activationCode: code,
          whatsAppUrl: _botChatUrl(botNumber, code),
          fileCount: clips.length,
          expiresAt: expiresAt,
        );
        _selfHostArmed = true;
        _botNumber = botNumber;
        _statusMessage =
            'Code ready. Send it to your bot from your main WhatsApp.';
      });
      _startActivationCountdown();
    } catch (error) {
      _selfHostFailed(error);
      unawaited(_selfHost.disconnect());
    }
  }

  Future<void> _finishArmedDelivery(int total) async {
    if (!_selfHostArmed) return;
    _countdownTimer?.cancel();
    try {
      await _videoService.clearProcessedClips();
    } catch (_) {
      // Start over clears anything left behind.
    }
    if (!mounted) return;
    setState(() {
      _delivery = null;
      _selfHostArmed = false;
      _processedClips = const [];
      _selfHostOutcome = _SelfHostOutcome(
        clipCount: total,
        number: _botNumber,
        ownChat: false,
      );
      _statusMessage = 'Your bot sent the clips to your WhatsApp.';
    });
    unawaited(_selfHost.disconnect());
  }

  void _selfHostFailed(Object error) {
    if (!mounted) return;
    final notLinked = error is SelfHostException && error.notLinked;
    setState(() {
      _isUploading = false;
      _statusMessage = notLinked
          ? 'Link your number in Delivery method, then send again. Your clips were kept.'
          : 'Sending failed. Your finished clips were kept for retry.';
    });
    _showMessage(
      notLinked
          ? 'No WhatsApp number is linked for self-host delivery yet.'
          : _friendlyError(error),
    );
  }

  Future<void> _pickMedia({required bool photos}) async {
    final limit = photos ? maxPhotos : maxFiles;
    if (_isBusy || _delivery != null || _selfHostOutcome != null) return;
    // One job is either videos or photos, never both.
    if (_videos.isNotEmpty && _photoJob != photos) return;
    if (_videos.length >= limit) return;
    setState(() {
      _isPicking = true;
      _statusMessage = photos
          ? 'Opening the photo picker.'
          : 'Opening the video picker.';
    });

    try {
      final picked = photos
          ? await _videoService.pickPhotos(maxFiles: limit - _videos.length)
          : await _videoService.pickVideos(maxFiles: limit - _videos.length);
      var runningBytes = _totalBytes;
      final accepted = <VideoSource>[];
      final rejected = <VideoSource>[];

      for (final video in picked) {
        if (runningBytes + video.sizeBytes <= maxBytes) {
          accepted.add(video);
          runningBytes += video.sizeBytes;
        } else {
          rejected.add(video);
        }
      }
      for (final video in rejected) {
        await _videoService.deleteCachedFile(video.path);
      }
      if (accepted.isNotEmpty) {
        try {
          await _videoService.clearProcessedClips();
        } catch (_) {
          for (final video in accepted) {
            await _videoService.deleteCachedFile(video.path);
          }
          rethrow;
        }
      }

      if (!mounted) return;
      final noun = photos ? 'photo' : 'video';
      setState(() {
        _videos.addAll(accepted);
        _processedClips = const [];
        if (accepted.isNotEmpty) {
          _profile = photos ? QualityProfile.photo5 : _videoProfile;
        }
        _statusMessage = accepted.isEmpty
            ? 'No ${noun}s were added.'
            : '${_videos.length} ${_videos.length == 1 ? noun : '${noun}s'} selected.';
      });
      if (rejected.isNotEmpty) {
        _showMessage(
          'Some ${noun}s were not added because the 300 MB total limit would be exceeded.',
        );
      }
    } catch (error) {
      if (!mounted) return;
      setState(
        () => _statusMessage =
            'Could not select ${photos ? 'photos' : 'videos'}.',
      );
      _showMessage(_friendlyError(error));
    } finally {
      if (mounted) setState(() => _isPicking = false);
    }
  }

  Future<void> _removeVideo(VideoSource video) async {
    if (_isBusy || _delivery != null) return;
    try {
      await _videoService.clearProcessedClips();
      await _videoService.deleteCachedFile(video.path);
      if (!mounted) return;
      final noun = video.isPhoto ? 'photo' : 'video';
      setState(() {
        _videos.removeWhere((item) => item.id == video.id);
        _processedClips = const [];
        if (_videos.isEmpty) _profile = _videoProfile;
        _statusMessage = _videos.isEmpty
            ? 'No ${noun}s selected.'
            : '${_videos.length} ${_videos.length == 1 ? noun : '${noun}s'} selected.';
      });
    } catch (error) {
      if (!mounted) return;
      _showMessage(_friendlyError(error));
    }
  }

  Future<void> _clearVideos() async {
    if (_isBusy) return;
    try {
      if (_selfHostArmed) {
        // Do not delete clips the bot is sending right now.
        try {
          final status = await _selfHost.status();
          if (status.armedInProgress) {
            _showMessage(
              'Your bot is sending the clips. Wait until it finishes.',
            );
            return;
          }
        } catch (_) {
          // The bot is gone; nothing is being sent.
        }
        await _selfHost.cancelDelivery();
        unawaited(_selfHost.disconnect());
      }
      await _videoService.clearCache();
      _countdownTimer?.cancel();
      if (!mounted) return;
      setState(() {
        _videos.clear();
        _profile = _videoProfile;
        _processedClips = const [];
        _delivery = null;
        _selfHostArmed = false;
        _botNumber = null;
        _selfHostOutcome = null;
        _activationRemaining = Duration.zero;
        _progress = 0;
        _uploadProgress = 0;
        _statusMessage = 'No videos selected.';
      });
    } catch (error) {
      if (!mounted) return;
      _showMessage(_friendlyError(error));
    }
  }

  Future<void> _selectProfile(QualityProfile profile) async {
    if (_isBusy || _delivery != null || profile == _profile) return;
    if (profile.isPhoto || _photoJob) return;
    try {
      await _videoService.clearProcessedClips();
      if (!mounted) return;
      setState(() {
        _profile = profile;
        _videoProfile = profile;
        _processedClips = const [];
        _progress = 0;
        _statusMessage = '${profile.label} selected.';
      });
    } catch (error) {
      if (!mounted) return;
      _showMessage(_friendlyError(error));
    }
  }

  Future<void> _startProcessing() async {
    if (_videos.isEmpty || _isBusy || _delivery != null) return;
    if (_selfHostMode && _deliverySettings.linkedNumber == null) {
      _showMessage(
        'Link your WhatsApp number in Delivery method first, or switch back to the StatusDrop number.',
      );
      return;
    }
    setState(() {
      _isProcessing = true;
      _processedClips = const [];
      _progress = 0;
      _statusMessage = 'Preparing local compression.';
    });
    try {
      await _videoService.startProcessing(videos: _videos, profile: _profile);
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _isProcessing = false;
        _statusMessage = 'Local compression is not available yet.';
      });
      _showMessage(_friendlyError(error));
    }
  }

  Future<void> _cancelProcessing() async {
    try {
      await _videoService.cancelProcessing();
    } catch (error) {
      if (!mounted) return;
      _showMessage(_friendlyError(error));
    }
  }

  Future<void> _handleNativeEvent(NativeVideoEvent event) async {
    if (!mounted) return;
    setState(() {
      _statusMessage = event.message;
      _progress = event.progress.clamp(0, 1);
      if (event.type == NativeVideoEventType.cancelled ||
          event.type == NativeVideoEventType.error) {
        _isProcessing = false;
      }
    });
    if (event.type == NativeVideoEventType.completed) {
      try {
        final clips = await _videoService.getProcessedClips();
        if (!mounted) return;
        setState(() {
          _processedClips = clips;
          _isProcessing = false;
          _progress = 1;
          _statusMessage =
              '${clips.length} ${clips.length == 1 ? 'clip is' : 'clips are'} ready. ${_selfHostMode ? 'Sending from this phone.' : 'Starting secure upload.'}';
        });
        if (clips.isNotEmpty) {
          await _deliver();
        }
      } catch (error) {
        if (!mounted) return;
        setState(() {
          _isProcessing = false;
          _statusMessage = 'Could not load the finished clips.';
        });
        _showMessage(_friendlyError(error));
      }
    }
  }

  Future<void> _uploadAndFinalize() async {
    if (_processedClips.isEmpty || _isBusy || _delivery != null) return;
    setState(() {
      _isUploading = true;
      _uploadProgress = 0;
      _statusMessage = 'Preparing secure clip upload.';
    });

    try {
      final result = await _mobileApi.uploadAndFinalize(
        clips: _processedClips,
        profile: _profile,
        onProgress: (value, message) {
          if (!mounted) return;
          setState(() {
            _uploadProgress = value.clamp(0, 1);
            _statusMessage = message;
          });
        },
      );
      try {
        await _videoService.clearProcessedClips();
      } catch (_) {
        // Delivery owns verified server copies. Start over can clear any local
        // cache that survived an interrupted best-effort cleanup.
      }
      if (!mounted) return;
      setState(() {
        _isUploading = false;
        _uploadProgress = 1;
        _processedClips = const [];
        _delivery = result;
        _statusMessage =
            'Activation code ready. Open WhatsApp before it expires.';
      });
      _startActivationCountdown();
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _isUploading = false;
        _statusMessage =
            'Upload failed. Your finished clips were kept for retry.';
      });
      _showMessage(_friendlyError(error));
    }
  }

  void _startActivationCountdown() {
    _countdownTimer?.cancel();

    void updateRemaining() {
      final delivery = _delivery;
      if (!mounted || delivery == null) return;
      final remaining = delivery.expiresAt.difference(DateTime.now().toUtc());
      setState(() {
        _activationRemaining = remaining.isNegative ? Duration.zero : remaining;
        if (_activationRemaining == Duration.zero) {
          _statusMessage =
              'Activation code expired. Start over to create a new one.';
        }
      });
      if (remaining <= Duration.zero) _countdownTimer?.cancel();
    }

    updateRemaining();
    _countdownTimer = Timer.periodic(
      const Duration(seconds: 1),
      (_) => updateRemaining(),
    );
  }

  Future<void> _copyActivationCode() async {
    final code = _delivery?.activationCode;
    if (code == null) return;
    await Clipboard.setData(ClipboardData(text: code));
    if (mounted) _showMessage('Activation code copied.');
  }

  Future<void> _openWhatsApp() async {
    final delivery = _delivery;
    if (delivery == null || _activationRemaining <= Duration.zero) return;
    try {
      await _videoService.openExternalUrl(delivery.whatsAppUrl);
      _noteDeliveryOpened(delivery.activationCode);
    } catch (error) {
      if (!mounted) return;
      _showMessage(_friendlyError(error));
    }
  }

  // -----------------------------------------------------------------------
  // Rating prompt (Play build only; MAX is not on Google Play)
  // -----------------------------------------------------------------------
  // One plain prompt, shown once, when the user comes back after their
  // second delivery. Play policy: no incentives, no "5 stars" wording, no
  // "do you like it?" question first, and it can always be dismissed.
  Future<void> _loadAppState() async {
    try {
      final json = await _videoService.getAppState();
      final map = json == null ? null : jsonDecode(json);
      if (map is Map) {
        _deliveriesOpened = (map['deliveriesOpened'] as num?)?.toInt() ?? 0;
        _ratingPromptShown = map['ratingPromptShown'] == true;
      }
    } catch (_) {
      // Start counting from zero.
    }
    _ratingPromptDue =
        !_ratingPromptShown && _deliveriesOpened >= _ratingAfterDeliveries;
  }

  Future<void> _saveAppState() async {
    try {
      await _videoService.setAppState(
        jsonEncode({
          'deliveriesOpened': _deliveriesOpened,
          'ratingPromptShown': _ratingPromptShown,
        }),
      );
    } catch (_) {
      // Not worth bothering the user about.
    }
  }

  void _noteDeliveryOpened(String code) {
    if (Edition.current.hasSelfHost || _ratingPromptShown) return;
    // Count each activation code once, even if Open WhatsApp is tapped again.
    if (code == _lastCountedCode) return;
    _lastCountedCode = code;
    _deliveriesOpened += 1;
    if (_deliveriesOpened >= _ratingAfterDeliveries) _ratingPromptDue = true;
    unawaited(_saveAppState());
  }

  Future<void> _showRatingPrompt() async {
    if (!mounted || !_ratingPromptDue || _ratingPromptShown || _isBusy) {
      return;
    }
    _ratingPromptDue = false;
    _ratingPromptShown = true;
    unawaited(_saveAppState());
    final rate = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        icon: const Icon(Icons.star_outline_rounded),
        title: const Text('Rate StatusDrop on Google Play'),
        content: const Text(
          'A rating on Google Play helps other people find StatusDrop. It only takes a few seconds.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('No thanks'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Rate on Play'),
          ),
        ],
      ),
    );
    if (rate == true) await _openPlayListing();
  }

  Future<void> _openPlayListing() async {
    try {
      // Opens the Play Store app straight on the listing.
      await _videoService.openExternalUrl(
        Uri.parse('market://details?id=$_playPackage'),
      );
    } catch (_) {
      await _openSupportLink(
        Uri.https('play.google.com', '/store/apps/details', {
          'id': _playPackage,
        }),
      );
    }
  }

  /// Opens the chat the clips went to: the user's own "Message yourself"
  /// chat (method 1) or the chat with their bot number (method 2).
  Future<void> _openSelfHostChat() async {
    final number = _selfHostOutcome?.number;
    if (number == null || number.isEmpty) return;
    try {
      await _videoService.openExternalUrl(Uri.https('wa.me', '/$number'));
    } catch (error) {
      if (!mounted) return;
      _showMessage(_friendlyError(error));
    }
  }

  Future<void> _openSupportLink(Uri uri) async {
    try {
      await _videoService.openExternalUrl(uri);
    } catch (error) {
      if (!mounted) return;
      _showMessage(_friendlyError(error));
    }
  }

  Future<void> _showAbout() async {
    if (_isBusy || !mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      showDragHandle: true,
      builder: (context) => FractionallySizedBox(
        heightFactor: 0.82,
        child: _AboutSheet(onOpenLink: _openSupportLink),
      ),
    );
  }

  void _showMessage(String text) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(text)));
  }

  String _friendlyError(Object error) {
    final text = error.toString();
    final separator = text.indexOf(': ');
    return separator >= 0 ? text.substring(separator + 2) : text;
  }

  @override
  Widget build(BuildContext context) {
    final busyProgress = _isUploading ? _uploadProgress : _progress;
    return Scaffold(
      appBar: AppBar(
        title: const _AppBrand(),
        actions: [
          if (_videos.isNotEmpty && !_isBusy)
            IconButton(
              onPressed: _clearVideos,
              tooltip: 'Clear current job',
              icon: const Icon(Icons.delete_sweep_outlined),
            ),
          PopupMenuButton<_AppMenuAction>(
            enabled: !_isBusy,
            tooltip: 'More options',
            icon: const Icon(Icons.more_vert),
            onSelected: (action) {
              switch (action) {
                case _AppMenuAction.delivery:
                  unawaited(_openDeliverySettings());
                case _AppMenuAction.about:
                  unawaited(_showAbout());
                case _AppMenuAction.rate:
                  unawaited(_openPlayListing());
              }
            },
            itemBuilder: (context) => [
              PopupMenuItem(
                value: _AppMenuAction.delivery,
                enabled: _delivery == null,
                child: const Text('Delivery method'),
              ),
              if (!Edition.current.hasSelfHost)
                const PopupMenuItem(
                  value: _AppMenuAction.rate,
                  child: Text('Rate on Play Store'),
                ),
              const PopupMenuItem(
                value: _AppMenuAction.about,
                child: Text('About & support'),
              ),
            ],
          ),
          const SizedBox(width: 8),
        ],
      ),
      body: Stack(
        children: [
          SafeArea(
            top: false,
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 720),
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(20, 12, 20, 40),
                  children: [
                    const _BrandIntro(),
                    const SizedBox(height: 22),
                    _WorkflowStepper(currentStep: _currentStep),
                    const SizedBox(height: 18),
                    _StatusPanel(
                      message: _statusMessage,
                      busy: _isProcessing || _isUploading,
                      uploading: _isUploading,
                      progress: busyProgress,
                    ),
                    const SizedBox(height: 14),
                    _PrivacyNote(selfHost: _selfHostMode),
                    // One-time WhatsApp setup. Hidden while a delivery panel
                    // shows, so the code or result stays near the top.
                    if (_delivery == null && _selfHostOutcome == null) ...[
                      const SizedBox(height: 14),
                      const SetupGuideCard(),
                    ],
                    const SizedBox(height: 24),
                    AnimatedSwitcher(
                      duration: const Duration(milliseconds: 260),
                      switchInCurve: Curves.easeOutCubic,
                      switchOutCurve: Curves.easeInCubic,
                      transitionBuilder: (child, animation) => FadeTransition(
                        opacity: animation,
                        child: SlideTransition(
                          position: Tween<Offset>(
                            begin: const Offset(0, 0.025),
                            end: Offset.zero,
                          ).animate(animation),
                          child: child,
                        ),
                      ),
                      child: _selfHostOutcome != null
                          ? _SelfHostSentPanel(
                              key: const ValueKey('selfhost-sent'),
                              outcome: _selfHostOutcome!,
                              onOpenWhatsApp: _openSelfHostChat,
                              onStartOver: _clearVideos,
                            )
                          : _delivery != null
                          ? _ActivationPanel(
                              key: const ValueKey('activation'),
                              delivery: _delivery!,
                              remaining: _activationRemaining,
                              onCopy: _copyActivationCode,
                              onOpenWhatsApp: _openWhatsApp,
                              onStartOver: _clearVideos,
                              subtitle: _selfHostArmed
                                  ? 'Send this code from your main WhatsApp to your bot +${_botNumber ?? ''}. It replies with ${_delivery!.fileCount} ${_delivery!.fileCount == 1 ? 'clip' : 'clips'}.'
                                  : null,
                            )
                          : Column(
                              key: ValueKey(_stageKey),
                              children: [
                                _TaskPanel(
                                  step: 1,
                                  complete: _videos.isNotEmpty,
                                  title: 'Choose videos',
                                  description:
                                      'Pick up to 3 videos, or up to 10 photos. Originals stay in private app storage.',
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.stretch,
                                    children: [
                                      FilledButton.icon(
                                        onPressed:
                                            _isBusy ||
                                                _photoJob ||
                                                _videos.length >= maxFiles
                                            ? null
                                            : () => _pickMedia(photos: false),
                                        icon: _isPicking && !_photoJob
                                            ? const SizedBox.square(
                                                dimension: 20,
                                                child:
                                                    CircularProgressIndicator(
                                                      strokeWidth: 2.5,
                                                    ),
                                              )
                                            : const Icon(
                                                Icons.video_library_outlined,
                                              ),
                                        label: Text(
                                          _videos.isEmpty || _photoJob
                                              ? 'Choose videos'
                                              : 'Add another video',
                                        ),
                                      ),
                                      const SizedBox(height: 10),
                                      OutlinedButton.icon(
                                        onPressed:
                                            _isBusy ||
                                                (_videos.isNotEmpty &&
                                                    !_photoJob) ||
                                                _videos.length >= maxPhotos
                                            ? null
                                            : () => _pickMedia(photos: true),
                                        icon: const Icon(
                                          Icons.photo_library_outlined,
                                        ),
                                        label: Text(
                                          _photoJob
                                              ? 'Add more photos'
                                              : 'Choose photos',
                                        ),
                                      ),
                                      const SizedBox(height: 14),
                                      _SelectionMeter(
                                        count: _videos.length,
                                        maxCount: _maxCount,
                                        unit: _photoJob ? 'photos' : 'videos',
                                        bytes: _totalBytes,
                                        maxBytes: maxBytes,
                                      ),
                                      if (_videos.isNotEmpty) ...[
                                        const SizedBox(height: 16),
                                        ..._videos.map(
                                          (video) => Padding(
                                            padding: const EdgeInsets.only(
                                              bottom: 10,
                                            ),
                                            child: _VideoTile(
                                              video: video,
                                              enabled: !_isBusy,
                                              onRemove: () =>
                                                  _removeVideo(video),
                                            ),
                                          ),
                                        ),
                                      ],
                                    ],
                                  ),
                                ),
                                if (_videos.isNotEmpty &&
                                    _processedClips.isEmpty) ...[
                                  const SizedBox(height: 16),
                                  _TaskPanel(
                                    step: 2,
                                    complete: false,
                                    title: 'Prepare on this phone',
                                    description: _photoJob
                                        ? 'Each photo becomes a 5-second 1080p video clip, so WhatsApp keeps it sharp on Status.'
                                        : 'Choose quality. StatusDrop compresses locally, then continues securely to delivery.',
                                    child: Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.stretch,
                                      children: [
                                        _DeliveryRow(
                                          settings: _deliverySettings,
                                          enabled: !_isBusy,
                                          onChange: _openDeliverySettings,
                                        ),
                                        const SizedBox(height: 12),
                                        if (_photoJob)
                                          Padding(
                                            padding: const EdgeInsets.only(
                                              bottom: 10,
                                            ),
                                            child: _QualityOption(
                                              profile: QualityProfile.photo5,
                                              selected: true,
                                              enabled: !_isBusy,
                                              onSelected: () {},
                                            ),
                                          ),
                                        if (!_photoJob)
                                          ...QualityProfile.videoProfiles.map(
                                            (profile) => Padding(
                                              padding: const EdgeInsets.only(
                                                bottom: 10,
                                              ),
                                              child: _QualityOption(
                                                profile: profile,
                                                selected: _profile == profile,
                                                enabled: !_isBusy,
                                                onSelected: () =>
                                                    _selectProfile(profile),
                                              ),
                                            ),
                                          ),
                                        const SizedBox(height: 4),
                                        if (_isProcessing)
                                          OutlinedButton.icon(
                                            onPressed: _cancelProcessing,
                                            icon: const Icon(
                                              Icons.stop_circle_outlined,
                                            ),
                                            label: const Text(
                                              'Cancel processing',
                                            ),
                                          )
                                        else
                                          FilledButton.icon(
                                            onPressed: _isBusy
                                                ? null
                                                : _startProcessing,
                                            icon: const Icon(
                                              Icons.auto_awesome_outlined,
                                            ),
                                            label: const Text(
                                              'Compress and continue',
                                            ),
                                          ),
                                      ],
                                    ),
                                  ),
                                ],
                                if (_processedClips.isNotEmpty) ...[
                                  const SizedBox(height: 16),
                                  _TaskPanel(
                                    step: 3,
                                    complete: false,
                                    title: 'Finish delivery',
                                    description: _selfHostMode
                                        ? 'Sending needs attention. Your finished clips are still safe on this phone.'
                                        : 'Automatic upload needs attention. Your finished clips are still safe on this phone.',
                                    child: _ReadySummary(
                                      clipCount: _processedClips.length,
                                      totalBytes: _processedBytes,
                                      uploading: _isUploading,
                                      selfHost: _selfHostMode,
                                      onUpload: _isBusy ? null : _deliver,
                                    ),
                                  ),
                                ],
                              ],
                            ),
                    ),
                    const SizedBox(height: 24),
                    TutorialGuide(
                      key: ValueKey(_deliverySettings.mode),
                      steps: TutorialSteps.forMode(_deliverySettings.mode),
                      hint: TutorialSteps.hintFor(_deliverySettings.mode),
                      heroScope: 'home',
                    ),
                    const SizedBox(height: 28),
                    Text(
                      '$appDisplayName $appVersionName · Open-source Android client',
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
          if (_isProcessing || _isUploading)
            Positioned.fill(
              child: _BusyOverlay(
                uploading: _isUploading,
                selfHost: _selfHostMode,
                message: _statusMessage,
                progress: busyProgress,
                onCancel: _isProcessing ? _cancelProcessing : null,
              ),
            ),
        ],
      ),
    );
  }

  static String formatSize(int bytes) {
    if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
    return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
  }
}

class _AppBrand extends StatelessWidget {
  const _AppBrand();

  @override
  Widget build(BuildContext context) => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      ClipRRect(
        borderRadius: BorderRadius.circular(10),
        child: Image.asset(
          'assets/images/statusdrop_logo.png',
          width: 38,
          height: 38,
          fit: BoxFit.cover,
          excludeFromSemantics: true,
        ),
      ),
      const SizedBox(width: 11),
      Text(
        'StatusDrop',
        style: Theme.of(
          context,
        ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w900),
      ),
    ],
  );
}

class _BrandIntro extends StatelessWidget {
  const _BrandIntro();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Semantics(
      container: true,
      label:
          'StatusDrop. Create WhatsApp Status videos privately on this phone.',
      child: ExcludeSemantics(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Status-ready video, made on your phone',
              style: theme.textTheme.headlineMedium,
            ),
            const SizedBox(height: 8),
            Text(
              'No login. No server compression. Finished clips upload securely after local processing.',
              style: theme.textTheme.bodyLarge?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _WorkflowStepper extends StatelessWidget {
  const _WorkflowStepper({required this.currentStep});

  final int currentStep;
  static const labels = ['Select', 'Compress', 'Send'];

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Semantics(
      container: true,
      label:
          'Step ${currentStep + 1} of ${labels.length}: ${labels[currentStep]}',
      child: ExcludeSemantics(
        child: Row(
          children: [
            for (var index = 0; index < labels.length; index++) ...[
              Expanded(
                flex: 2,
                child: Column(
                  children: [
                    AnimatedContainer(
                      duration: const Duration(milliseconds: 220),
                      width: 36,
                      height: 36,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: index <= currentStep
                            ? scheme.primary
                            : scheme.surfaceContainerHigh,
                      ),
                      alignment: Alignment.center,
                      child: Icon(
                        index < currentStep ? Icons.check : _stepIcon(index),
                        size: 19,
                        color: index <= currentStep
                            ? scheme.onPrimary
                            : scheme.onSurfaceVariant,
                      ),
                    ),
                    const SizedBox(height: 7),
                    Text(
                      labels[index],
                      style: Theme.of(context).textTheme.labelMedium?.copyWith(
                        color: index == currentStep
                            ? scheme.primary
                            : scheme.onSurfaceVariant,
                        fontWeight: index == currentStep
                            ? FontWeight.w800
                            : FontWeight.w600,
                      ),
                    ),
                  ],
                ),
              ),
              if (index < labels.length - 1)
                Expanded(
                  child: Container(
                    height: 2,
                    margin: const EdgeInsets.only(bottom: 28),
                    color: index < currentStep
                        ? scheme.primary
                        : scheme.outlineVariant,
                  ),
                ),
            ],
          ],
        ),
      ),
    );
  }

  static IconData _stepIcon(int index) => switch (index) {
    0 => Icons.video_library_outlined,
    1 => Icons.tune_outlined,
    _ => Icons.send_outlined,
  };
}

class _BusyOverlay extends StatelessWidget {
  const _BusyOverlay({
    required this.uploading,
    required this.selfHost,
    required this.message,
    required this.progress,
    required this.onCancel,
  });

  final bool uploading;
  final bool selfHost;
  final String message;
  final double progress;
  final VoidCallback? onCancel;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final percentage = (progress.clamp(0, 1) * 100).round();
    final title = !uploading
        ? 'Compressing on this phone'
        : selfHost
        ? 'Sending from this phone'
        : 'Sending securely';
    final supportingText = !uploading
        ? 'Your original video stays on this phone. You can cancel without losing the selection.'
        : selfHost
        ? 'Your own WhatsApp number is sending the finished clips. Keep StatusDrop open until it finishes.'
        : 'Finished clips are uploading, being verified, and prepared for WhatsApp.';
    final progressLabel = !uploading
        ? 'Local processing'
        : selfHost
        ? 'WhatsApp send'
        : 'Secure upload';

    return Stack(
      fit: StackFit.expand,
      children: [
        ModalBarrier(
          dismissible: false,
          color: scheme.scrim.withValues(alpha: 0.72),
          semanticsLabel: '$title in progress',
        ),
        SafeArea(
          child: Center(
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 380),
                child: Semantics(
                  container: true,
                  liveRegion: true,
                  label: '$title. $message. $percentage percent.',
                  child: ExcludeSemantics(
                    child: Card(
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(26),
                        side: BorderSide(color: scheme.primary, width: 1.5),
                      ),
                      child: Padding(
                        padding: const EdgeInsets.all(24),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            Align(
                              alignment: Alignment.centerLeft,
                              child: Container(
                                width: 58,
                                height: 58,
                                decoration: BoxDecoration(
                                  color: scheme.primaryContainer,
                                  borderRadius: BorderRadius.circular(18),
                                ),
                                child: Icon(
                                  !uploading
                                      ? Icons.auto_awesome_outlined
                                      : selfHost
                                      ? Icons.send_outlined
                                      : Icons.cloud_upload_outlined,
                                  color: scheme.onPrimaryContainer,
                                  size: 30,
                                ),
                              ),
                            ),
                            const SizedBox(height: 20),
                            Text(title, style: theme.textTheme.headlineSmall),
                            const SizedBox(height: 8),
                            Text(
                              message,
                              style: theme.textTheme.bodyLarge?.copyWith(
                                color: scheme.onSurfaceVariant,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                            const SizedBox(height: 22),
                            Row(
                              children: [
                                Expanded(
                                  child: Text(
                                    progressLabel,
                                    style: theme.textTheme.labelLarge,
                                  ),
                                ),
                                Text(
                                  '$percentage%',
                                  style: theme.textTheme.titleMedium?.copyWith(
                                    color: scheme.primary,
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 10),
                            LinearProgressIndicator(
                              value: progress.clamp(0, 1),
                            ),
                            const SizedBox(height: 16),
                            Text(
                              supportingText,
                              style: theme.textTheme.bodySmall?.copyWith(
                                color: scheme.onSurfaceVariant,
                              ),
                            ),
                            if (onCancel != null) ...[
                              const SizedBox(height: 18),
                              OutlinedButton.icon(
                                onPressed: onCancel,
                                icon: const Icon(Icons.stop_circle_outlined),
                                label: const Text('Cancel processing'),
                              ),
                            ],
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _StatusPanel extends StatelessWidget {
  const _StatusPanel({
    required this.message,
    required this.busy,
    required this.uploading,
    required this.progress,
  });

  final String message;
  final bool busy;
  final bool uploading;
  final double progress;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final percentage = (progress.clamp(0, 1) * 100).round();
    return Semantics(
      liveRegion: true,
      container: true,
      label: busy ? '$message $percentage percent' : message,
      child: ExcludeSemantics(
        child: Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: busy ? scheme.primaryContainer : scheme.surfaceContainerLow,
            borderRadius: BorderRadius.circular(18),
            border: Border.all(
              color: busy ? scheme.primary : scheme.outlineVariant,
            ),
          ),
          child: Column(
            children: [
              Row(
                children: [
                  Icon(
                    busy
                        ? uploading
                              ? Icons.cloud_upload_outlined
                              : Icons.motion_photos_on_outlined
                        : Icons.info_outline,
                    color: busy
                        ? scheme.onPrimaryContainer
                        : scheme.onSurfaceVariant,
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      message,
                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                        color: busy
                            ? scheme.onPrimaryContainer
                            : scheme.onSurface,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                  if (busy) ...[
                    const SizedBox(width: 10),
                    Text(
                      '$percentage%',
                      style: Theme.of(context).textTheme.labelLarge?.copyWith(
                        color: scheme.onPrimaryContainer,
                      ),
                    ),
                  ],
                ],
              ),
              if (busy) ...[
                const SizedBox(height: 13),
                LinearProgressIndicator(value: progress.clamp(0, 1)),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _PrivacyNote extends StatelessWidget {
  const _PrivacyNote({required this.selfHost});

  final bool selfHost;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: scheme.secondaryContainer,
        borderRadius: BorderRadius.circular(18),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.shield_outlined, color: scheme.onSecondaryContainer),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Private on-device processing',
                  style: Theme.of(context).textTheme.titleSmall?.copyWith(
                    color: scheme.onSecondaryContainer,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  selfHost
                      ? 'Nothing uploads to StatusDrop. Your own WhatsApp number sends the finished clips from this phone.'
                      : 'Original videos never upload. After local compression, only finished clips upload securely.',
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: scheme.onSecondaryContainer,
                    height: 1.35,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _TaskPanel extends StatelessWidget {
  const _TaskPanel({
    required this.step,
    required this.complete,
    required this.title,
    required this.description,
    required this.child,
  });

  final int step;
  final bool complete;
  final String title;
  final String description;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: 44,
                  height: 44,
                  decoration: BoxDecoration(
                    color: complete ? scheme.primary : scheme.primaryContainer,
                    borderRadius: BorderRadius.circular(14),
                  ),
                  alignment: Alignment.center,
                  child: complete
                      ? Icon(Icons.check, color: scheme.onPrimary)
                      : Text(
                          step.toString().padLeft(2, '0'),
                          style: Theme.of(context).textTheme.labelLarge
                              ?.copyWith(
                                color: scheme.onPrimaryContainer,
                                fontWeight: FontWeight.w900,
                              ),
                        ),
                ),
                const SizedBox(width: 13),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Semantics(
                        header: true,
                        child: Text(
                          title,
                          style: Theme.of(context).textTheme.titleLarge,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        description,
                        style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          color: scheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 20),
            child,
          ],
        ),
      ),
    );
  }
}

class _SelectionMeter extends StatelessWidget {
  const _SelectionMeter({
    required this.count,
    required this.maxCount,
    required this.unit,
    required this.bytes,
    required this.maxBytes,
  });

  final int count;
  final int maxCount;
  final String unit;
  final int bytes;
  final int maxBytes;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Semantics(
      label:
          '$count of $maxCount $unit selected. ${_HomeScreenState.formatSize(bytes)} of 300 megabytes used.',
      child: ExcludeSemantics(
        child: Column(
          children: [
            Row(
              children: [
                Text(
                  '$count/$maxCount $unit',
                  style: Theme.of(context).textTheme.labelLarge,
                ),
                const Spacer(),
                Text(
                  '${_HomeScreenState.formatSize(bytes)} / 300 MB',
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: scheme.onSurfaceVariant,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 9),
            LinearProgressIndicator(value: (bytes / maxBytes).clamp(0, 1)),
          ],
        ),
      ),
    );
  }
}

class _VideoTile extends StatelessWidget {
  const _VideoTile({
    required this.video,
    required this.enabled,
    required this.onRemove,
  });

  final VideoSource video;
  final bool enabled;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final detail = [
      _HomeScreenState.formatSize(video.sizeBytes),
      if (video.durationSeconds != null && video.durationSeconds! > 0)
        _formatDuration(video.durationSeconds!),
      if (video.width != null && video.height != null && video.width! > 0)
        '${video.width}×${video.height}',
    ].join(' · ');

    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 8, 10),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Row(
        children: [
          Container(
            width: 44,
            height: 44,
            decoration: BoxDecoration(
              color: scheme.primaryContainer,
              borderRadius: BorderRadius.circular(13),
            ),
            child: Icon(
              video.isPhoto ? Icons.image_outlined : Icons.movie_outlined,
              color: scheme.onPrimaryContainer,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  video.name,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(
                    context,
                  ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: 3),
                Text(
                  detail,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: scheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
          IconButton(
            onPressed: enabled ? onRemove : null,
            tooltip: 'Remove ${video.name}',
            icon: const Icon(Icons.close),
          ),
        ],
      ),
    );
  }

  static String _formatDuration(double seconds) {
    final rounded = seconds.round();
    final minutes = rounded ~/ 60;
    final remaining = rounded % 60;
    return '$minutes:${remaining.toString().padLeft(2, '0')}';
  }
}

class _QualityOption extends StatelessWidget {
  const _QualityOption({
    required this.profile,
    required this.selected,
    required this.enabled,
    required this.onSelected,
  });

  final QualityProfile profile;
  final bool selected;
  final bool enabled;
  final VoidCallback onSelected;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Semantics(
      button: true,
      selected: selected,
      enabled: enabled,
      label:
          '${profile.label}. ${profile.description}. ${profile.width} by ${profile.height}.${profile.note == null ? '' : ' ${profile.note}'}',
      child: ExcludeSemantics(
        child: AnimatedOpacity(
          opacity: enabled ? 1 : 0.55,
          duration: const Duration(milliseconds: 160),
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 180),
            decoration: BoxDecoration(
              color: selected
                  ? scheme.primaryContainer
                  : scheme.surfaceContainerLow,
              borderRadius: BorderRadius.circular(17),
              border: Border.all(
                color: selected ? scheme.primary : scheme.outlineVariant,
                width: selected ? 2 : 1,
              ),
            ),
            child: Material(
              color: Colors.transparent,
              child: InkWell(
                onTap: enabled ? onSelected : null,
                borderRadius: BorderRadius.circular(17),
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Row(
                    children: [
                      Icon(
                        selected
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
                            Text(
                              profile.label,
                              style: Theme.of(context).textTheme.titleMedium,
                            ),
                            const SizedBox(height: 3),
                            Text(
                              '${profile.description} · ${profile.width}×${profile.height}',
                              style: Theme.of(context).textTheme.bodySmall
                                  ?.copyWith(
                                    color: selected
                                        ? scheme.onPrimaryContainer
                                        : scheme.onSurfaceVariant,
                                  ),
                            ),
                            if (profile.note != null) ...[
                              const SizedBox(height: 8),
                              Container(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 10,
                                  vertical: 7,
                                ),
                                decoration: BoxDecoration(
                                  color: scheme.tertiaryContainer,
                                  borderRadius: BorderRadius.circular(10),
                                ),
                                child: Row(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Icon(
                                      Icons.wifi_rounded,
                                      size: 16,
                                      color: scheme.onTertiaryContainer,
                                    ),
                                    const SizedBox(width: 6),
                                    Expanded(
                                      child: Text(
                                        profile.note!,
                                        style: Theme.of(context)
                                            .textTheme
                                            .labelSmall
                                            ?.copyWith(
                                              color: scheme.onTertiaryContainer,
                                              height: 1.3,
                                            ),
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ],
                          ],
                        ),
                      ),
                      if (selected)
                        Icon(
                          Icons.check_circle,
                          color: scheme.primary,
                          size: 22,
                        ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _ReadySummary extends StatelessWidget {
  const _ReadySummary({
    required this.clipCount,
    required this.totalBytes,
    required this.uploading,
    required this.selfHost,
    required this.onUpload,
  });

  final int clipCount;
  final int totalBytes;
  final bool uploading;
  final bool selfHost;
  final VoidCallback? onUpload;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: scheme.primaryContainer,
            borderRadius: BorderRadius.circular(18),
          ),
          child: Row(
            children: [
              Icon(Icons.check_circle_outline, size: 34, color: scheme.primary),
              const SizedBox(width: 13),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '$clipCount WhatsApp-ready ${clipCount == 1 ? 'clip' : 'clips'}',
                      style: Theme.of(context).textTheme.titleMedium?.copyWith(
                        color: scheme.onPrimaryContainer,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      '${_HomeScreenState.formatSize(totalBytes)} total · created locally',
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: scheme.onPrimaryContainer,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        Text(
          selfHost
              ? 'Your own WhatsApp number sends these clips from this phone. Nothing uploads to StatusDrop.'
              : 'Only these finished clips upload. They remain available for five minutes after activation.',
          style: Theme.of(
            context,
          ).textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
        ),
        const SizedBox(height: 14),
        FilledButton.icon(
          onPressed: onUpload,
          icon: uploading
              ? const SizedBox.square(
                  dimension: 20,
                  child: CircularProgressIndicator(strokeWidth: 2.5),
                )
              : Icon(selfHost ? Icons.send_outlined : Icons.lock_outline),
          label: Text(
            uploading
                ? (selfHost ? 'Sending' : 'Uploading securely')
                : (selfHost ? 'Retry sending' : 'Retry secure upload'),
          ),
        ),
      ],
    );
  }
}

class _ActivationPanel extends StatelessWidget {
  const _ActivationPanel({
    super.key,
    required this.delivery,
    required this.remaining,
    required this.onCopy,
    required this.onOpenWhatsApp,
    required this.onStartOver,
    this.subtitle,
  });

  final DeliveryResult delivery;
  final Duration remaining;
  final VoidCallback onCopy;
  final VoidCallback onOpenWhatsApp;
  final VoidCallback onStartOver;

  /// Replaces the default "N clips verified and ready" line (self-host).
  final String? subtitle;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final expired = remaining <= Duration.zero;
    final minutes = remaining.inMinutes;
    final seconds = remaining.inSeconds.remainder(60);
    final timeText =
        '${minutes.toString().padLeft(2, '0')}:${seconds.toString().padLeft(2, '0')}';

    return Card(
      color: expired ? scheme.errorContainer : scheme.primaryContainer,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(24),
        side: BorderSide(
          color: expired ? scheme.error : scheme.primary,
          width: 1.5,
        ),
      ),
      child: Padding(
        padding: const EdgeInsets.all(22),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Container(
                  width: 48,
                  height: 48,
                  decoration: BoxDecoration(
                    color: expired ? scheme.error : scheme.primary,
                    borderRadius: BorderRadius.circular(15),
                  ),
                  child: Icon(
                    expired ? Icons.timer_off_outlined : Icons.send_outlined,
                    color: expired ? scheme.onError : scheme.onPrimary,
                  ),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Semantics(
                        header: true,
                        child: Text(
                          expired ? 'Activation expired' : 'Ready for WhatsApp',
                          style: theme.textTheme.titleLarge?.copyWith(
                            color: expired
                                ? scheme.onErrorContainer
                                : scheme.onPrimaryContainer,
                          ),
                        ),
                      ),
                      Text(
                        subtitle ??
                            '${delivery.fileCount} ${delivery.fileCount == 1 ? 'clip' : 'clips'} verified and ready',
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: expired
                              ? scheme.onErrorContainer
                              : scheme.onPrimaryContainer,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 20),
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: scheme.surfaceContainerLowest,
                borderRadius: BorderRadius.circular(18),
                border: Border.all(color: scheme.outlineVariant),
              ),
              child: Column(
                children: [
                  Text('Activation code', style: theme.textTheme.labelMedium),
                  const SizedBox(height: 7),
                  Semantics(
                    label: 'Activation code ${delivery.activationCode}',
                    child: ExcludeSemantics(
                      child: SelectableText(
                        delivery.activationCode,
                        textAlign: TextAlign.center,
                        style: theme.textTheme.headlineMedium?.copyWith(
                          fontWeight: FontWeight.w900,
                          letterSpacing: 3.2,
                        ),
                      ),
                    ),
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
            Semantics(
              liveRegion: expired,
              label: expired
                  ? 'Activation code expired'
                  : 'Activation expires in $timeText',
              child: ExcludeSemantics(
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(
                      Icons.schedule,
                      size: 20,
                      color: expired
                          ? scheme.onErrorContainer
                          : scheme.onPrimaryContainer,
                    ),
                    const SizedBox(width: 7),
                    Text(
                      expired
                          ? 'This code has expired'
                          : 'Expires in $timeText',
                      style: theme.textTheme.titleMedium?.copyWith(
                        color: expired
                            ? scheme.onErrorContainer
                            : scheme.onPrimaryContainer,
                      ),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: expired ? null : onOpenWhatsApp,
              icon: const Icon(Icons.chat_outlined),
              label: const Text('Open WhatsApp'),
            ),
            const SizedBox(height: 8),
            TextButton.icon(
              onPressed: onStartOver,
              icon: const Icon(Icons.refresh),
              label: const Text('Start over and clear local files'),
            ),
          ],
        ),
      ),
    );
  }
}

/// Shows the current delivery method in step 2, with a way to change it.
class _DeliveryRow extends StatelessWidget {
  const _DeliveryRow({
    required this.settings,
    required this.enabled,
    required this.onChange,
  });

  final SelfHostSettings settings;
  final bool enabled;
  final VoidCallback onChange;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final mode = settings.mode;
    final needsLink = mode.isSelfHost && settings.linkedNumber == null;
    final detail = !mode.isSelfHost
        ? 'Clips upload securely; a StatusDrop number sends them.'
        : needsLink
        ? 'No number linked yet. Tap Change to link one.'
        : 'Sent from +${settings.linkedNumber} on this phone.';
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 10, 6, 10),
      decoration: BoxDecoration(
        color: needsLink ? scheme.errorContainer : scheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(
          color: needsLink ? scheme.error : scheme.outlineVariant,
        ),
      ),
      child: Row(
        children: [
          Icon(
            mode.isSelfHost
                ? Icons.phone_android_outlined
                : Icons.cloud_outlined,
            color: needsLink
                ? scheme.onErrorContainer
                : scheme.onSurfaceVariant,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Delivery: ${mode.label}',
                  style: theme.textTheme.titleSmall?.copyWith(
                    fontWeight: FontWeight.w700,
                    color: needsLink ? scheme.onErrorContainer : null,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  detail,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: needsLink
                        ? scheme.onErrorContainer
                        : scheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
          TextButton(
            onPressed: enabled ? onChange : null,
            child: const Text('Change'),
          ),
        ],
      ),
    );
  }
}

/// Result panel after a self-host delivery finished.
class _SelfHostSentPanel extends StatelessWidget {
  const _SelfHostSentPanel({
    super.key,
    required this.outcome,
    required this.onOpenWhatsApp,
    required this.onStartOver,
  });

  final _SelfHostOutcome outcome;
  final VoidCallback onOpenWhatsApp;
  final VoidCallback onStartOver;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final count = outcome.clipCount;
    final clips = '$count ${count == 1 ? 'clip' : 'clips'}';
    final number = outcome.number == null ? '' : ' +${outcome.number}';
    final detail = outcome.ownChat
        ? '$clips are in your "Message yourself" chat in WhatsApp$number.'
        : 'Your bot$number sent $clips to the WhatsApp you messaged it from.';
    return Card(
      color: scheme.primaryContainer,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(24),
        side: BorderSide(color: scheme.primary, width: 1.5),
      ),
      child: Padding(
        padding: const EdgeInsets.all(22),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Container(
                  width: 48,
                  height: 48,
                  decoration: BoxDecoration(
                    color: scheme.primary,
                    borderRadius: BorderRadius.circular(15),
                  ),
                  child: Icon(Icons.done_all, color: scheme.onPrimary),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Semantics(
                    header: true,
                    child: Text(
                      'Sent to WhatsApp',
                      style: theme.textTheme.titleLarge?.copyWith(
                        color: scheme.onPrimaryContainer,
                      ),
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 14),
            Semantics(
              liveRegion: true,
              child: Text(
                detail,
                style: theme.textTheme.bodyLarge?.copyWith(
                  color: scheme.onPrimaryContainer,
                ),
              ),
            ),
            const SizedBox(height: 14),
            const _SaveThenShareNote(),
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: outcome.number == null ? null : onOpenWhatsApp,
              icon: const Icon(Icons.chat_outlined),
              label: const Text('Open WhatsApp'),
            ),
            const SizedBox(height: 8),
            TextButton.icon(
              onPressed: onStartOver,
              icon: const Icon(Icons.refresh),
              label: const Text('Start over and clear local files'),
            ),
          ],
        ),
      ),
    );
  }
}

/// Clips that arrive in a chat must be saved and sent again before they go
/// to Status. Forwarding the received copy makes WhatsApp compress it again.
class _SaveThenShareNote extends StatelessWidget {
  const _SaveThenShareNote();

  static const _steps = [
    'Open each clip and tap Download.',
    'In any chat, attach it from Gallery, add your caption and send.',
    'Forward that new copy to My Status.',
  ];

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final body = theme.textTheme.bodyMedium?.copyWith(
      color: scheme.onSurface,
      height: 1.35,
    );
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: scheme.surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: scheme.tertiary, width: 1.5),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.save_alt_rounded, color: scheme.tertiary, size: 22),
              const SizedBox(width: 10),
              Expanded(
                child: Semantics(
                  header: true,
                  child: Text(
                    'Save it first, then share',
                    style: theme.textTheme.titleSmall?.copyWith(
                      color: scheme.onSurface,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            'Don\'t forward the copy in that chat straight to Status. WhatsApp compresses it again. For full HD:',
            style: body,
          ),
          const SizedBox(height: 8),
          for (var index = 0; index < _steps.length; index++)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: 22,
                    child: Text(
                      '${index + 1}.',
                      style: body?.copyWith(fontWeight: FontWeight.w800),
                    ),
                  ),
                  Expanded(child: Text(_steps[index], style: body)),
                ],
              ),
            ),
          const SizedBox(height: 8),
          Text(
            'The guide below shows each step.',
            style: theme.textTheme.bodySmall?.copyWith(
              color: scheme.onSurfaceVariant,
            ),
          ),
        ],
      ),
    );
  }
}

enum _AppMenuAction { delivery, rate, about }

class _AboutSheet extends StatelessWidget {
  const _AboutSheet({required this.onOpenLink});

  static final _discordUri = Uri.parse('https://discord.gg/aT4TNMQEK8');
  static final _instagramUri = Uri.parse('https://ig.me/m/xd.sapphire');
  static final _emailUri = Uri.parse('mailto:shamanthnadumane@gmail.com');
  static final _privacyUri = Uri.parse(
    'https://www.wastatusvideo.com/privacy.html',
  );
  static final _sourceUri = Uri.parse(
    'https://github.com/Shamanthnp1/WAstatus/tree/main/mobile/statusdrop_app',
  );

  final Future<void> Function(Uri uri) onOpenLink;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 4, 20, 28),
      children: [
        Row(
          children: [
            ClipRRect(
              borderRadius: BorderRadius.circular(18),
              child: Image.asset(
                'assets/images/statusdrop_logo.png',
                width: 68,
                height: 68,
                fit: BoxFit.cover,
                excludeFromSemantics: true,
              ),
            ),
            const SizedBox(width: 16),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Semantics(
                    header: true,
                    child: Text(
                      'About StatusDrop',
                      style: theme.textTheme.titleLarge,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    '${Edition.current.hasSelfHost ? 'MAX version' : 'Version'} $appVersionName · Open-source Android client',
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 20),
        Text(
          'StatusDrop prepares WhatsApp Status clips on your phone, then securely delivers only the finished files you create.',
          style: theme.textTheme.bodyLarge,
        ),
        const SizedBox(height: 16),
        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: scheme.secondaryContainer,
            borderRadius: BorderRadius.circular(18),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(Icons.shield_outlined, color: scheme.onSecondaryContainer),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  'No login, advertising SDK, analytics SDK, or broad storage permission. Original videos remain on this device.',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: scheme.onSecondaryContainer,
                    height: 1.4,
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 24),
        Semantics(
          header: true,
          child: Text('Contact & support', style: theme.textTheme.titleLarge),
        ),
        const SizedBox(height: 10),
        _SupportLinkTile(
          icon: Icons.forum_outlined,
          title: 'Discord community',
          subtitle: 'Get help, report bugs and hear about new versions',
          semanticLabel:
              'Join the StatusDrop Discord community. Opens an external app.',
          onTap: () => unawaited(onOpenLink(_discordUri)),
        ),
        const SizedBox(height: 10),
        _SupportLinkTile(
          icon: Icons.camera_alt_outlined,
          title: 'Instagram',
          subtitle: '@xd.sapphire · Send feedback or report an issue',
          semanticLabel:
              'Contact on Instagram at xd dot sapphire. Opens an external app.',
          onTap: () => unawaited(onOpenLink(_instagramUri)),
        ),
        const SizedBox(height: 10),
        _SupportLinkTile(
          icon: Icons.mail_outline,
          title: 'Email',
          subtitle: 'shamanthnadumane@gmail.com',
          semanticLabel:
              'Email shamanthnadumane at gmail dot com. Opens your email app.',
          onTap: () => unawaited(onOpenLink(_emailUri)),
        ),
        const SizedBox(height: 24),
        Semantics(
          header: true,
          child: Text('Privacy & legal', style: theme.textTheme.titleLarge),
        ),
        const SizedBox(height: 10),
        _SupportLinkTile(
          icon: Icons.privacy_tip_outlined,
          title: 'Privacy Policy',
          subtitle:
              'How local files, finished clips, and delivery data are handled',
          semanticLabel:
              'Open the StatusDrop Privacy Policy in an external browser.',
          onTap: () => unawaited(onOpenLink(_privacyUri)),
        ),
        const SizedBox(height: 10),
        _SupportLinkTile(
          icon: Icons.code,
          title: 'Source code & licenses',
          subtitle: 'GPL Android client, FFmpegKit, FFmpeg, and x264 notices',
          semanticLabel:
              'Open the StatusDrop Android client source code and license information.',
          onTap: () => unawaited(onOpenLink(_sourceUri)),
        ),
        const SizedBox(height: 14),
        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: scheme.tertiaryContainer,
            borderRadius: BorderRadius.circular(18),
          ),
          child: Text(
            'StatusDrop is an independent app and is not affiliated with, endorsed by, or sponsored by WhatsApp LLC or Meta Platforms, Inc. WhatsApp is a trademark of WhatsApp LLC.',
            style: theme.textTheme.bodySmall?.copyWith(
              color: scheme.onTertiaryContainer,
              height: 1.4,
            ),
          ),
        ),
        const SizedBox(height: 12),
        Text(
          Edition.current.hasSelfHost
              ? 'With the StatusDrop number, StatusDrop does not ask you to enter a phone number. Delivery begins only after you open WhatsApp and send the activation message. The self-host methods ask for the number you link, and that login stays only on this phone.'
              : 'StatusDrop does not ask you to enter a phone number. Delivery begins only after you open WhatsApp and send the activation message.',
          style: theme.textTheme.bodySmall?.copyWith(
            color: scheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: 22),
        OutlinedButton.icon(
          onPressed: () => Navigator.of(context).pop(),
          icon: const Icon(Icons.close),
          label: const Text('Close'),
        ),
      ],
    );
  }
}

class _SupportLinkTile extends StatelessWidget {
  const _SupportLinkTile({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.semanticLabel,
    required this.onTap,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final String semanticLabel;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Semantics(
      button: true,
      label: semanticLabel,
      child: ExcludeSemantics(
        child: Material(
          color: scheme.surfaceContainerLow,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(18),
            side: BorderSide(color: scheme.outlineVariant),
          ),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onTap,
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Row(
                children: [
                  Container(
                    width: 46,
                    height: 46,
                    decoration: BoxDecoration(
                      color: scheme.primaryContainer,
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: Icon(icon, color: scheme.onPrimaryContainer),
                  ),
                  const SizedBox(width: 13),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(title, style: theme.textTheme.titleMedium),
                        const SizedBox(height: 2),
                        Text(
                          subtitle,
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: scheme.onSurfaceVariant,
                          ),
                        ),
                      ],
                    ),
                  ),
                  Icon(Icons.open_in_new, color: scheme.onSurfaceVariant),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
