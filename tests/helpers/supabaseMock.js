// Chainable Supabase mock, same pattern as aivorah-students-service's
// tests/helpers/supabaseMock.js — sequential per-table responses (a plain
// object repeats for every call; an array is consumed in order).
function makeSupabaseMock() {
  const tableResponses = {};
  const tableCallCounts = {};

  function nextResponseFor(table) {
    const configured = tableResponses[table];
    if (configured === undefined) return { data: null, error: null };
    if (Array.isArray(configured)) {
      const i = tableCallCounts[table] || 0;
      tableCallCounts[table] = i + 1;
      return configured[Math.min(i, configured.length - 1)];
    }
    return configured;
  }

  function makeChain(table) {
    const chain = {
      select: jest.fn(() => chain),
      eq: jest.fn(() => chain),
      neq: jest.fn(() => chain),
      ilike: jest.fn(() => chain),
      in: jest.fn(() => chain),
      update: jest.fn(() => chain),
      insert: jest.fn(() => chain),
      delete: jest.fn(() => chain),
      upsert: jest.fn(() => chain),
      order: jest.fn(() => chain),
      range: jest.fn(() => chain),
      single: jest.fn(() => Promise.resolve(nextResponseFor(table))),
      maybeSingle: jest.fn(() => Promise.resolve(nextResponseFor(table))),
      then: (resolve, reject) => Promise.resolve(nextResponseFor(table)).then(resolve, reject),
    };
    return chain;
  }

  let rpcResponse = { data: null, error: null };
  const supabase = {
    from: jest.fn((table) => makeChain(table)),
    rpc: jest.fn(() => Promise.resolve(rpcResponse)),
  };

  return {
    supabase,
    setTable(table, response) { tableResponses[table] = response; },
    setRpc(response) { rpcResponse = response; },
    reset() {
      rpcResponse = { data: null, error: null };
      Object.keys(tableResponses).forEach((k) => delete tableResponses[k]);
      Object.keys(tableCallCounts).forEach((k) => delete tableCallCounts[k]);
    },
  };
}

module.exports = { makeSupabaseMock };
