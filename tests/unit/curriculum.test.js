const { normalizeCurriculum, normalizeCurriculumEntries, curriculumAliases } = require('../../services/curriculum');

describe('normalizeCurriculum', () => {
  test.each(['NCERT', 'ncert', ' Ncert ', 'N CERT', 'CBSE', 'cbse'])('%p -> CBSE', (v) => {
    expect(normalizeCurriculum(v)).toBe('CBSE');
  });

  test('leaves other curricula untouched (trimmed)', () => {
    expect(normalizeCurriculum(' IB ')).toBe('IB');
    expect(normalizeCurriculum(null)).toBeNull();
  });

  test('entries + aliases', () => {
    expect(normalizeCurriculumEntries([{ grade: 'Grade 8', curriculum: 'ncert', subjects: [] }])).toEqual([{ grade: 'Grade 8', curriculum: 'CBSE', subjects: [] }]);
    expect(curriculumAliases('CBSE')).toEqual(['CBSE', 'NCERT']);
  });
});
