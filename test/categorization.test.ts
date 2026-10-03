/**
 * No-network unit tests for the pure Gate 3 logic: prompt builders and plan
 * validators (plus `flattenTaxonomyPaths`).
 *
 * These import only dependency-free modules (no Zotero globals, no config, no
 * network) so they run under plain Node with `--experimental-strip-types`.
 *
 * Run with: node --test --experimental-strip-types test/categorization.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { LibraryItem } from "../src/modules/libraryModel.ts";
import {
  buildClassificationPrompt,
  buildRetryPrompt,
  buildTaxonomyPrompt,
  serializeItemForPrompt,
  TAXONOMY_SAMPLE_LIMIT,
} from "../src/modules/promptBuilder.ts";
import {
  extractJson,
  flattenTaxonomyPaths,
  validateAssignments,
  validateTaxonomy,
} from "../src/modules/planValidator.ts";
import type { TaxonomyNode } from "../src/modules/categorizationTypes.ts";

// --- fixtures -------------------------------------------------------------

function fixtureItem(overrides: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: 1,
    key: "ABCD1234",
    itemType: "journalArticle",
    title: "Deep Joint Source-Channel Coding for Wireless Image Transmission",
    abstract:
      "We propose a deep learning based joint source-channel coding scheme for wireless image transmission.",
    date: "2024-01-01",
    doi: "10.1000/xyz",
    publicationTitle: "IEEE Transactions on Communications",
    creators: [
      { firstName: "Alice", lastName: "Smith", creatorType: "author" },
    ],
    tags: ["jscc", "wireless"],
    attachmentCount: 2,
    collectionPaths: ["SemanticComm/JSCC/Analog"],
    ...overrides,
  };
}

function fixtureTaxonomy(): TaxonomyNode[] {
  return [
    {
      name: "SemanticComm",
      path: "SemanticComm",
      description: "Semantic / goal-oriented communication.",
      children: [
        {
          name: "JSCC",
          path: "SemanticComm/JSCC",
          description: "Joint source-channel coding.",
          children: [
            {
              name: "Analog",
              path: "SemanticComm/JSCC/Analog",
              description: "Analog JSCC schemes.",
              children: [],
            },
          ],
        },
      ],
    },
    {
      name: "ChannelCoding",
      path: "ChannelCoding",
      description: "Forward error correction.",
      children: [],
    },
  ];
}

// --- promptBuilder --------------------------------------------------------

test("buildTaxonomyPrompt: includes titles and schema instruction", () => {
  const sample = [
    fixtureItem({ id: 1, title: "Paper One" }),
    fixtureItem({ id: 2, title: "Paper Two" }),
  ];
  const { system, user } = buildTaxonomyPrompt(sample);
  assert.ok(system.includes("8 to 15 top-level areas"));
  assert.ok(system.includes("Return STRICT JSON"));
  assert.ok(user.includes("Paper One"));
  assert.ok(user.includes("Paper Two"));
  assert.ok(user.includes("itemId: 1"));
  assert.ok(user.includes("itemId: 2"));
  assert.ok(user.includes("2 sample papers"));
});

test("buildTaxonomyPrompt: includes venue, date, currentTopCollection", () => {
  const sample = [fixtureItem({ id: 7 })];
  const { user } = buildTaxonomyPrompt(sample);
  assert.ok(user.includes("IEEE Transactions on Communications"));
  assert.ok(user.includes("2024-01-01"));
  assert.ok(user.includes("currentTopCollection: SemanticComm"));
});

test("buildTaxonomyPrompt: unfiled item shows (unfiled)", () => {
  const sample = [fixtureItem({ id: 1, collectionPaths: [] })];
  const { user } = buildTaxonomyPrompt(sample);
  assert.ok(user.includes("currentTopCollection: (unfiled)"));
});

test("buildClassificationPrompt: includes batch items and taxonomy paths", () => {
  const batch = [fixtureItem({ id: 10, title: "Batched Paper" })];
  const paths = ["SemanticComm", "SemanticComm/JSCC", "ChannelCoding"];
  const { system, user } = buildClassificationPrompt(batch, paths);
  assert.ok(system.includes("between 1 and 3 paths"));
  assert.ok(system.includes("Return STRICT JSON"));
  assert.ok(user.includes("Batched Paper"));
  assert.ok(user.includes("itemId: 10"));
  assert.ok(user.includes("- SemanticComm"));
  assert.ok(user.includes("- SemanticComm/JSCC"));
  assert.ok(user.includes("- ChannelCoding"));
  assert.ok(user.includes("3 total"));
});

test("buildRetryPrompt: includes the error message and forbids prose", () => {
  const { system, user } = buildRetryPrompt("missing field 'path'");
  assert.ok(system.includes("could not be parsed"));
  assert.ok(system.replace(/\s+/g, " ").includes("no markdown fences"));
  assert.ok(user.includes("missing field 'path'"));
  assert.ok(user.includes("JSON and nothing else"));
});

test("serializeItemForPrompt: no abstract when budget is 0", () => {
  const item = fixtureItem({ id: 1, abstract: "x".repeat(2000) });
  const out = serializeItemForPrompt(item);
  // With ABSTRACT_BUDGET_CHARS=0, abstract is omitted entirely
  assert.ok(!out.includes("abstract:"));
  assert.ok(!out.includes("…"));
});

test("TAXONOMY_SAMPLE_LIMIT is the documented 40", () => {
  assert.equal(TAXONOMY_SAMPLE_LIMIT, 40);
});

// --- validateTaxonomy -----------------------------------------------------

test("validateTaxonomy: accepts a valid tree", () => {
  const res = validateTaxonomy(fixtureTaxonomy());
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.length, 2);
    assert.equal(res.value[0].name, "SemanticComm");
    assert.equal(res.value[0].children[0].name, "JSCC");
    assert.equal(res.value[0].children[0].children[0].name, "Analog");
  }
});

test("validateTaxonomy: accepts the {taxonomy:[...]} wrapper form", () => {
  const res = validateTaxonomy({ taxonomy: fixtureTaxonomy() });
  assert.equal(res.ok, true);
});

test("validateTaxonomy: rejects empty names", () => {
  const bad = [
    {
      name: "  ",
      path: "  ",
      description: "",
      children: [],
    },
  ];
  const res = validateTaxonomy(bad);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.match(res.error, /empty or non-string name/);
  }
});

test("validateTaxonomy: rejects malformed paths", () => {
  const bad = [
    {
      name: "SemanticComm",
      path: "WrongRoot",
      description: "",
      children: [],
    },
  ];
  const res = validateTaxonomy(bad);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.match(res.error, /does not match expected/);
  }
});

test("validateTaxonomy: rejects depth > 3", () => {
  const bad: unknown = [
    {
      name: "A",
      path: "A",
      description: "",
      children: [
        {
          name: "B",
          path: "A/B",
          description: "",
          children: [
            {
              name: "C",
              path: "A/B/C",
              description: "",
              children: [
                {
                  name: "D",
                  path: "A/B/C/D",
                  description: "",
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    },
  ];
  const res = validateTaxonomy(bad);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.match(res.error, /exceeds max depth/);
  }
});

test("validateTaxonomy: rejects name containing '/'", () => {
  const bad = [
    {
      name: "A/B",
      path: "A/B",
      description: "",
      children: [],
    },
  ];
  const res = validateTaxonomy(bad);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.match(res.error, /contains a '\/'/);
  }
});

test("validateTaxonomy: rejects duplicate paths", () => {
  const bad = [
    {
      name: "A",
      path: "A",
      description: "",
      children: [
        {
          name: "A",
          path: "A/A",
          description: "",
          children: [],
        },
        {
          name: "A",
          path: "A/A",
          description: "",
          children: [],
        },
      ],
    },
  ];
  const res = validateTaxonomy(bad);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.match(res.error, /duplicate taxonomy path/);
  }
});

test("validateTaxonomy: rejects non-array, non-wrapper input", () => {
  const res = validateTaxonomy({ foo: 1 });
  assert.equal(res.ok, false);
});

test("validateTaxonomy: rejects empty taxonomy", () => {
  const res = validateTaxonomy([]);
  assert.equal(res.ok, false);
});

test("validateTaxonomy: rejects cycle-free but self-referential path via child echoing ancestor name is allowed", () => {
  // A child may legitimately share an ancestor's name (e.g. a sub-area named
  // like the parent). This is NOT a cycle and must be accepted as long as
  // paths differ.
  const ok = [
    {
      name: "ML",
      path: "ML",
      description: "",
      children: [
        {
          name: "ML",
          path: "ML/ML",
          description: "",
          children: [],
        },
      ],
    },
  ];
  const res = validateTaxonomy(ok);
  assert.equal(res.ok, true);
});

// --- validateAssignments --------------------------------------------------

test("validateAssignments: accepts valid assignments", () => {
  const valid = new Set(["SemanticComm", "SemanticComm/JSCC/Analog"]);
  const json = {
    assignments: [
      {
        itemId: 1,
        collectionPaths: ["SemanticComm/JSCC/Analog"],
        confidence: "high",
      },
      {
        itemId: 2,
        collectionPaths: ["SemanticComm"],
        confidence: "medium",
      },
    ],
  };
  const res = validateAssignments(json, valid);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.length, 2);
    assert.equal(res.value[0].collectionPaths[0], "SemanticComm/JSCC/Analog");
    assert.equal(res.value[0].confidence, "high");
    assert.deepEqual(res.droppedPaths, []);
  }
});

test("validateAssignments: accepts bare array form", () => {
  const valid = new Set(["A"]);
  const json = [
    { itemId: 1, collectionPaths: ["A"], confidence: "low" },
  ];
  const res = validateAssignments(json, valid);
  assert.equal(res.ok, true);
});

test("validateAssignments: filters out paths not in validPaths and records them", () => {
  const valid = new Set(["SemanticComm"]);
  const json = {
    assignments: [
      {
        itemId: 1,
        collectionPaths: ["SemanticComm", "DoesNotExist", "AlsoBad"],
        confidence: "high",
      },
    ],
  };
  const res = validateAssignments(json, valid);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.deepEqual(res.value[0].collectionPaths, ["SemanticComm"]);
    assert.deepEqual(res.droppedPaths, ["DoesNotExist", "AlsoBad"]);
    // Still high because at least one valid path remained.
    assert.equal(res.value[0].confidence, "high");
  }
});

test("validateAssignments: zero valid paths -> confidence low and empty paths", () => {
  const valid = new Set(["SemanticComm"]);
  const json = {
    assignments: [
      {
        itemId: 1,
        collectionPaths: ["Bad", "AlsoBad"],
        confidence: "high",
      },
    ],
  };
  const res = validateAssignments(json, valid);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.deepEqual(res.value[0].collectionPaths, []);
    assert.equal(res.value[0].confidence, "low");
  }
});

test("validateAssignments: missing confidence -> low", () => {
  const valid = new Set(["A"]);
  const json = [{ itemId: 1, collectionPaths: ["A"] }];
  const res = validateAssignments(json, valid);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value[0].confidence, "low");
  }
});

test("validateAssignments: invalid confidence string -> low", () => {
  const valid = new Set(["A"]);
  const json = [
    { itemId: 1, collectionPaths: ["A"], confidence: "very sure" },
  ];
  const res = validateAssignments(json, valid);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value[0].confidence, "low");
  }
});

test("validateAssignments: rejects non-numeric itemId", () => {
  const valid = new Set(["A"]);
  const json = [
    { itemId: "abc", collectionPaths: ["A"] },
  ];
  const res = validateAssignments(json, valid);
  assert.equal(res.ok, false);
});

test("validateAssignments: rejects non-array collectionPaths", () => {
  const valid = new Set(["A"]);
  const json = [
    { itemId: 1, collectionPaths: "A" },
  ];
  const res = validateAssignments(json, valid);
  assert.equal(res.ok, false);
});

test("validateAssignments: rejects non-array payload", () => {
  const res = validateAssignments({ foo: 1 }, new Set());
  assert.equal(res.ok, false);
});

// --- flattenTaxonomyPaths -------------------------------------------------

test("flattenTaxonomyPaths: returns all paths depth-first parent-before-child", () => {
  const paths = flattenTaxonomyPaths(fixtureTaxonomy());
  assert.deepEqual(paths, [
    "SemanticComm",
    "SemanticComm/JSCC",
    "SemanticComm/JSCC/Analog",
    "ChannelCoding",
  ]);
});

test("flattenTaxonomyPaths: empty taxonomy -> empty array", () => {
  assert.deepEqual(flattenTaxonomyPaths([]), []);
});

test("flattenTaxonomyPaths: single root -> [path]", () => {
  const t: TaxonomyNode[] = [
    { name: "Solo", path: "Solo", description: "", children: [] },
  ];
  assert.deepEqual(flattenTaxonomyPaths(t), ["Solo"]);
});

// --- extractJson ----------------------------------------------------------

test("extractJson: parses bare JSON object", () => {
  const res = extractJson('{"a":1}');
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.deepEqual(res.value, { a: 1 });
  }
});

test("extractJson: parses bare JSON array", () => {
  const res = extractJson("[1,2,3]");
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.deepEqual(res.value, [1, 2, 3]);
  }
});

test("extractJson: parses ```json fenced block", () => {
  const res = extractJson('Here you go:\n```json\n{"taxonomy":[]}\n```\n');
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.deepEqual(res.value, { taxonomy: [] });
  }
});

test("extractJson: parses bare ``` fenced block", () => {
  const res = extractJson('```\n[1,2]\n```');
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.deepEqual(res.value, [1, 2]);
  }
});

test("extractJson: extracts balanced object from surrounding prose", () => {
  const res = extractJson('Sure! {"a":{"b":2}} Hope that helps.');
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.deepEqual(res.value, { a: { b: 2 } });
  }
});

test("extractJson: handles braces inside strings", () => {
  const res = extractJson('{"s":"he said {not json}"}');
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.deepEqual((res.value as { s: string }).s, "he said {not json}");
  }
});

test("extractJson: rejects empty input", () => {
  const res = extractJson("   ");
  assert.equal(res.ok, false);
});

test("extractJson: rejects input with no JSON", () => {
  const res = extractJson("just prose, no json here");
  assert.equal(res.ok, false);
});
