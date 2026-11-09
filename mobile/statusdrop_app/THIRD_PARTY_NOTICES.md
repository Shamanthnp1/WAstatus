# Third-party notices

StatusDrop Android client is distributed under the GNU General Public License, version 3 or later. The complete client source, build files, and these notices are available at:

https://github.com/Shamanthnp1/WAstatus/tree/main/mobile/statusdrop_app

The Android client includes or depends on the following projects. Copyright remains with their respective authors.

## Flutter and Dart

- Project: Flutter framework and Dart SDK
- License: BSD 3-Clause and component-specific notices
- Source: https://github.com/flutter/flutter
- Notices: https://github.com/flutter/flutter/blob/master/LICENSE

## FFmpegKit maintained fork

- Artifact: `dev.ffmpegkit-maintained:ffmpeg-kit-full-gpl:8.1.7`
- License: GPL-3.0 build
- Source: https://github.com/ffmpegkit-maintained/ffmpeg-kit
- Distribution record: https://central.sonatype.com/artifact/dev.ffmpegkit-maintained/ffmpeg-kit-full-gpl/8.1.7/overview

This is the full GPL build and enables GPL components, including x264. StatusDrop uses its `com.arthenica.ffmpegkit` Java API and bundled native libraries.

## FFmpeg

- Project: FFmpeg
- License: GPL/LGPL depending on enabled components; the bundled StatusDrop build is treated as GPL because GPL components are enabled
- Source: https://ffmpeg.org/download.html
- License information: https://ffmpeg.org/legal.html

## x264

- Project: x264 H.264/AVC encoder
- License: GNU GPL version 2 or later
- Source: https://code.videolan.org/videolan/x264
- License: https://code.videolan.org/videolan/x264/-/blob/master/COPYING

## Smart Exception

- Artifact: `com.arthenica:smart-exception-java:0.2.1`
- Project: Smart Exception
- Source: https://github.com/tanersener/smart-exception

## Node.js for Mobile Apps (self-host delivery)

- Project: nodejs-mobile core library v18.20.4 (`libnode.so`, ARM64), based on Node.js 18.20.4
- License: MIT (Node.js license, including the licenses of Node.js's bundled dependencies such as V8, libuv and OpenSSL)
- Source: https://github.com/nodejs-mobile/nodejs-mobile/tree/v18.20.4
- Download: https://github.com/nodejs-mobile/nodejs-mobile/releases/tag/v18.20.4 (verified by SHA-256 in `android/app/build.gradle.kts`)
- License text: https://github.com/nodejs-mobile/nodejs-mobile/blob/v18.20.4/LICENSE

## Self-host WhatsApp bot (JavaScript)

This section applies to StatusDrop MAX only; the Google Play build does not include the bot or Node.js. The self-host bot in `selfhost/` is bundled with its npm dependencies into `assets/selfhost/bot.mjs`. The build writes the name, version, license and full license text of every bundled package to `assets/selfhost/THIRD_PARTY_LICENSES.txt`, which ships inside the app. The main ones are:

- Baileys (`@whiskeysockets/baileys` 7.0.0-rc13), MIT: https://github.com/WhiskeySockets/Baileys
- libsignal-node (`libsignal` 6.0.0), GPL-3.0: https://github.com/WhiskeySockets/libsignal-node
- whatsapp-rust-bridge 0.5.4, MIT
- protobufjs, BSD-3-Clause; pino, MIT; ws, MIT; music-metadata, MIT

StatusDrop is not affiliated with WhatsApp or Meta. Self-host delivery uses an unofficial WhatsApp Web client.

## QR code rendering

- Package: `qr_flutter` and `qr` (Dart)
- License: BSD 3-Clause
- Source: https://github.com/theyakka/qr.flutter

## Material icons

- Project: Google Material Symbols / Icons as provided by Flutter
- License: Apache License 2.0
- Source: https://fonts.google.com/icons

## No warranty

StatusDrop and the listed GPL components are provided without warranty, to the extent permitted by applicable law. See `LICENSE` for the complete GNU GPL version 3 terms.

This document is an engineering notice, not legal advice. Release owners remain responsible for verifying the exact license texts and corresponding-source obligations of every distributed artifact.
