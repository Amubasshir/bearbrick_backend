'use strict';

const { selectFiveWithOverlapRule } = require('../../../../src/services/challenges/ChallengeAssignmentService');

// Pure unit tests for the slot-selection logic. No DB.

function mkTemplate(id, family, logicMatch = {}) {
  return {
    id: BigInt(id),
    challenge_family: family,
    logic_definition: { trigger: 'vote_event', match: logicMatch, count_strategy: 'per_event' },
  };
}

describe('selectFiveWithOverlapRule (pure)', () => {
  test('returns first 5 when more than 5 eligible and no overlap concerns', () => {
    const eligible = [
      mkTemplate(1, 'vote'),
      mkTemplate(2, 'explore'),
      mkTemplate(3, 'maintain'),
      mkTemplate(4, 'category_mastery'),
      mkTemplate(5, 'contribute'),
      mkTemplate(6, 'vote'),
      mkTemplate(7, 'explore'),
    ];
    const out = selectFiveWithOverlapRule(eligible);
    expect(out).toHaveLength(5);
    // Order is preserved
    expect(out.map((t) => Number(t.id))).toEqual([1, 2, 3, 4, 5]);
  });

  test('returns all when fewer than 5 eligible', () => {
    const eligible = [mkTemplate(1, 'vote'), mkTemplate(2, 'explore')];
    const out = selectFiveWithOverlapRule(eligible);
    expect(out).toHaveLength(2);
  });

  test('skips near-duplicates (same logic_definition.match)', () => {
    const eligible = [
      mkTemplate(1, 'vote', { vote_type: 'OVER' }),
      mkTemplate(2, 'vote', { vote_type: 'OVER' }), // duplicate matcher
      mkTemplate(3, 'explore', {}),
      mkTemplate(4, 'maintain', {}),
      mkTemplate(5, 'category_mastery', {}),
      mkTemplate(6, 'contribute', {}),
    ];
    const out = selectFiveWithOverlapRule(eligible);
    expect(out).toHaveLength(5);
    expect(out.map((t) => Number(t.id))).toEqual([1, 3, 4, 5, 6]);
    expect(out.find((t) => Number(t.id) === 2)).toBeUndefined();
  });

  test('preserves order — first eligible wins on duplicates', () => {
    const eligible = [
      mkTemplate(10, 'vote', { foo: 'bar' }),
      mkTemplate(11, 'vote', { foo: 'bar' }), // dup
      mkTemplate(12, 'vote'),
      mkTemplate(13, 'explore'),
      mkTemplate(14, 'maintain'),
      mkTemplate(15, 'category_mastery'),
    ];
    const out = selectFiveWithOverlapRule(eligible);
    expect(out.map((t) => Number(t.id))).toEqual([10, 12, 13, 14, 15]);
  });
});
