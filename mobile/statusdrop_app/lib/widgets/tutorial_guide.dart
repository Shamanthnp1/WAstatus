import 'package:flutter/material.dart';

import '../edition.dart';
import '../models/self_host.dart';

/// One poster in a tutorial.
class TutorialStep {
  const TutorialStep({
    required this.asset,
    required this.title,
    required this.description,
  });

  final String asset;
  final String title;
  final String description;
}

/// The poster sets in assets/tutorial/.
abstract final class TutorialSteps {
  static const _turnOnHd = TutorialStep(
    asset: 'assets/tutorial/setup/setup_01.webp',
    title: 'Turn on HD in WhatsApp',
    description:
        'WhatsApp > Settings > Storage and data. Set Media upload quality and Auto-download quality to HD quality.',
  );

  /// One-time setup, shown before any delivery method. The Play build has
  /// one delivery method, so it has nothing to pick (and does not ship the
  /// second poster, which shows linking your own WhatsApp).
  static List<TutorialStep> get setup => Edition.current.hasSelfHost
      ? const [
          _turnOnHd,
          TutorialStep(
            asset: 'assets/tutorial/setup/setup_02.webp',
            title: 'Pick a delivery method',
            description:
                'Tap the 3-dot menu > Delivery method. Keep the StatusDrop number, or link your own WhatsApp.',
          ),
        ]
      : const [_turnOnHd];

  /// Default flow: a StatusDrop number sends the clips.
  static const statusDrop = <TutorialStep>[
    TutorialStep(
      asset: 'assets/tutorial/step_01.webp',
      title: 'Activate on WhatsApp',
      description: 'Read the activation instructions and open WhatsApp.',
    ),
    TutorialStep(
      asset: 'assets/tutorial/step_02.webp',
      title: 'Send the activation message',
      description:
          'Send the prefilled message containing your activation code.',
    ),
    TutorialStep(
      asset: 'assets/tutorial/step_03.webp',
      title: 'Read the reply and download',
      description: 'Wait for all clips, then download each video to the phone.',
    ),
    TutorialStep(
      asset: 'assets/tutorial/step_04.webp',
      title: 'Open a chat and Gallery',
      description: 'Open any chat, tap attach, and choose Gallery.',
    ),
    TutorialStep(
      asset: 'assets/tutorial/step_05.webp',
      title: 'Select the downloaded video',
      description: 'Choose the new StatusDrop clip from Gallery.',
    ),
    TutorialStep(
      asset: 'assets/tutorial/step_06.webp',
      title: 'Add a caption and send',
      description: 'Add your caption now, then send the video into the chat.',
    ),
    TutorialStep(
      asset: 'assets/tutorial/step_07.webp',
      title: 'Forward the new video',
      description: 'Use Forward on the newly sent copy—not the original.',
    ),
    TutorialStep(
      asset: 'assets/tutorial/step_08.webp',
      title: 'Choose My Status',
      description: 'Select My Status and continue to the Status screen.',
    ),
    TutorialStep(
      asset: 'assets/tutorial/step_09.webp',
      title: 'Post in full HD',
      description: 'Review the final Status and post your HD video.',
    ),
  ];

  /// Self-host method 1, steps 1-7, then [_sharedTail].
  static const ownNumber = <TutorialStep>[
    TutorialStep(
      asset: 'assets/tutorial/own/step_01.webp',
      title: 'Choose Message yourself',
      description:
          'Pick My WhatsApp, type your number with country code, and tap Get a linking code.',
    ),
    TutorialStep(
      asset: 'assets/tutorial/own/step_02.webp',
      title: 'Copy the linking code',
      description:
          'Tap Copy code before the timer runs out, then open WhatsApp on this phone.',
    ),
    TutorialStep(
      asset: 'assets/tutorial/own/step_03.webp',
      title: 'Paste it in WhatsApp',
      description:
          'Tap the WhatsApp notification, or go to Linked devices > Link a device > Link with phone number instead.',
    ),
    TutorialStep(
      asset: 'assets/tutorial/own/step_04.webp',
      title: 'Linked! Now go back',
      description: 'Tap back, then compress your videos as usual.',
    ),
    TutorialStep(
      asset: 'assets/tutorial/own/step_05.webp',
      title: 'Open WhatsApp',
      description:
          'When sending finishes, tap Open WhatsApp. Your clips are in your "Message yourself" chat.',
    ),
    TutorialStep(
      asset: 'assets/tutorial/own/step_06.webp',
      title: 'Open your video',
      description:
          'Do not forward this copy to Status. WhatsApp would compress it again.',
    ),
    TutorialStep(
      asset: 'assets/tutorial/own/step_07.webp',
      title: 'Tap Download',
      description:
          'Save the full-quality copy to Gallery. Next, send it again from Gallery.',
    ),
    ..._sharedTail,
  ];

  /// Self-host method 2, steps 1-7, then [_sharedTail].
  static const secondNumber = <TutorialStep>[
    TutorialStep(
      asset: 'assets/tutorial/bot/step_01.webp',
      title: 'Choose the bot option',
      description:
          'Pick My second number as a bot, type the bot number with country code, and tap Get a linking code.',
    ),
    TutorialStep(
      asset: 'assets/tutorial/bot/step_02.webp',
      title: 'Copy the linking code',
      description:
          'Tap Copy code before the timer runs out, then open WhatsApp on your bot number.',
    ),
    TutorialStep(
      asset: 'assets/tutorial/bot/step_03.webp',
      title: 'Paste it for your bot',
      description:
          'In WhatsApp on the second number: Linked devices > Link a device > Link with phone number instead.',
    ),
    TutorialStep(
      asset: 'assets/tutorial/bot/step_04.webp',
      title: 'Bot linked! Now go back',
      description: 'Tap back, then compress your videos as usual.',
    ),
    TutorialStep(
      asset: 'assets/tutorial/bot/step_05.webp',
      title: 'Open WhatsApp',
      description:
          'After compressing, tap Open WhatsApp. Your bot chat opens with the code filled in.',
    ),
    TutorialStep(
      asset: 'assets/tutorial/bot/step_06.webp',
      title: 'Send the code',
      description: 'Send the prefilled message from your main WhatsApp.',
    ),
    TutorialStep(
      asset: 'assets/tutorial/bot/step_07.webp',
      title: 'Read and download',
      description:
          'Your bot replies with instructions and your clips. Download each clip.',
    ),
    ..._sharedTail,
  ];

  /// Steps 8-13: post a downloaded clip to Status without losing quality.
  static const _sharedTail = <TutorialStep>[
    TutorialStep(
      asset: 'assets/tutorial/shared/step_08.webp',
      title: 'Open a chat and Gallery',
      description:
          'Open any chat (Message yourself works), tap attach, and choose Gallery.',
    ),
    TutorialStep(
      asset: 'assets/tutorial/shared/step_09.webp',
      title: 'Select your video',
      description: 'Choose the clip you just downloaded.',
    ),
    TutorialStep(
      asset: 'assets/tutorial/shared/step_10.webp',
      title: 'Add a caption and send',
      description: 'Add your caption now, then send the video into the chat.',
    ),
    TutorialStep(
      asset: 'assets/tutorial/shared/step_11.webp',
      title: 'Forward the new video',
      description: 'Forward the copy you just sent, not the original.',
    ),
    TutorialStep(
      asset: 'assets/tutorial/shared/step_12.webp',
      title: 'Choose My status and send',
      description: 'Select My status, then send.',
    ),
    TutorialStep(
      asset: 'assets/tutorial/shared/step_13.webp',
      title: 'Done! Status posted',
      description: 'Your Status is posted in full HD.',
    ),
  ];

  static List<TutorialStep> forMode(DeliveryMode mode) => switch (mode) {
    DeliveryMode.statusDrop => statusDrop,
    DeliveryMode.ownNumber => ownNumber,
    DeliveryMode.secondNumber => secondNumber,
  };

  /// The guide subtitle for [mode].
  static String hintFor(DeliveryMode mode) => switch (mode) {
    DeliveryMode.statusDrop =>
      'Swipe through the WhatsApp flow. Tap a poster to zoom.',
    DeliveryMode.ownNumber =>
      'Swipe through the Message yourself flow. Tap a poster to zoom.',
    DeliveryMode.secondNumber =>
      'Swipe through the bot flow. Tap a poster to zoom.',
  };
}

Future<void> openTutorialStep(
  BuildContext context, {
  required List<TutorialStep> steps,
  required int index,
  required String heroScope,
  String unit = 'Step',
}) => Navigator.of(context).push(
  MaterialPageRoute<void>(
    builder: (_) => _TutorialImageViewer(
      step: steps[index],
      index: index,
      total: steps.length,
      unit: unit,
      heroTag: _heroTag(heroScope, steps[index]),
    ),
  ),
);

String _heroTag(String scope, TutorialStep step) => '$scope:${step.asset}';

/// A swipeable poster guide. Give it a new key when [steps] changes, so the
/// page position starts over.
class TutorialGuide extends StatefulWidget {
  const TutorialGuide({
    super.key,
    required this.steps,
    required this.heroScope,
    this.title = 'Post in full HD',
    this.hint = 'Swipe through the WhatsApp flow. Tap a poster to zoom.',
    this.icon = Icons.hd_outlined,
  });

  final List<TutorialStep> steps;

  /// Keeps hero tags unique when two routes show the same posters.
  final String heroScope;
  final String title;
  final String hint;
  final IconData icon;

  @override
  State<TutorialGuide> createState() => _TutorialGuideState();
}

class _TutorialGuideState extends State<TutorialGuide> {
  late final PageController _controller;
  int _currentIndex = 0;

  List<TutorialStep> get _steps => widget.steps;

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
                  child: Icon(widget.icon, color: scheme.onPrimaryContainer),
                ),
                const SizedBox(width: 13),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Semantics(
                        header: true,
                        child: Text(
                          widget.title,
                          style: theme.textTheme.titleLarge,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        widget.hint,
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
                            onTap: () => openTutorialStep(
                              context,
                              steps: _steps,
                              index: index,
                              heroScope: widget.heroScope,
                            ),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.stretch,
                              children: [
                                Expanded(
                                  child: Hero(
                                    tag: _heroTag(widget.heroScope, step),
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
                          // 13 dots fit a 320 dp phone; wrap keeps them
                          // from overflowing on anything narrower.
                          Wrap(
                            alignment: WrapAlignment.center,
                            runSpacing: 6,
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

/// "Before you start": the one-time setup posters. Starts collapsed to one
/// row so step 1 of the home screen stays on the first screen.
class SetupGuideCard extends StatelessWidget {
  const SetupGuideCard({super.key});

  static const _heroScope = 'setup';

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final steps = TutorialSteps.setup;
    return Card(
      clipBehavior: Clip.antiAlias,
      child: ExpansionTile(
        shape: const Border(),
        collapsedShape: const Border(),
        tilePadding: const EdgeInsets.fromLTRB(16, 6, 12, 6),
        childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        leading: Icon(Icons.checklist_rounded, color: scheme.primary),
        title: Text('Before you start', style: theme.textTheme.titleMedium),
        subtitle: Text(
          steps.length > 1
              ? 'Turn on HD in WhatsApp and pick a delivery method. One time only.'
              : 'Turn on HD in WhatsApp. One time only.',
          style: theme.textTheme.bodySmall?.copyWith(
            color: scheme.onSurfaceVariant,
          ),
        ),
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (var index = 0; index < steps.length; index++) ...[
                if (index > 0) const SizedBox(width: 10),
                Expanded(
                  child: _SetupTile(
                    step: steps[index],
                    number: index + 1,
                    total: steps.length,
                    heroTag: _heroTag(_heroScope, steps[index]),
                    onTap: () => openTutorialStep(
                      context,
                      steps: steps,
                      index: index,
                      heroScope: _heroScope,
                      unit: 'Setup',
                    ),
                  ),
                ),
              ],
            ],
          ),
          const SizedBox(height: 10),
          Text(
            'Tap a poster to zoom.',
            style: theme.textTheme.bodySmall?.copyWith(
              color: scheme.onSurfaceVariant,
            ),
          ),
        ],
      ),
    );
  }
}

class _SetupTile extends StatelessWidget {
  const _SetupTile({
    required this.step,
    required this.number,
    required this.total,
    required this.heroTag,
    required this.onTap,
  });

  final TutorialStep step;
  final int number;
  final int total;
  final String heroTag;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Semantics(
      button: true,
      label:
          'Setup $number of $total. ${step.title}. ${step.description} Tap to open full screen.',
      child: ExcludeSemantics(
        child: Material(
          color: scheme.surfaceContainerLow,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(16),
            side: BorderSide(color: scheme.outlineVariant),
          ),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onTap,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                // The top of the poster: its title and the start of the
                // screenshot. The full poster opens on tap.
                SizedBox(
                  height: 150,
                  child: Hero(
                    tag: heroTag,
                    child: Image.asset(
                      step.asset,
                      fit: BoxFit.cover,
                      alignment: Alignment.topCenter,
                      filterQuality: FilterQuality.medium,
                    ),
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
                  child: Text(
                    '$number. ${step.title}',
                    style: theme.textTheme.labelLarge,
                  ),
                ),
              ],
            ),
          ),
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
    required this.unit,
    required this.heroTag,
  });

  final TutorialStep step;
  final int index;
  final int total;
  final String unit;
  final String heroTag;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(title: Text('$unit ${index + 1} of $total')),
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
                    '$unit ${index + 1} of $total. ${step.title}. ${step.description}',
                child: InteractiveViewer(
                  minScale: 1,
                  maxScale: 5,
                  boundaryMargin: const EdgeInsets.all(48),
                  child: Center(
                    child: Hero(
                      tag: heroTag,
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
