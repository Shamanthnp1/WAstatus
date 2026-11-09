import 'package:flutter/services.dart' show appFlavor;

/// Which build this is. Set by `--flavor` (see android/app/build.gradle.kts).
enum Edition {
  /// The Google Play build: delivery through the StatusDrop number only.
  global,

  /// Sideloaded from the website: adds self-host delivery from the user's own
  /// WhatsApp number.
  max;

  bool get hasSelfHost => this == Edition.max;

  /// The current build. Tests may replace it.
  static Edition current = appFlavor == 'max' ? Edition.max : Edition.global;
}

/// Shown in the app. Keep in step with `version:` in pubspec.yaml.
const appVersionName = '1.1.0';

/// "StatusDrop" or "StatusDrop MAX".
String get appDisplayName =>
    Edition.current.hasSelfHost ? 'StatusDrop MAX' : 'StatusDrop';

/// Where the MAX edition is explained and downloaded. The Play build links
/// only to this page, never straight to an APK.
final Uri maxEditionPage = Uri.parse('https://wastatusvideo.com/max');
