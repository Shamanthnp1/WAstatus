import 'package:flutter/material.dart';

import 'screens/home_screen.dart';
import 'theme/statusdrop_theme.dart';

class StatusDropApp extends StatelessWidget {
  const StatusDropApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'StatusDrop',
    debugShowCheckedModeBanner: false,
    theme: StatusDropTheme.light,
    darkTheme: StatusDropTheme.dark,
    themeMode: ThemeMode.system,
    home: const HomeScreen(),
  );
}
