import 'package:flutter/material.dart';

abstract final class StatusDropTheme {
  static const _brandGreen = Color(0xFF168447);

  static ThemeData get light => _build(Brightness.light);
  static ThemeData get dark => _build(Brightness.dark);

  static ThemeData _build(Brightness brightness) {
    final isDark = brightness == Brightness.dark;
    final generated = ColorScheme.fromSeed(
      seedColor: _brandGreen,
      brightness: brightness,
    );
    final scheme = generated.copyWith(
      primary: isDark ? const Color(0xFF6DE39A) : const Color(0xFF137A3E),
      onPrimary: isDark ? const Color(0xFF00391B) : Colors.white,
      primaryContainer: isDark
          ? const Color(0xFF0B4F29)
          : const Color(0xFFD8F5E1),
      onPrimaryContainer: isDark
          ? const Color(0xFFBEF7D0)
          : const Color(0xFF073D20),
      secondary: isDark ? const Color(0xFFB5CDBB) : const Color(0xFF496451),
      onSecondary: isDark ? const Color(0xFF20352A) : const Color(0xFFFFFFFF),
      secondaryContainer: isDark
          ? const Color(0xFF2B4133)
          : const Color(0xFFE3EFE6),
      onSecondaryContainer: isDark
          ? const Color(0xFFD1E9D7)
          : const Color(0xFF22382A),
      tertiary: isDark ? const Color(0xFFC3D5C7) : const Color(0xFF53685A),
      tertiaryContainer: isDark
          ? const Color(0xFF33473A)
          : const Color(0xFFE8F0EA),
      onTertiaryContainer: isDark
          ? const Color(0xFFDDE9E0)
          : const Color(0xFF25372B),
      surface: isDark ? const Color(0xFF0C1510) : const Color(0xFFF8FAF7),
      onSurface: isDark ? const Color(0xFFE6EEE8) : const Color(0xFF15251A),
      surfaceContainerLowest: isDark
          ? const Color(0xFF08100B)
          : const Color(0xFFFFFFFF),
      surfaceContainerLow: isDark
          ? const Color(0xFF121D16)
          : const Color(0xFFF2F6F2),
      surfaceContainer: isDark
          ? const Color(0xFF17231B)
          : const Color(0xFFECF2ED),
      surfaceContainerHigh: isDark
          ? const Color(0xFF202D24)
          : const Color(0xFFE5ECE7),
      outline: isDark ? const Color(0xFF87988B) : const Color(0xFF687A6D),
      outlineVariant: isDark
          ? const Color(0xFF3D4C41)
          : const Color(0xFFC8D5CB),
      error: isDark ? const Color(0xFFFFB4AB) : const Color(0xFFBA1A1A),
      errorContainer: isDark
          ? const Color(0xFF93000A)
          : const Color(0xFFFFDAD6),
    );

    final base = ThemeData(
      useMaterial3: true,
      brightness: brightness,
      colorScheme: scheme,
      visualDensity: VisualDensity.standard,
    );
    final textTheme = base.textTheme.copyWith(
      headlineMedium: base.textTheme.headlineMedium?.copyWith(
        fontWeight: FontWeight.w800,
        letterSpacing: -0.6,
        height: 1.08,
      ),
      headlineSmall: base.textTheme.headlineSmall?.copyWith(
        fontWeight: FontWeight.w800,
        letterSpacing: -0.3,
        height: 1.12,
      ),
      titleLarge: base.textTheme.titleLarge?.copyWith(
        fontWeight: FontWeight.w800,
        letterSpacing: -0.2,
      ),
      titleMedium: base.textTheme.titleMedium?.copyWith(
        fontWeight: FontWeight.w700,
      ),
      bodyLarge: base.textTheme.bodyLarge?.copyWith(height: 1.45),
      bodyMedium: base.textTheme.bodyMedium?.copyWith(height: 1.4),
      labelLarge: base.textTheme.labelLarge?.copyWith(
        fontSize: 16,
        fontWeight: FontWeight.w700,
      ),
    );

    const controlRadius = BorderRadius.all(Radius.circular(16));
    return base.copyWith(
      scaffoldBackgroundColor: scheme.surface,
      colorScheme: scheme,
      textTheme: textTheme,
      appBarTheme: AppBarTheme(
        backgroundColor: scheme.surface,
        foregroundColor: scheme.onSurface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        toolbarHeight: 72,
        titleSpacing: 20,
      ),
      cardTheme: CardThemeData(
        color: scheme.surfaceContainerLowest,
        surfaceTintColor: Colors.transparent,
        shadowColor: Colors.transparent,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: const BorderRadius.all(Radius.circular(22)),
          side: BorderSide(color: scheme.outlineVariant),
        ),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          minimumSize: const Size(48, 56),
          shape: const RoundedRectangleBorder(borderRadius: controlRadius),
          textStyle: textTheme.labelLarge,
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          minimumSize: const Size(48, 56),
          side: BorderSide(color: scheme.outline),
          shape: const RoundedRectangleBorder(borderRadius: controlRadius),
          textStyle: textTheme.labelLarge,
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          minimumSize: const Size(48, 48),
          shape: const RoundedRectangleBorder(borderRadius: controlRadius),
          textStyle: textTheme.labelLarge,
        ),
      ),
      iconButtonTheme: IconButtonThemeData(
        style: IconButton.styleFrom(
          minimumSize: const Size.square(48),
          shape: const RoundedRectangleBorder(borderRadius: controlRadius),
        ),
      ),
      progressIndicatorTheme: ProgressIndicatorThemeData(
        color: scheme.primary,
        linearTrackColor: scheme.surfaceContainerHigh,
        linearMinHeight: 8,
        borderRadius: const BorderRadius.all(Radius.circular(999)),
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        backgroundColor: scheme.inverseSurface,
        contentTextStyle: textTheme.bodyMedium?.copyWith(
          color: scheme.onInverseSurface,
          fontWeight: FontWeight.w600,
        ),
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.all(Radius.circular(16)),
        ),
      ),
      dividerTheme: DividerThemeData(color: scheme.outlineVariant, space: 1),
      focusColor: scheme.primaryContainer,
    );
  }
}
