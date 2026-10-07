const test = require("node:test");
const assert = require("node:assert/strict");
const { fuzzyMatch } = require("../core.js");

const rankingCases = [
  {
    name: "a domain match beats a shorter URL with the same word deep in its path",
    query: "facebook",
    expected: ["https://facebook.com/a-long-page-name", "https://a.co/somewhere/facebook"]
  },
  {
    name: "tight path matches can beat earlier but more scattered domain matches",
    query: "gitdan",
    expected: [
      "https://gitdan.com/",
      "https://github.com/danny",
      "https://something.com/git/dan",
      "https://github.com/something/danny",
      "https://github.com/something/david/now"
    ]
  },
  {
    name: "command names favor an earlier match even with a longer trailing page name",
    query: "facebook",
    expected: ["Facebook › A much longer page name", "Other › Somewhere › Facebook"]
  },
  {
    name: "smaller gaps win when the starting position and candidate length are equal",
    query: "ab",
    expected: ["a-b".padEnd(24, "x"), "axxxxxxxx-b".padEnd(24, "x")]
  },
  {
    name: "consecutive groups beat individually separated characters",
    query: "abcd",
    expected: ["abcdxxx", "ab---cd", "a-b-c-d"]
  },
  {
    name: "a later compact match beats an early match with large gaps",
    query: "abcd",
    expected: ["xxxx/ab/cd", "ab/xxxxxxxx/cd"]
  },
  {
    name: "earlier matches win when both candidates have the same groups and gaps",
    query: "abcd",
    expected: ["ab/cd/long-trailing-text", "prefix/ab/cd"]
  },
  {
    name: "shorter candidates win when their matched positions are identical",
    query: "gitdan",
    expected: ["Github › Danny", "Github › Danny › More pages"]
  }
];

for (const { name, query, expected } of rankingCases) {
  test(`fuzzy ranking: ${name}`, () => {
    const actual = [...expected].reverse().sort((left, right) =>
      fuzzyMatch(query, right).score - fuzzyMatch(query, left).score);
    assert.deepEqual(actual, expected);
  });
}

test("fuzzy highlights select a later tighter alignment instead of the first possible letters", () => {
  assert.deepEqual(fuzzyMatch("abc", "a/b___ab/c").indices, [6, 7, 9]);
  assert.deepEqual(fuzzyMatch("FACEBOOK", "/facebook/x/facebook").indices,
    [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(fuzzyMatch("bash", "Bashly › Home").indices, [0, 1, 2, 3]);
  assert.equal(fuzzyMatch("ba", "ab"), null);
  assert.equal(fuzzyMatch("abc", "ab"), null);
  assert.deepEqual(fuzzyMatch("", "anything"), { score: 0, indices: [] });
});

// Enumerate every alignment independently of the optimized matcher. Complete
// contiguous occurrences stay authoritative; ties choose the earliest indices.
function exhaustiveMatch(query, candidate) {
  if (!query) return { score: 0, indices: [] };
  const needle = query.toLowerCase();
  const haystack = candidate.toLowerCase();
  const alignments = [];
  function visit(indices, from) {
    if (indices.length === needle.length) {
      alignments.push(indices);
      return;
    }
    for (let index = from; index < haystack.length; index++) {
      if (haystack[index] === needle[indices.length]) visit([...indices, index], index + 1);
    }
  }
  visit([], 0);
  const contiguous = alignments.filter(indices => indices.at(-1) - indices[0] + 1 === needle.length);
  let best = null;
  for (const indices of contiguous.length ? contiguous : alignments) {
    let score = -indices[0] * 0.5;
    for (let offset = 0; offset < indices.length; offset++) {
      const index = indices[offset];
      score += 1;
      if ((!contiguous.length || offset === 0) &&
          (index === 0 || /[\s/_-]/.test(haystack[index - 1]))) score += 4;
      if (offset > 0) {
        const gap = index - indices[offset - 1] - 1;
        score += gap === 0 ? 5 : -gap;
      }
    }
    if (contiguous.length && indices[0] === 0) score += 8;
    score -= haystack.length * 0.01;
    if (!best || score > best.score) best = { score, indices };
  }
  return best;
}

test("optimized fuzzy matching agrees with exhaustive alignment on short strings", () => {
  const queries = ["", "a", "b", "aa", "ab", "ba", "bb", "aaa", "aab", "aba", "abb", "bab", "bbb", "a/b"];
  function check(candidate) {
    for (const query of queries) {
      const expected = exhaustiveMatch(query, candidate);
      const actual = fuzzyMatch(query, candidate);
      assert.deepEqual(actual?.indices ?? null, expected?.indices ?? null,
        `query ${JSON.stringify(query)}, candidate ${JSON.stringify(candidate)}`);
      if (actual) assert.ok(Math.abs(actual.score - expected.score) < 1e-9,
        `score for query ${JSON.stringify(query)}, candidate ${JSON.stringify(candidate)}`);
    }
    if (candidate.length < 6) {
      for (const character of ["a", "b", "/"]) check(candidate + character);
    }
  }
  check("");
});
