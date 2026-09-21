# Google Play release procedure

## 1. Play Console

Register or open the developer account at https://play.google.com/console. A newly created personal account may require a closed test with at least 12 opted-in testers for 14 continuous days before production access.

## 2. Create the private upload key

Run this command yourself from `mobile/statusdrop_app` so the password is entered privately and never appears in source control or chat logs:

```powershell
keytool -genkeypair -v `
  -keystore android/upload-keystore.jks `
  -alias statusdrop-upload `
  -keyalg RSA -keysize 4096 -validity 10000
```

Copy `android/key.properties.example` to `android/key.properties`, then replace both password placeholders with the values entered into `keytool`.

Both files are ignored by `android/.gitignore`. Back up the keystore and passwords in a secure password manager. Google Play App Signing can reset a lost upload key, but losing release credentials still causes delays and operational risk.

## 3. Validate source

```powershell
flutter pub get
flutter analyze
flutter test --no-pub
```

## 4. Build the release bundle

```powershell
flutter build appbundle --release
```

Expected output:

```text
build/app/outputs/bundle/release/app-release.aab
```

The Gradle configuration refuses a release task when `android/key.properties` is missing; it never falls back to the debug key.

## 5. Verify

- Inspect bundle metadata and signing certificate.
- Run 16 KB native-library alignment checks.
- Use Play Console's App Bundle Explorer to inspect device delivery size and supported ABIs.
- Install a Play-generated APK through internal testing on at least two ARM64 devices.
- Re-run picker, local FFmpeg, cancellation, automatic upload, activation, WhatsApp delivery, privacy links, tutorial, and accessibility checks.

## 6. Upload and testing tracks

1. Create the Play app with package `com.wastatusvideo.statusdrop`.
2. Enroll in Play App Signing.
3. Upload the AAB to Internal testing first.
4. Complete App content, Data safety, Privacy policy, Content rating, Target audience, Ads, and Store listing.
5. Move to Closed testing and invite the Google Group.
6. Keep at least 12 eligible testers opted in continuously for 14 days if required for the account.
7. Apply for production access, answer the testing questionnaire, then create the production release.

Never upload debug APKs, `key.properties`, a keystore, credentials, media, or backend secrets.
