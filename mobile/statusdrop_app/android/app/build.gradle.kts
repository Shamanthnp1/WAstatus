import java.io.FileInputStream
import java.net.URI
import java.security.MessageDigest
import java.util.Properties
import java.util.zip.ZipInputStream

plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after Android and Kotlin.
    id("dev.flutter.flutter-gradle-plugin")
}

val keystoreProperties = Properties()
val keystorePropertiesFile = rootProject.file("key.properties")
if (keystorePropertiesFile.exists()) {
    FileInputStream(keystorePropertiesFile).use(keystoreProperties::load)
}

val releaseRequested = gradle.startParameter.taskNames.any {
    it.contains("Release", ignoreCase = true)
}
if (releaseRequested && !keystorePropertiesFile.exists()) {
    throw GradleException(
        "Release signing is not configured. Copy key.properties.example to " +
            "android/key.properties and point it to your private upload keystore.",
    )
}

android {
    namespace = "com.wastatusvideo.statusdrop"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_17.toString()
    }

    defaultConfig {
        applicationId = "com.wastatusvideo.statusdrop"
        minSdk = 29
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
        manifestPlaceholders["appLabel"] = "StatusDrop"
        manifestPlaceholders["appLabelSuffix"] = ""

        externalNativeBuild {
            cmake {
                // The self-host Node runtime ships for ARM64 only, like FFmpeg.
                abiFilters += "arm64-v8a"
                // Static C++ runtime for our small JNI shim, so the only
                // libc++_shared.so in the APK is FFmpegKit's, which libnode uses.
                arguments += "-DANDROID_STL=c++_static"
            }
        }
    }

    // Two editions of the same app:
    //   global: the Google Play build. StatusDrop-number delivery only; no
    //           Node runtime, bot, foreground service or self-host code.
    //   max:    sideloaded from the website. Adds self-host delivery (the
    //           user's own WhatsApp number) and installs next to global.
    // Build with `flutter build apk --flavor global` or `--flavor max`.
    flavorDimensions += "edition"
    productFlavors {
        create("global") {
            dimension = "edition"
            externalNativeBuild { cmake { arguments += "-DSTATUSDROP_SELFHOST=OFF" } }
        }
        create("max") {
            dimension = "edition"
            applicationIdSuffix = ".max"
            manifestPlaceholders["appLabel"] = "StatusDrop MAX"
            externalNativeBuild { cmake { arguments += "-DSTATUSDROP_SELFHOST=ON" } }
        }
    }

    externalNativeBuild {
        cmake {
            // Builds nothing for global (see STATUSDROP_SELFHOST).
            path = file("src/max/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    sourceSets {
        getByName("max") {
            // libnode.so from nodejs-mobile, fetched by fetchLibNode below.
            jniLibs.srcDir("libnode/bin")
        }
    }

    packaging {
        jniLibs {
            // StatusDrop's local FFmpeg pipeline is released and tested for
            // ARM64 only. Exclude incomplete/untested native configurations.
            excludes += setOf(
                "lib/armeabi-v7a/**",
                "lib/x86/**",
                "lib/x86_64/**",
            )
        }
    }

    signingConfigs {
        if (keystorePropertiesFile.exists()) {
            create("release") {
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
                storeFile = file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
            }
        }
    }

    buildTypes {
        debug {
            // Installs next to the Play Store version for testing on a phone.
            applicationIdSuffix = ".dev"
            manifestPlaceholders["appLabelSuffix"] = " Dev"
        }
        release {
            if (keystorePropertiesFile.exists()) {
                signingConfig = signingConfigs.getByName("release")
            }
            // Keep shrinking disabled for the first native-heavy release. This
            // avoids stripping FFmpegKit callbacks before dedicated release tests.
            isMinifyEnabled = false
            isShrinkResources = false
        }
    }
}

flutter {
    source = "../.."
}

dependencies {
    // Pinned maintained FFmpegKit GPL build. It includes libx264 and therefore
    // requires a GPL-compatible client release plus corresponding source/notices.
    implementation("com.arthenica:smart-exception-java:0.2.1")
    implementation("dev.ffmpegkit-maintained:ffmpeg-kit-full-gpl:8.1.7")
}

// ---------------------------------------------------------------------------
// Self-host delivery: embedded Node.js runtime and bot bundle.
// Both are build outputs (gitignored), produced before any native/asset step.
// ---------------------------------------------------------------------------

// nodejs-mobile core library (Node 18.20.4, MIT). Pinned by SHA-256.
val libNodeVersion = "v18.20.4"
val libNodeUrl =
    "https://github.com/nodejs-mobile/nodejs-mobile/releases/download/$libNodeVersion/nodejs-mobile-$libNodeVersion-android.zip"
val libNodeSha256 = "bd7321eaa1a7602fbe0bb87302df2d79d87835cf4363fbdd17c350dbb485c2af"
val libNodeDir = layout.projectDirectory.dir("libnode")

val fetchLibNode by tasks.registering {
    description = "Downloads and verifies nodejs-mobile's libnode.so and headers."
    val outputDir = libNodeDir.asFile
    outputs.dir(outputDir)
    onlyIf { !File(outputDir, "bin/arm64-v8a/libnode.so").isFile || !File(outputDir, "include/node/node.h").isFile }
    doLast {
        val zip = layout.buildDirectory.file("tmp/nodejs-mobile-$libNodeVersion-android.zip").get().asFile
        zip.parentFile.mkdirs()
        if (!zip.isFile) {
            logger.lifecycle("Downloading nodejs-mobile $libNodeVersion (about 57 MB)...")
            URI(libNodeUrl).toURL().openStream().use { input -> zip.outputStream().use { input.copyTo(it) } }
        }
        val digest = MessageDigest.getInstance("SHA-256")
        zip.inputStream().use { input ->
            val buffer = ByteArray(1 shl 16)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        val actual = digest.digest().joinToString("") { "%02x".format(it) }
        if (actual != libNodeSha256) {
            zip.delete()
            throw GradleException("nodejs-mobile download failed its SHA-256 check (got $actual).")
        }
        outputDir.deleteRecursively()
        ZipInputStream(zip.inputStream().buffered()).use { stream ->
            while (true) {
                val entry = stream.nextEntry ?: break
                val name = entry.name
                val wanted = name.startsWith("include/") || name == "bin/arm64-v8a/libnode.so"
                if (!wanted || entry.isDirectory || name.contains("..")) continue
                val target = File(outputDir, name)
                target.parentFile.mkdirs()
                target.outputStream().use { stream.copyTo(it) }
            }
        }
    }
}

// The bot: selfhost/ (Node project) -> src/max/assets/selfhost/ (esbuild bundle).
val selfHostDir = rootProject.projectDir.resolve("../selfhost")
val isWindows = System.getProperty("os.name").lowercase().contains("windows")
fun npmCommand(vararg args: String): List<String> =
    if (isWindows) listOf("cmd", "/c", "npm", *args) else listOf("npm", *args)

val selfHostNpmCi by tasks.registering(Exec::class) {
    description = "Installs the self-host bot's npm dependencies."
    workingDir = selfHostDir
    inputs.files(selfHostDir.resolve("package.json"), selfHostDir.resolve("package-lock.json"))
    outputs.dir(selfHostDir.resolve("node_modules"))
    commandLine(npmCommand("ci", "--no-audit", "--no-fund"))
}

val buildSelfHostBundle by tasks.registering(Exec::class) {
    description = "Bundles the self-host WhatsApp bot into Android assets."
    dependsOn(selfHostNpmCi)
    workingDir = selfHostDir
    inputs.dir(selfHostDir.resolve("src"))
    inputs.files(
        selfHostDir.resolve("build.mjs"),
        selfHostDir.resolve("package.json"),
        selfHostDir.resolve("package-lock.json"),
    )
    outputs.dir(layout.projectDirectory.dir("src/max/assets/selfhost"))
    commandLine(npmCommand("run", "bundle"))
}

// Only MAX builds need the Node runtime and the bot; global never fetches them.
tasks.configureEach {
    val maxVariant = name.contains("Max")
    if (maxVariant && name.startsWith("pre") && name.endsWith("Build")) {
        dependsOn(fetchLibNode, buildSelfHostBundle)
    }
    if (maxVariant && (name.startsWith("configureCMake") || name.startsWith("buildCMake") ||
            name.startsWith("generateJsonModel") || name.startsWith("externalNativeBuild"))
    ) {
        dependsOn(fetchLibNode)
    }
}
