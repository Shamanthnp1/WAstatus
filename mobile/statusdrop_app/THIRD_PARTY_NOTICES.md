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

## Material icons

- Project: Google Material Symbols / Icons as provided by Flutter
- License: Apache License 2.0
- Source: https://fonts.google.com/icons

## No warranty

StatusDrop and the listed GPL components are provided without warranty, to the extent permitted by applicable law. See `LICENSE` for the complete GNU GPL version 3 terms.

This document is an engineering notice, not legal advice. Release owners remain responsible for verifying the exact license texts and corresponding-source obligations of every distributed artifact.
