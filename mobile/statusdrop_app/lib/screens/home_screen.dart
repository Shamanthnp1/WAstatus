import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models/native_video_event.dart';
import '../models/processed_clip.dart';
import '../models/quality_profile.dart';
import '../models/video_source.dart';
import '../services/mobile_api.dart';
import '../services/native_video_service.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, this.videoService, this.mobileApi});

  final NativeVideoService? videoService;
  final MobileApi? mobileApi;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  static const maxFiles = 3;
  static const maxBytes = 300 * 1024 * 1024;

  late final NativeVideoService _videoService;
  late final MobileApi _mobileApi;
  late final bool _ownsMobileApi;
  StreamSubscription<NativeVideoEvent>? _eventSubscription;
  Timer? _countdownTimer;

  final List<VideoSource> _videos = [];
  List<ProcessedClip> _processedClips = const [];
  QualityProfile _profile = QualityProfile.hd29;
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

  int get _currentStep {
    if (_delivery != null || _processedClips.isNotEmpty || _isUploading) {
      return 2;
    }
    if (_videos.isNotEmpty || _isProcessing) return 1;
    return 0;
  }

  String get _stageKey {
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
  }

  @override
  void dispose() {
    _countdownTimer?.cancel();
    _eventSubscription?.cancel();
    if (_ownsMobileApi) _mobileApi.close();
    super.dispose();
  }

  Future<void> _pickVideos() async {
    if (_isBusy || _delivery != null || _videos.length >= maxFiles) return;
    setState(() {
      _isPicking = true;
      _statusMessage = 'Opening the video picker.';
    });

    try {
      final picked = await _videoService.pickVideos(
        maxFiles: maxFiles - _videos.length,
      );
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
      setState(() {
        _videos.addAll(accepted);
        _processedClips = const [];
        _statusMessage = accepted.isEmpty
            ? 'No videos were added.'
            : '${_videos.length} ${_videos.length == 1 ? 'video' : 'videos'} selected.';
      });
      if (rejected.isNotEmpty) {
        _showMessage(
          'Some videos were not added because the 300 MB total limit would be exceeded.',
        );
      }
    } catch (error) {
      if (!mounted) return;
      setState(() => _statusMessage = 'Could not select videos.');
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
      setState(() {
        _videos.removeWhere((item) => item.id == video.id);
        _processedClips = const [];
        _statusMessage = _videos.isEmpty
            ? 'No videos selected.'
            : '${_videos.length} ${_videos.length == 1 ? 'video' : 'videos'} selected.';
      });
    } catch (error) {
      if (!mounted) return;
      _showMessage(_friendlyError(error));
    }
  }

  Future<void> _clearVideos() async {
    if (_isBusy) return;
    try {
      await _videoService.clearCache();
      _countdownTimer?.cancel();
      if (!mounted) return;
      setState(() {
        _videos.clear();
        _processedClips = const [];
        _delivery = null;
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
    try {
      await _videoService.clearProcessedClips();
      if (!mounted) return;
      setState(() {
        _profile = profile;
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
              '${clips.length} ${clips.length == 1 ? 'clip is' : 'clips are'} ready. Starting secure upload.';
        });
        if (clips.isNotEmpty) {
          await _uploadAndFinalize();
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
              if (action == _AppMenuAction.about) {
                unawaited(_showAbout());
              }
            },
            itemBuilder: (context) => const [
              PopupMenuItem(
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
                    const _PrivacyNote(),
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
                      child: _delivery != null
                          ? _ActivationPanel(
                              key: const ValueKey('activation'),
                              delivery: _delivery!,
                              remaining: _activationRemaining,
                              onCopy: _copyActivationCode,
                              onOpenWhatsApp: _openWhatsApp,
                              onStartOver: _clearVideos,
                            )
                          : Column(
                              key: ValueKey(_stageKey),
                              children: [
                                _TaskPanel(
                                  step: 1,
                                  complete: _videos.isNotEmpty,
                                  title: 'Choose videos',
                                  description:
                                      'Pick up to 3 videos. Originals stay in private app storage.',
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.stretch,
                                    children: [
                                      FilledButton.icon(
                                        onPressed:
                                            _isBusy ||
                                                _videos.length >= maxFiles
                                            ? null
                                            : _pickVideos,
                                        icon: _isPicking
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
                                          _videos.isEmpty
                                              ? 'Choose videos'
                                              : 'Add another video',
                                        ),
                                      ),
                                      const SizedBox(height: 14),
                                      _SelectionMeter(
                                        count: _videos.length,
                                        maxCount: maxFiles,
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
                                    description:
                                        'Choose quality. StatusDrop compresses locally, then continues securely to delivery.',
                                    child: Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.stretch,
                                      children: [
                                        ...QualityProfile.values.map(
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
                                    description:
                                        'Automatic upload needs attention. Your finished clips are still safe on this phone.',
                                    child: _ReadySummary(
                                      clipCount: _processedClips.length,
                                      totalBytes: _processedBytes,
                                      uploading: _isUploading,
                                      onUpload: _isBusy
                                          ? null
                                          : _uploadAndFinalize,
                                    ),
                                  ),
                                ],
                              ],
                            ),
                    ),
                    const SizedBox(height: 24),
                    const _TutorialGuide(),
                    const SizedBox(height: 28),
                    Text(
                      'StatusDrop 1.0.0 · Open-source Android client',
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
    required this.message,
    required this.progress,
    required this.onCancel,
  });

  final bool uploading;
  final String message;
  final double progress;
  final VoidCallback? onCancel;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final percentage = (progress.clamp(0, 1) * 100).round();
    final title = uploading ? 'Sending securely' : 'Compressing on this phone';
    final supportingText = uploading
        ? 'Finished clips are uploading, being verified, and prepared for WhatsApp.'
        : 'Your original video stays on this phone. You can cancel without losing the selection.';

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
                                  uploading
                                      ? Icons.cloud_upload_outlined
                                      : Icons.auto_awesome_outlined,
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
                                    uploading
                                        ? 'Secure upload'
                                        : 'Local processing',
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
  const _PrivacyNote();

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
                  'Original videos never upload. After local compression, only finished clips upload securely.',
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
    required this.bytes,
    required this.maxBytes,
  });

  final int count;
  final int maxCount;
  final int bytes;
  final int maxBytes;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Semantics(
      label:
          '$count of $maxCount videos selected. ${_HomeScreenState.formatSize(bytes)} of 300 megabytes used.',
      child: ExcludeSemantics(
        child: Column(
          children: [
            Row(
              children: [
                Text(
                  '$count/$maxCount videos',
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
            child: Icon(Icons.movie_outlined, color: scheme.onPrimaryContainer),
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
          '${profile.label}. ${profile.description}. ${profile.width} by ${profile.height}.',
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
    required this.onUpload,
  });

  final int clipCount;
  final int totalBytes;
  final bool uploading;
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
          'Only these finished clips upload. They remain available for five minutes after activation.',
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
              : const Icon(Icons.lock_outline),
          label: Text(uploading ? 'Uploading securely' : 'Retry secure upload'),
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
  });

  final DeliveryResult delivery;
  final Duration remaining;
  final VoidCallback onCopy;
  final VoidCallback onOpenWhatsApp;
  final VoidCallback onStartOver;

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

class _TutorialGuide extends StatefulWidget {
  const _TutorialGuide();

  @override
  State<_TutorialGuide> createState() => _TutorialGuideState();
}

class _TutorialGuideState extends State<_TutorialGuide> {
  static const _steps = <_TutorialStep>[
    _TutorialStep(
      asset: 'assets/tutorial/step_01.webp',
      title: 'Activate on WhatsApp',
      description: 'Read the activation instructions and open WhatsApp.',
    ),
    _TutorialStep(
      asset: 'assets/tutorial/step_02.webp',
      title: 'Send the activation message',
      description:
          'Send the prefilled message containing your activation code.',
    ),
    _TutorialStep(
      asset: 'assets/tutorial/step_03.webp',
      title: 'Read the reply and download',
      description: 'Wait for all clips, then download each video to the phone.',
    ),
    _TutorialStep(
      asset: 'assets/tutorial/step_04.webp',
      title: 'Open a chat and Gallery',
      description: 'Open any chat, tap attach, and choose Gallery.',
    ),
    _TutorialStep(
      asset: 'assets/tutorial/step_05.webp',
      title: 'Select the downloaded video',
      description: 'Choose the new StatusDrop clip from Gallery.',
    ),
    _TutorialStep(
      asset: 'assets/tutorial/step_06.webp',
      title: 'Add a caption and send',
      description: 'Add your caption now, then send the video into the chat.',
    ),
    _TutorialStep(
      asset: 'assets/tutorial/step_07.webp',
      title: 'Forward the new video',
      description: 'Use Forward on the newly sent copy—not the original.',
    ),
    _TutorialStep(
      asset: 'assets/tutorial/step_08.webp',
      title: 'Choose My Status',
      description: 'Select My Status and continue to the Status screen.',
    ),
    _TutorialStep(
      asset: 'assets/tutorial/step_09.webp',
      title: 'Post in full HD',
      description: 'Review the final Status and post your HD video.',
    ),
  ];

  late final PageController _controller;
  int _currentIndex = 0;

  @override
  void initState() {
    super.initState();
    _controller = PageController(viewportFraction: 0.92);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _moveTo(int index) async {
    if (index < 0 || index >= _steps.length || !_controller.hasClients) return;
    await _controller.animateToPage(
      index,
      duration: const Duration(milliseconds: 260),
      curve: Curves.easeOutCubic,
    );
  }

  Future<void> _openStep(int index) => Navigator.of(context).push(
    MaterialPageRoute<void>(
      builder: (_) => _TutorialImageViewer(
        step: _steps[index],
        index: index,
        total: _steps.length,
      ),
    ),
  );

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final current = _steps[_currentIndex];

    return Card(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(18, 20, 18, 18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: 48,
                  height: 48,
                  decoration: BoxDecoration(
                    color: scheme.primaryContainer,
                    borderRadius: BorderRadius.circular(15),
                  ),
                  child: Icon(
                    Icons.hd_outlined,
                    color: scheme.onPrimaryContainer,
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
                          'Post in full HD',
                          style: theme.textTheme.titleLarge,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        'Swipe through the WhatsApp flow. Tap a poster to zoom.',
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: scheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 18),
            SizedBox(
              height: 600,
              child: PageView.builder(
                controller: _controller,
                itemCount: _steps.length,
                onPageChanged: (index) => setState(() => _currentIndex = index),
                itemBuilder: (context, index) {
                  final step = _steps[index];
                  return Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 5),
                    child: Semantics(
                      button: true,
                      label:
                          'Step ${index + 1} of ${_steps.length}. ${step.title}. ${step.description} Tap to open full screen.',
                      child: ExcludeSemantics(
                        child: Material(
                          color: scheme.surfaceContainerLow,
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(20),
                            side: BorderSide(color: scheme.outlineVariant),
                          ),
                          clipBehavior: Clip.antiAlias,
                          child: InkWell(
                            onTap: () => _openStep(index),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.stretch,
                              children: [
                                Expanded(
                                  child: Hero(
                                    tag: 'tutorial-step-${index + 1}',
                                    child: ColoredBox(
                                      color: scheme.surfaceContainer,
                                      child: Image.asset(
                                        step.asset,
                                        fit: BoxFit.contain,
                                        filterQuality: FilterQuality.high,
                                      ),
                                    ),
                                  ),
                                ),
                                Padding(
                                  padding: const EdgeInsets.all(16),
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      Text(
                                        step.title,
                                        style: theme.textTheme.titleMedium,
                                      ),
                                      const SizedBox(height: 4),
                                      Text(
                                        step.description,
                                        maxLines: 2,
                                        overflow: TextOverflow.ellipsis,
                                        style: theme.textTheme.bodySmall
                                            ?.copyWith(
                                              color: scheme.onSurfaceVariant,
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
                  );
                },
              ),
            ),
            const SizedBox(height: 14),
            Semantics(
              liveRegion: true,
              label:
                  'Step ${_currentIndex + 1} of ${_steps.length}: ${current.title}',
              child: ExcludeSemantics(
                child: Row(
                  children: [
                    IconButton.filledTonal(
                      onPressed: _currentIndex > 0
                          ? () => _moveTo(_currentIndex - 1)
                          : null,
                      tooltip: 'Previous tutorial step',
                      icon: const Icon(Icons.chevron_left),
                    ),
                    Expanded(
                      child: Column(
                        children: [
                          Text(
                            'Step ${_currentIndex + 1} of ${_steps.length}',
                            style: theme.textTheme.labelLarge,
                          ),
                          const SizedBox(height: 8),
                          Row(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              for (
                                var index = 0;
                                index < _steps.length;
                                index++
                              )
                                AnimatedContainer(
                                  duration: const Duration(milliseconds: 180),
                                  width: index == _currentIndex ? 18 : 7,
                                  height: 7,
                                  margin: const EdgeInsets.symmetric(
                                    horizontal: 3,
                                  ),
                                  decoration: BoxDecoration(
                                    color: index == _currentIndex
                                        ? scheme.primary
                                        : scheme.outlineVariant,
                                    borderRadius: BorderRadius.circular(999),
                                  ),
                                ),
                            ],
                          ),
                        ],
                      ),
                    ),
                    IconButton.filledTonal(
                      onPressed: _currentIndex < _steps.length - 1
                          ? () => _moveTo(_currentIndex + 1)
                          : null,
                      tooltip: 'Next tutorial step',
                      icon: const Icon(Icons.chevron_right),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _TutorialImageViewer extends StatelessWidget {
  const _TutorialImageViewer({
    required this.step,
    required this.index,
    required this.total,
  });

  final _TutorialStep step;
  final int index;
  final int total;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(title: Text('Step ${index + 1} of $total')),
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 12, 20, 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Semantics(
                    header: true,
                    child: Text(
                      step.title,
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    '${step.description} Pinch to zoom and drag to inspect details.',
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
            Expanded(
              child: Semantics(
                image: true,
                label:
                    'Tutorial step ${index + 1} of $total. ${step.title}. ${step.description}',
                child: InteractiveViewer(
                  minScale: 1,
                  maxScale: 5,
                  boundaryMargin: const EdgeInsets.all(48),
                  child: Center(
                    child: Hero(
                      tag: 'tutorial-step-${index + 1}',
                      child: Image.asset(
                        step.asset,
                        fit: BoxFit.contain,
                        filterQuality: FilterQuality.high,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _TutorialStep {
  const _TutorialStep({
    required this.asset,
    required this.title,
    required this.description,
  });

  final String asset;
  final String title;
  final String description;
}

enum _AppMenuAction { about }

class _AboutSheet extends StatelessWidget {
  const _AboutSheet({required this.onOpenLink});

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
                    'Version 1.0.0 · Open-source Android client',
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
          'StatusDrop does not ask you to enter a phone number. Delivery begins only after you open WhatsApp and send the activation message.',
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
