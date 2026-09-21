# StatusDrop Android beta — physical phone test guide

Use this checklist before sharing the APK publicly. The implementation workspace had no connected Android device, so every item marked **physical** is still required.

## 1. Test prerequisites

- ARM64 phone running Android 10 or newer.
- Current WhatsApp installed and logged in.
- At least 2 GiB free storage and more than 30% battery.
- Stable Wi-Fi plus a second pass on mobile data.
- StatusDrop backend deployed with the new `/api/mobile/*` routes.
- R2 environment variables configured.
- Baileys linked and `GET /api/health` reporting `"baileys":"connected"`.
- APK and checksum from the same build.
- Test media:
  1. portrait MP4 with audio, 10–20 seconds;
  2. landscape MP4 with audio, 35–70 seconds;
  3. MP4 without audio;
  4. a video large enough to observe processing and cancellation;
  5. optional unsupported/corrupt file for error handling.

Use non-sensitive test videos. Do not use personal media during the beta validation pass.

## 2. Verify and install the APK

On the development computer:

```powershell
Get-FileHash .\build\app\outputs\flutter-apk\app-arm64-v8a-debug.apk -Algorithm SHA256
```

Compare it with `APK_CHECKSUMS.txt`. If the phone has ADB enabled:

```powershell
adb install -r .\build\app\outputs\flutter-apk\app-arm64-v8a-debug.apk
```

Without ADB:

1. Transfer `app-arm64-v8a-debug.apk` to the phone.
2. Open it from Files/Downloads.
3. Android may ask to allow installs from that file-manager/browser. Enable it only for this test.
4. Android/Play Protect may warn that the debug-signed sideloaded app is unknown. Confirm only when the checksum matches and the APK came directly from this build.
5. Disable “install unknown apps” for that source after installation if desired.

Expected package: `com.wastatusvideo.statusdrop`.

> The beta uses a debug certificate. A future production-signed APK will require uninstalling this beta first.

## 3. Launch and basic UI — physical

1. Open **StatusDrop**.
2. Confirm the StatusDrop icon and app name are shown.
3. Confirm there is no login, account, notification prompt, storage permission prompt, or advertising prompt.
4. Rotate the phone and change system text size to 200%; confirm controls remain usable and text is not clipped.
5. Enable dark mode; confirm text and controls remain readable.

Expected first status: **Choose videos to begin.**

## 4. TalkBack accessibility — physical

1. Enable Android TalkBack.
2. Swipe through the screen from the title to the footer.
3. Confirm headings, privacy explanation, picker button, video cards, quality cards, progress, cancel action, upload action, activation code, countdown, copy action, WhatsApp action, and Start over action have understandable names.
4. Confirm quality selection announces selected/not selected.
5. During processing and upload, confirm status/progress changes are announced without trapping focus.
6. At 200% font size, confirm every action remains reachable.

Pass criteria: no unlabeled actionable icon, no inaccessible control, no focus trap, and no information available only by color.

## 5. Picker and limits — physical

1. Tap **Choose videos**.
2. Confirm the Android system document/photo picker opens.
3. Select one valid video.
4. Confirm filename, size, duration, and resolution appear.
5. Add videos until 3 are selected; confirm **Add more videos** disables.
6. Attempt a selection that would exceed 300 MiB total; confirm it is rejected and its private cache copy is removed.
7. Remove one video; confirm old processed results disappear if they existed.
8. Tap **Clear all**; confirm the screen resets.

Pass criteria: no broad photo/storage permission is requested, no more than 3 files are retained, and rejected/removed copies are not left in app cache.

## 6. 1080p / 29-second processing — physical

1. Select the portrait test video.
2. Keep **1080p HD** selected.
3. Tap **Compress on this phone**.
4. Confirm progress increases and stays below 100% until a clip is accepted.
5. Confirm the finished count appears and **Upload finished clips** is enabled.

For a source longer than 29 seconds, confirm contiguous parts are created and no part exceeds approximately 29.75 seconds or 15,800,000 bytes.

Expected media profile after server validation: H.264, yuv420p, 1080×1920, at most 30 fps, optional AAC.

## 7. 720p / 59-second processing — physical

1. Clear the job and select the landscape video.
2. Choose **720p longer clips**.
3. Process it.
4. Confirm the full landscape frame is visible with padding; it must not be stretched or cropped destructively.
5. Confirm parts are contiguous and no part exceeds approximately 59.75 seconds or 15,800,000 bytes.

Expected profile: H.264, yuv420p, 720×1280, at most 30 fps, optional AAC.

## 8. Silent input — physical

1. Process the no-audio MP4 in both profiles.
2. Confirm processing succeeds and the server accepts the optional-audio result.
3. Confirm WhatsApp can play the received clip.

Pass criteria: absence of audio is not treated as an encoding or upload failure.

## 9. Cancellation and retry — physical

1. Start processing the larger test video.
2. Tap **Cancel processing** after progress begins.
3. Confirm a cancelled status appears and incomplete generated clips are removed.
4. Confirm selected source videos remain available.
5. Tap **Compress on this phone** again and let it finish.

Pass criteria: cancellation is prompt, produces no completion event, and retry does not require picking the source again.

## 10. Secure upload and activation — physical/end-to-end

1. When local compression finishes, confirm secure upload starts automatically without another button press.
2. Confirm upload progress is monotonic in the centered progress panel and editing controls are blocked.
3. Confirm an activation code appears only after all clips have been uploaded and server-validated.
4. Confirm the displayed file count matches the generated count.
5. Confirm the countdown starts from the authoritative server expiry and decreases every second.
6. Tap copy and paste the code into a note; confirm all 9 characters match.
7. Tap **Open WhatsApp**.
8. Confirm only `https://wa.me/...` is opened and the message is prefilled.
9. Send the message to the configured StatusDrop number.
10. Confirm Baileys returns every clip exactly once and in numeric order.
11. Download one received clip and inspect playback, framing, audio, duration, and file size.

Pass criteria: original source files are never uploaded; server logs show validation/sealing, not server compression; generated local clips are cleared after successful finalize; selected originals remain until Start over.

## 11. Five-minute expiry — physical/end-to-end

1. Produce and upload a short clip.
2. Do not open WhatsApp.
3. Wait until the displayed timer reaches `00:00`.
4. Confirm **Open WhatsApp** disables and the expired message is announced.
5. Send the expired code manually; confirm it is rejected.
6. Confirm server/R2 cleanup removes sealed files.

## 12. Failure and recovery tests — physical

### Offline during upload

1. Start upload, then disable network.
2. Confirm bounded retries occur and the UI eventually reports failure.
3. Confirm finished local clips are retained.
4. Restore network and tap upload again.

### Server unavailable

1. Stop or block the API.
2. Attempt upload.
3. Confirm a readable error and no lost local clips.

### Baileys unavailable

1. Check `/api/health` while Baileys is disconnected.
2. Do not distribute a production test code until Baileys is connected.
3. If delivery fails temporarily after activation, resend the same code within the renewed five-minute retry window.

### App backgrounding

1. Background the app during local processing for 30–60 seconds and return.
2. Repeat during upload.
3. Confirm no duplicate job, duplicate clip, or frozen terminal state.

Android may kill a backgrounded beta process under memory pressure; record the phone model and battery-optimization settings if this occurs.

## 13. Cache and privacy — physical/ADB

1. Complete a job, then tap **Start over and clear local files**.
2. Confirm the UI returns to the initial state.
3. Using Android Settings, clear app storage and relaunch; confirm no job returns.
4. If ADB is available, inspect app-private cache only on a debuggable build and confirm `selected/` and `processed/` are removed after clear.
5. Confirm app data is not included in backup (`allowBackup=false`).

## 14. Server checks

During an end-to-end run, confirm:

- Create returns a random session id and bearer capability.
- Invalid/missing bearer token receives 401.
- Wrong byte count/hash receives 4xx and no activation code.
- Unsupported codec/profile receives 422.
- Upload slots are numbered exactly `1..N`.
- Finalize is idempotent and repeats the same activation result.
- R2 keys use `mobile-sealed/<session>/...`, never a client filename.
- Idle upload sessions expire; active uploads are bounded; absolute lifetime is one hour.
- Website `/api/upload-url`, `/api/process`, and `/api/job/:id` behavior is unchanged.
- After send or expiry, no corresponding sealed R2 object remains.

## 15. Record the test result

For each phone/network combination record:

```text
Date/time:
Tester:
Phone model:
Android version:
StatusDrop version: 1.0.0+7
APK SHA-256:
Network: Wi-Fi / mobile data
Video profile and input details:
Local processing time:
Generated count and sizes:
Upload time:
Activation/delivery result:
TalkBack result:
Defects/screenshots/log timestamps:
Overall: PASS / FAIL
```

Do not call the beta production-ready until sections 3–13 pass on at least two representative ARM64 Android phones, including one lower/mid-range device.
