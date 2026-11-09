# StatusDrop Android source and reproducible build

The StatusDrop Android client is free software distributed under the GNU General Public License version 3 or later.

## Corresponding source

Public source location:

https://github.com/Shamanthnp1/WAstatus/tree/main/mobile/statusdrop_app

The source tree contains:

- Flutter/Dart user interface and network client
- Kotlin Android picker/channel integration
- Local FFmpegKit/x264 processing commands
- Gradle configuration and dependency versions
- Brand and tutorial asset generators
- Tests and release documentation

Release keystores, signing passwords, backend credentials, Baileys credentials, user media, generated build output, and local SDK paths are intentionally excluded. They are not required to inspect or modify the client source. A developer must provide their own signing key to create an independently signed build.

## Toolchain

The beta was developed with:

- Flutter 3.38.1 / Dart 3.10
- Android SDK / target API 36
- JDK 21
- ARM64 Android 10+ test device

## Build

From `mobile/statusdrop_app`:

StatusDrop has two editions, built from the same source as Android product flavors:

| Flavor | Application ID | Name | Distributed |
|---|---|---|---|
| `global` | `com.wastatusvideo.statusdrop` | StatusDrop | Google Play |
| `max` | `com.wastatusvideo.statusdrop.max` | StatusDrop MAX | APK on GitHub releases, linked from wastatusvideo.com/max |

MAX adds self-host delivery (the user's own WhatsApp number). Everything for it lives in `android/app/src/max/` and the `max`-only assets in `pubspec.yaml`, so the global build contains no Node runtime, bot, foreground service or self-host code.

```powershell
flutter pub get
flutter analyze
flutter test --no-pub
flutter build appbundle --release --flavor global
flutter build apk --release --flavor max --target-platform android-arm64
```

A release build requires an ignored `android/key.properties` file and a developer-owned upload keystore. Debug builds can be produced without release credentials:

```powershell
flutter build apk --debug --flavor global --target-platform android-arm64
flutter build apk --debug --flavor max --target-platform android-arm64
```

## Self-host delivery build inputs (MAX only)

MAX builds also need Node.js and npm on the build machine (Node 20 or newer). Gradle prepares two gitignored inputs before every MAX build:

- `fetchLibNode` downloads nodejs-mobile v18.20.4, checks its pinned SHA-256, and extracts `libnode.so` and its headers into `android/app/libnode/`.
- `buildSelfHostBundle` runs `npm ci` and `npm run bundle` in `selfhost/`, writing the bot bundle and its license file to `android/app/src/max/assets/selfhost/`.

The bot's source is `selfhost/src/`. The JNI shim that starts Node is `android/app/src/max/cpp/node_runner.cpp`.

Debug builds add `.dev` to the application ID and " Dev" to the name ("StatusDrop Dev", "StatusDrop MAX Dev"), so they install next to the released apps.

## Native corresponding source

StatusDrop consumes the exact Maven artifact `dev.ffmpegkit-maintained:ffmpeg-kit-full-gpl:8.1.7`. FFmpegKit/FFmpeg/x264 source locations and license references are listed in `THIRD_PARTY_NOTICES.md`.

Anyone distributing a modified binary is responsible for publishing the corresponding modified source and complying with all applicable licenses.
