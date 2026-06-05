'use strict';

const { FIELD_MAP, calculateBountyXp, XP_BY_PRIORITY } = require('../../../../src/services/bounties/bountyTypes');

describe('bounties/bountyTypes — FIELD_MAP', () => {
  test('covers all 8 MVP bounty types', () => {
    expect(Object.keys(FIELD_MAP).sort()).toEqual([
      'BACK_OF_FIGURE', 'BOTTOM_STAMP', 'NOTES_CONTEXT', 'PACKAGING_BACK',
      'PACKAGING_FRONT', 'RELEASE_METHOD', 'RELEASE_YEAR', 'SIDE_VIEW',
    ]);
  });

  test('maps each type to the correct brick column', () => {
    expect(FIELD_MAP.PACKAGING_FRONT.column).toBe('packaging_front_image_url');
    expect(FIELD_MAP.PACKAGING_BACK.column).toBe('packaging_back_image_url');
    expect(FIELD_MAP.BACK_OF_FIGURE.column).toBe('back_image_url');
    expect(FIELD_MAP.SIDE_VIEW.column).toBe('side_image_url');
    expect(FIELD_MAP.BOTTOM_STAMP.column).toBe('bottom_stamp_image_url');
    expect(FIELD_MAP.RELEASE_YEAR.column).toBe('release_year');
    expect(FIELD_MAP.RELEASE_METHOD.column).toBe('release_method');
    expect(FIELD_MAP.NOTES_CONTEXT.column).toBe('notes');
  });

  test('image bounties are IMAGE kind, data bounties are DATA kind', () => {
    ['PACKAGING_FRONT', 'PACKAGING_BACK', 'BACK_OF_FIGURE', 'SIDE_VIEW', 'BOTTOM_STAMP']
      .forEach((t) => expect(FIELD_MAP[t].kind).toBe('IMAGE'));
    ['RELEASE_YEAR', 'RELEASE_METHOD', 'NOTES_CONTEXT']
      .forEach((t) => expect(FIELD_MAP[t].kind).toBe('DATA'));
  });
});

describe('bounties/bountyTypes — calculateBountyXp (PROPOSED amounts, flagged)', () => {
  test('derives XP from priority', () => {
    expect(calculateBountyXp('HIGH')).toBe(XP_BY_PRIORITY.HIGH);
    expect(calculateBountyXp('MEDIUM')).toBe(XP_BY_PRIORITY.MEDIUM);
    expect(calculateBountyXp('LOW')).toBe(XP_BY_PRIORITY.LOW);
  });

  test('falls back to a default for unknown priority', () => {
    expect(calculateBountyXp('SOMETHING_ELSE')).toBe(10);
    expect(calculateBountyXp(undefined)).toBe(10);
  });
});
