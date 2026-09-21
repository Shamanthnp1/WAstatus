import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:statusdrop/app.dart';

void main() {
  testWidgets('renders the StatusDrop scaffold', (tester) async {
    await tester.pumpWidget(const StatusDropApp());

    expect(find.text('StatusDrop'), findsOneWidget);
    expect(find.text('Choose videos'), findsNWidgets(2));
    expect(find.textContaining('made on your phone'), findsOneWidget);
    expect(find.text('Select'), findsOneWidget);
    expect(find.text('Compress'), findsOneWidget);
    expect(find.text('Send'), findsOneWidget);
    expect(find.byTooltip('More options'), findsOneWidget);

    await tester.tap(find.byTooltip('More options'));
    await tester.pumpAndSettle();
    expect(find.text('About & support'), findsOneWidget);

    await tester.tap(find.text('About & support'));
    await tester.pumpAndSettle();
    expect(find.text('About StatusDrop'), findsOneWidget);
    expect(find.text('Contact & support'), findsOneWidget);
    expect(find.text('Instagram'), findsOneWidget);
    expect(find.text('shamanthnadumane@gmail.com'), findsOneWidget);

    final aboutScrollable = find.descendant(
      of: find.byType(BottomSheet),
      matching: find.byType(Scrollable),
    );
    await tester.scrollUntilVisible(
      find.text('Source code & licenses'),
      250,
      scrollable: aboutScrollable,
    );
    expect(find.text('Privacy Policy'), findsOneWidget);
    expect(find.text('Source code & licenses'), findsOneWidget);

    await tester.scrollUntilVisible(
      find.textContaining('not affiliated with'),
      180,
      scrollable: aboutScrollable,
    );
    expect(find.textContaining('not affiliated with'), findsOneWidget);
    await tester.scrollUntilVisible(
      find.textContaining('does not ask you to enter a phone number'),
      160,
      scrollable: aboutScrollable,
    );
    expect(
      find.textContaining('does not ask you to enter a phone number'),
      findsOneWidget,
    );
    expect(find.text('Support StatusDrop'), findsNothing);

    await tester.scrollUntilVisible(
      find.text('Close'),
      200,
      scrollable: aboutScrollable,
    );
    await tester.tap(find.text('Close'));
    await tester.pumpAndSettle();

    await tester.scrollUntilVisible(find.text('Post in full HD'), 500);
    expect(find.text('Post in full HD'), findsOneWidget);
  });
}
