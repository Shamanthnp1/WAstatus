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

```powershell
flutter pub get
flutter analyze
flutter test --no-pub
flutter build appbundle --release
```

A release build requires an ignored `android/key.properties` file and a developer-owned upload keystore. Debug builds can be produced without release credentials:

```powershell
flutter build apk --debug --target-platform android-arm64 --split-per-abi
```

## Native corresponding source

StatusDrop consumes the exact Maven artifact `dev.ffmpegkit-maintained:ffmpeg-kit-full-gpl:8.1.7`. FFmpegKit/FFmpeg/x264 source locations and license references are listed in `THIRD_PARTY_NOTICES.md`.

Anyone distributing a modified binary is responsible for publishing the corresponding modified source and complying with all applicable licenses.
