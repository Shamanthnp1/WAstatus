'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const StatusDropEditor = require('../public/js/editor');

/**
 * Property 8: Text content validation preserves prior state
 *
 * For any attempted text content change that is empty or longer than 200
 * characters, the change is rejected, the overlay's previously recorded text is
 * retained, and an invalid indication is set. A subsequent VALID text change is
 * accepted and clears the invalid indication.
 *
 * Validates: Requirements 5.6
 */

const EditorInstance = StatusDropEditor.EditorInstance;

/** Read the currently recorded text for an overlay id from the recipe state. */
function recordedText(editor, id) {
  for (let i = 0; i < editor.textOverlays.length; i++) {
    if (editor.textOverlays[i].id === id) return editor.textOverlays[i].text;
  }
  return undefined;
}

/** A valid Text_Overlay content: a string whose length is in [1, 200]. */
const validText = () => fc.string({ minLength: 1, maxLength: 200 });

/**
 * An invalid text-content change. Covers the two length faults called out by
 * Req 5.6 (empty / over-200) plus the non-string cases (null, number, boolean,
 * undefined) that `isValidTextContent` must also reject.
 */
const invalidText = () =>
  fc.oneof(
    fc.constant(''), // empty
    fc.string({ minLength: 201, maxLength: 500 }), // over-length (201..500)
    fc.constant(null),
    fc.integer(),
    fc.double({ noNaN: true }),
    fc.boolean(),
    fc.constant(undefined)
  );

test('Property 8: empty/over-length/non-string text changes are rejected and prior state is retained', () => {
  fc.assert(
    fc.property(validText(), invalidText(), (priorText, badText) => {
      const editor = new EditorInstance(0);

      // Seed an overlay with a valid prior text.
      const added = editor.addTextOverlay({ text: priorText });
      assert.equal(added.ok, true, 'precondition: valid prior text is accepted');
      const id = added.overlay.id;
      assert.equal(recordedText(editor, id), priorText);
      assert.equal(editor.isEntryInvalid(id), false);

      // Attempt an invalid text content change.
      const result = editor.updateTextOverlay(id, { text: badText });

      // The change is rejected.
      assert.equal(result.ok, false, 'invalid text change must be rejected');

      // The overlay's previously recorded text is retained unchanged.
      assert.equal(
        recordedText(editor, id),
        priorText,
        'prior text must be preserved on rejection'
      );

      // An invalid indication is set, both per-entry and aggregate.
      assert.equal(editor.isEntryInvalid(id), true, 'invalid indication must be set');
      assert.equal(editor.hasInvalidInput(), true, 'aggregate invalid indication must be set');
    }),
    { numRuns: 200 }
  );
});

test('Property 8: a subsequent valid text change is accepted and clears the invalid indication', () => {
  fc.assert(
    fc.property(validText(), invalidText(), validText(), (priorText, badText, nextText) => {
      const editor = new EditorInstance(0);

      const added = editor.addTextOverlay({ text: priorText });
      assert.equal(added.ok, true);
      const id = added.overlay.id;

      // Drive into the invalid state first.
      const rejected = editor.updateTextOverlay(id, { text: badText });
      assert.equal(rejected.ok, false);
      assert.equal(editor.isEntryInvalid(id), true);
      assert.equal(recordedText(editor, id), priorText);

      // A subsequent valid change is accepted, recorded, and clears the flag.
      const accepted = editor.updateTextOverlay(id, { text: nextText });
      assert.equal(accepted.ok, true, 'valid text change must be accepted');
      assert.equal(recordedText(editor, id), nextText, 'valid text must be recorded');
      assert.equal(editor.isEntryInvalid(id), false, 'invalid indication must be cleared');
      assert.equal(editor.hasInvalidInput(), false, 'aggregate indication must be cleared');
    }),
    { numRuns: 200 }
  );
});
