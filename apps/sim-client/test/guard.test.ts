import { describe, expect, it } from 'vitest';
import { guardReply, splitSentences, stripLongIds, toPlainSpeech } from '../src/assistant/guard.ts';

describe('splitSentences', () => {
  it('splits on full stops, question marks and exclamation marks', () => {
    expect(splitSentences('Trash goes out Monday. Is that all? Great!')).toEqual([
      'Trash goes out Monday.',
      'Is that all?',
      'Great!',
    ]);
  });

  it('does not split inside street abbreviations, times or decimals', () => {
    expect(splitSentences('The pothole at 700 Boylston St. was reported at 9 a.m. on Monday. It is 4.5 meters away.')).toEqual([
      'The pothole at 700 Boylston St. was reported at 9 a.m. on Monday.',
      'It is 4.5 meters away.',
    ]);
  });

  it('does not split on initials or web addresses', () => {
    expect(splitSentences('Ask for J. Smith at boston.gov today. Thanks.')).toEqual([
      'Ask for J. Smith at boston.gov today.',
      'Thanks.',
    ]);
  });

  it('keeps closing quotes with their sentence and treats an ellipsis as one stop', () => {
    expect(splitSentences('She said "it is fixed." Wait... Really?')).toEqual(['She said "it is fixed."', 'Wait...', 'Really?']);
  });

  it('returns text without a terminator as one sentence, and nothing for blank input', () => {
    expect(splitSentences('no stop here')).toEqual(['no stop here']);
    expect(splitSentences('   ')).toEqual([]);
  });
});

describe('the two-sentence guard', () => {
  it('leaves a reply of one or two sentences alone', () => {
    const reply = 'A report already exists for that pothole. Would you like to follow it instead?';
    expect(guardReply(reply)).toEqual({ text: reply, sentenceCount: 2, truncated: false, idsRemoved: false });
  });

  it('cuts everything after the second sentence', () => {
    const guarded = guardReply('First thing. Second thing! Third thing? Fourth thing.');
    expect(guarded.text).toBe('First thing. Second thing!');
    expect(guarded.sentenceCount).toBe(4);
    expect(guarded.truncated).toBe(true);
  });

  it('counts sentences after flattening lists and line breaks', () => {
    const guarded = guardReply('Here is your schedule:\n\n- **Trash**: Monday.\n- **Recycling**: Thursday.\n- Yard waste: Friday.');
    expect(guarded.text).toBe('Here is your schedule: Trash: Monday. Recycling: Thursday.');
    expect(guarded.truncated).toBe(true);
  });

  it('caps the length even when the model writes one endless sentence', () => {
    const guarded = guardReply(`${'very '.repeat(200)}long`);
    expect(guarded.text.length).toBeLessThanOrEqual(401);
    expect(guarded.text.endsWith('.')).toBe(true);
    expect(guarded.truncated).toBe(true);
  });

  it('honours a different limit', () => {
    expect(guardReply('One. Two. Three.', { maxSentences: 1 }).text).toBe('One.');
    expect(guardReply('One. Two. Three.', { maxSentences: 3 })).toMatchObject({ text: 'One. Two. Three.', truncated: false });
  });
});

describe('stripLongIds', () => {
  it('removes a UUID together with the word that introduces it', () => {
    expect(stripLongIds('Your request ID 3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b is still open.')).toBe('Your request is still open.');
    expect(stripLongIds('Request with ID: 3F2B8C1E-9A4D-4E6F-8B2A-1C3D5E7F9A0B was filed.')).toBe('Request was filed.');
  });

  it('removes CityDesk request handles and long case numbers', () => {
    expect(stripLongIds('I am following boston/101005123456 for you.')).toBe('I am following for you.');
    expect(stripLongIds('Case number 101005123456 is closed.')).toBe('Case is closed.');
    expect(stripLongIds('It is filed (#8842211990).')).toBe('It is filed.');
  });

  it('leaves ordinary numbers, addresses, dates and phone numbers alone', () => {
    const reply = 'Pickup at 700 Boylston Street is on October 15, 2026. Call 617-635-4500 or 311.';
    expect(stripLongIds(reply)).toBe(reply);
  });

  it('is reported by the guard', () => {
    const guarded = guardReply('Your report 3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b is open.');
    expect(guarded.text).toBe('Your report is open.');
    expect(guarded.idsRemoved).toBe(true);
  });
});

describe('toPlainSpeech', () => {
  it('strips markdown but keeps snake_case and the words of a link', () => {
    expect(toPlainSpeech('**Done.** See [Boston 311](https://311.boston.gov) or `my_requests`.')).toBe(
      'Done. See Boston 311 or my_requests.',
    );
  });
});
