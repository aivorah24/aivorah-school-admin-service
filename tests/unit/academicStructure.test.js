const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

const { sortGradeNames, gradeSortKey, buildGradesSectionsView, saveStructure } = require('../../services/academicStructure');

beforeEach(() => { mockSb.reset(); });

describe('gradeSortKey', () => {
  test('extracts the numeric portion of a grade label', () => {
    expect(gradeSortKey('Grade 2')).toBe(2);
    expect(gradeSortKey('Grade 10')).toBe(10);
  });

  test('returns MAX_SAFE_INTEGER for a label with no digits (sorts last)', () => {
    expect(gradeSortKey('IGCSE')).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('sortGradeNames', () => {
  test('sorts numerically, not lexicographically ("Grade 2" before "Grade 10")', () => {
    expect(['Grade 10', 'Grade 2'].sort(sortGradeNames)).toEqual(['Grade 2', 'Grade 10']);
  });

  // Grade LABELS for IB schools are "PYP N" / "MYP N" / "DP N" (no "IB"
  // prefix) — "IB PYP" etc. is the separate CURRICULUM value, never a grade
  // label. gradeProgramTier's regex only matches a leading run of letters,
  // so "IB PYP" reads as prefix "IB" (untiered) — this is intentional, not
  // a gap, since sortGradeNames never receives curriculum names in practice.
  test('orders bare PYP/MYP/DP grade labels PYP -> MYP -> DP regardless of enrollment', () => {
    expect(['DP 1', 'PYP 3', 'MYP 2'].sort(sortGradeNames)).toEqual(['PYP 3', 'MYP 2', 'DP 1']);
  });

  test('sorts within a programme by grade number', () => {
    expect(['MYP 10', 'MYP 6'].sort(sortGradeNames)).toEqual(['MYP 6', 'MYP 10']);
  });

  test('falls back to locale compare for two numberless labels', () => {
    expect(['IGCSE', 'Cambridge'].sort(sortGradeNames)).toEqual(['Cambridge', 'IGCSE']);
  });
});

describe('buildGradesSectionsView', () => {
  test('merges the overlay structure with live student counts', async () => {
    mockSb.setTable('schools', {
      data: { academic_structure: { grades: [{ name: 'Grade 6', archived: false, sections: [{ name: 'A', archived: false }] }] } },
      error: null,
    });
    mockSb.setTable('users', {
      data: [{ grade: 'Grade 6', section: 'A' }, { grade: 'Grade 6', section: 'A' }, { grade: 'Grade 6', section: null }],
      error: null,
    });

    const grades = await buildGradesSectionsView('school-1');

    expect(grades).toHaveLength(1);
    expect(grades[0].name).toBe('Grade 6');
    expect(grades[0].totalStudents).toBe(3);
    expect(grades[0].unassignedCount).toBe(1);
    expect(grades[0].sections[0]).toMatchObject({ name: 'A', studentCount: 2 });
  });

  test('folds in a grade that exists only from student data, not the overlay', async () => {
    mockSb.setTable('schools', { data: { academic_structure: { grades: [] } }, error: null });
    mockSb.setTable('users', { data: [{ grade: 'Grade 9', section: 'C' }], error: null });

    const grades = await buildGradesSectionsView('school-1');

    expect(grades).toHaveLength(1);
    expect(grades[0]).toMatchObject({ name: 'Grade 9', archived: false, totalStudents: 1 });
    expect(grades[0].sections[0]).toMatchObject({ name: 'C', studentCount: 1 });
  });

  test('returns an empty list when there is no overlay and no students', async () => {
    mockSb.setTable('schools', { data: null, error: null });
    mockSb.setTable('users', { data: [], error: null });

    const grades = await buildGradesSectionsView('school-1');
    expect(grades).toEqual([]);
  });

  test('preserves an archived, student-less grade from the overlay', async () => {
    mockSb.setTable('schools', {
      data: { academic_structure: { grades: [{ name: 'Grade 12', archived: true, sections: [] }] } },
      error: null,
    });
    mockSb.setTable('users', { data: [], error: null });

    const grades = await buildGradesSectionsView('school-1');
    expect(grades).toEqual([{ name: 'Grade 12', archived: true, sections: [], unassignedCount: 0, totalStudents: 0 }]);
  });
});

describe('saveStructure', () => {
  test('throws when the update fails', async () => {
    mockSb.setTable('schools', { data: null, error: { message: 'db unavailable' } });
    await expect(saveStructure('school-1', [])).rejects.toBeTruthy();
  });

  test('resolves without throwing on success', async () => {
    mockSb.setTable('schools', { data: null, error: null });
    await expect(saveStructure('school-1', [{ name: 'Grade 6', archived: false, sections: [] }])).resolves.toBeUndefined();
  });
});
