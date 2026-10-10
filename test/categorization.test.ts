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
  findExistingNameCollisions,
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
  assert.ok(user.includes("ONLY the JSON"));
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
          name: "B",
          path: "A/B",
          description: "",
          children: [],
        },
        {
          name: "B",
          path: "A/B",
          description: "",
          children: [],
        },
      ],
    },
  ];
  const res = validateTaxonomy(bad);
  assert.equal(res.ok, false);
  if (!res.ok) {
    // Rejected because both children produce the same path "A/B".
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

test("validateTaxonomy: accepts duplicate leaf names with different paths", () => {
  // Two collections may share a leaf name if they have different parents
  // (e.g. "Wireless/MACProtocols" and "Wired/MACProtocols"). These are
  // legitimate distinct collections and must NOT be rejected — rejecting
  // them causes the LLM retry cascade to fail (the LLM loses context and
  // produces garbage on retry).
  const ok = [
    {
      name: "Wireless",
      path: "Wireless",
      description: "",
      children: [
        {
          name: "MACProtocols",
          path: "Wireless/MACProtocols",
          description: "",
          children: [],
        },
      ],
    },
    {
      name: "Wired",
      path: "Wired",
      description: "",
      children: [
        {
          name: "MACProtocols",
          path: "Wired/MACProtocols",
          description: "",
          children: [],
        },
      ],
    },
  ];
  const res = validateTaxonomy(ok);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.length, 2);
  }
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

test("validateAssignments: deduplicates duplicate valid paths within one assignment", () => {
  const valid = new Set(["A", "B"]);
  const json = [
    {
      itemId: 1,
      collectionPaths: ["A", "B", "A", "B", "A"],
      confidence: "high",
    },
  ];
  const res = validateAssignments(json, valid);
  assert.equal(res.ok, true);
  if (res.ok) {
    // Each valid path appears only once, in first-occurrence order.
    assert.deepEqual(res.value[0].collectionPaths, ["A", "B"]);
    // Duplicates of VALID paths are NOT recorded in droppedPaths.
    assert.deepEqual(res.droppedPaths, []);
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

// --- findExistingNameCollisions -------------------------------------------

test("findExistingNameCollisions: detects leaf-name collision at a different path", () => {
  // Existing library has a top-level "Theory" collection. The LLM taxonomy
  // proposes "SemanticComm/Theory". The applier would create a brand-new
  // "Theory" under "SemanticComm" — the duplicate-name bug.
  const tax: TaxonomyNode[] = [
    {
      name: "SemanticComm",
      path: "SemanticComm",
      description: "",
      children: [
        { name: "Theory", path: "SemanticComm/Theory", description: "", children: [] },
      ],
    },
  ];
  const existing = ["Theory", "SemanticComm"];
  const cols = findExistingNameCollisions(tax, existing);
  assert.equal(cols.length, 1);
  assert.equal(cols[0].taxPath, "SemanticComm/Theory");
  assert.equal(cols[0].taxLeafName, "Theory");
  assert.equal(cols[0].existingPath, "Theory");
});

test("findExistingNameCollisions: reuse at exact path is NOT a collision", () => {
  // The taxonomy node's full path exactly matches an existing path — the
  // applier will reuse the existing collection, not create a new one.
  const tax: TaxonomyNode[] = [
    { name: "Theory", path: "Theory", description: "", children: [] },
  ];
  const existing = ["Theory"];
  assert.deepEqual(findExistingNameCollisions(tax, existing), []);
});

test("findExistingNameCollisions: no collision when leaf name is unique", () => {
  const tax: TaxonomyNode[] = [
    { name: "ChannelCoding", path: "ChannelCoding", description: "", children: [] },
  ];
  const existing = ["Theory", "SemanticComm"];
  assert.deepEqual(findExistingNameCollisions(tax, existing), []);
});

test("findExistingNameCollisions: empty existing paths -> no collisions", () => {
  const tax: TaxonomyNode[] = [
    { name: "Theory", path: "Theory", description: "", children: [] },
  ];
  assert.deepEqual(findExistingNameCollisions(tax, []), []);
});

test("findExistingNameCollisions: empty taxonomy -> no collisions", () => {
  assert.deepEqual(findExistingNameCollisions([], ["Theory"]), []);
});

test("findExistingNameCollisions: reports all conflicting existing paths for one leaf", () => {
  // Two existing collections share the leaf name "Theory" (under different
  // parents); the taxonomy proposes a third "Theory" at a new path. All
  // conflicting existing paths are reported.
  const tax: TaxonomyNode[] = [
    { name: "Theory", path: "NewArea/Theory", description: "", children: [] },
  ];
  const existing = ["Theory", "OldArea/Theory"];
  const cols = findExistingNameCollisions(tax, existing);
  assert.equal(cols.length, 2);
  assert.ok(cols.every((c) => c.taxPath === "NewArea/Theory"));
  assert.ok(cols.every((c) => c.taxLeafName === "Theory"));
  const existingReported = cols.map((c) => c.existingPath).sort();
  assert.deepEqual(existingReported, ["OldArea/Theory", "Theory"]);
});

test("findExistingNameCollisions: detects collision at root level (top-level reuse of existing top-level name)", () => {
  // Existing library has top-level "ML"; taxonomy proposes a NEW top-level
  // "ML" — but since the path matches exactly, this is a reuse, NOT a
  // collision. (A same-path top-level node is reused.)
  const tax: TaxonomyNode[] = [
    { name: "ML", path: "ML", description: "", children: [] },
  ];
  assert.deepEqual(findExistingNameCollisions(tax, ["ML"]), []);
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
