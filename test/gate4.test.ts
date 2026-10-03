/**
 * No-network unit tests for the pure Gate 4 logic: snapshot serialization
 * (`revertSnapshot.ts`) and the collection-creation planner
 * (`planApplier.planCollectionCreation`).
 *
 * These import only the pure helpers (no Zotero globals, no config, no
 * network) so they run under plain Node with `--experimental-strip-types`.
 * The Zotero-touching functions (`captureSnapshot`, `revertFromSnapshot`,
 * `applyPlan`) are NOT exercised here — they require a live Zotero sandbox
 * and are validated by the manual verification steps in DEVELOPER_REPORT.md.
 *
 * Run with: node --test --experimental-strip-types test/gate4.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  serializeSnapshot,
  deserializeSnapshot,
  type RevertSnapshot,
} from "../src/modules/revertSnapshot.ts";
import { planCollectionCreation } from "../src/modules/planApplier.ts";
import type { TaxonomyNode } from "../src/modules/categorizationTypes.ts";

// --- fixtures --------------------------------------------------------------

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

function fixtureSnapshot(): RevertSnapshot {
  return {
    items: [
      { itemId: 101, collectionIDs: [1, 2] },
      { itemId: 102, collectionIDs: [] },
      { itemId: 103, collectionIDs: [5, 6, 7] },
    ],
    existingCollectionIDs: new Set<number>([1, 2, 5, 6, 7]),
    timestamp: "2026-09-27T12:00:00.000Z",
  };
}

// --- serializeSnapshot / deserializeSnapshot -------------------------------

test("serializeSnapshot/deserializeSnapshot: round-trip preserves data", () => {
  const original = fixtureSnapshot();
  const json = serializeSnapshot(original);
  const restored = deserializeSnapshot(json);

  assert.deepEqual(restored.items, original.items);
  assert.deepEqual(
    [...restored.existingCollectionIDs].sort((a, b) => a - b),
    [...original.existingCollectionIDs].sort((a, b) => a - b),
  );
  assert.equal(restored.timestamp, original.timestamp);
});

test("serializeSnapshot: existingCollectionIDs is a sorted array in the JSON", () => {
  const snap: RevertSnapshot = {
    items: [],
    existingCollectionIDs: new Set<number>([7, 2, 5, 1, 6]),
    timestamp: "t",
  };
  const json = serializeSnapshot(json_safe(snap));
  const parsed = JSON.parse(json);
  assert.deepEqual(parsed.existingCollectionIDs, [1, 2, 5, 6, 7]);
});

test("serializeSnapshot: items collectionIDs are copied (not the same array ref)", () => {
  const snap = fixtureSnapshot();
  const json = serializeSnapshot(snap);
  // Mutate the original after serialization; the deserialized copy must reflect
  // the pre-mutation state captured in the JSON, not the live mutation.
  snap.items[0].collectionIDs.push(999);
  const restored = deserializeSnapshot(json);
  assert.deepEqual(
    restored.items,
    [
      { itemId: 101, collectionIDs: [1, 2] },
      { itemId: 102, collectionIDs: [] },
      { itemId: 103, collectionIDs: [5, 6, 7] },
    ],
  );
});

test("deserializeSnapshot: rebuilds a Set for existingCollectionIDs", () => {
  const restored = deserializeSnapshot(
    JSON.stringify({
      items: [],
      existingCollectionIDs: [3, 1, 2],
      timestamp: "x",
    }),
  );
  assert.ok(restored.existingCollectionIDs instanceof Set);
  assert.equal(restored.existingCollectionIDs.size, 3);
  assert.ok(restored.existingCollectionIDs.has(1));
  assert.ok(restored.existingCollectionIDs.has(2));
  assert.ok(restored.existingCollectionIDs.has(3));
});

test("deserializeSnapshot: handles empty items and empty existingCollectionIDs", () => {
  const restored = deserializeSnapshot(
    JSON.stringify({
      items: [],
      existingCollectionIDs: [],
      timestamp: "",
    }),
  );
  assert.deepEqual(restored.items, []);
  assert.equal(restored.existingCollectionIDs.size, 0);
  assert.equal(restored.timestamp, "");
});

test("deserializeSnapshot: handles item with empty collectionIDs (unfiled)", () => {
  const restored = deserializeSnapshot(
    JSON.stringify({
      items: [{ itemId: 42, collectionIDs: [] }],
      existingCollectionIDs: [1],
      timestamp: "t",
    }),
  );
  assert.deepEqual(restored.items, [{ itemId: 42, collectionIDs: [] }]);
});

test("deserializeSnapshot: throws on non-object root", () => {
  assert.throws(
    () => deserializeSnapshot(JSON.stringify("not an object")),
    /not an object/i,
  );
  assert.throws(
    () => deserializeSnapshot(JSON.stringify(null)),
    /not an object/i,
  );
  assert.throws(
    () => deserializeSnapshot(JSON.stringify(42)),
    /not an object/i,
  );
});

test("deserializeSnapshot: throws when items is not an array", () => {
  assert.throws(
    () =>
      deserializeSnapshot(
        JSON.stringify({ items: "nope", existingCollectionIDs: [], timestamp: "" }),
      ),
    /items is not an array/i,
  );
});

test("deserializeSnapshot: throws when an item.itemId is non-numeric", () => {
  assert.throws(
    () =>
      deserializeSnapshot(
        JSON.stringify({
          items: [{ itemId: "abc", collectionIDs: [] }],
          existingCollectionIDs: [],
          timestamp: "",
        }),
      ),
    /itemId is not a finite number/i,
  );
});

test("deserializeSnapshot: throws when an item.collectionIDs is not an array", () => {
  assert.throws(
    () =>
      deserializeSnapshot(
        JSON.stringify({
          items: [{ itemId: 1, collectionIDs: "nope" }],
          existingCollectionIDs: [],
          timestamp: "",
        }),
      ),
    /collectionIDs is not an array/i,
  );
});

test("deserializeSnapshot: throws when a collectionID is non-numeric", () => {
  assert.throws(
    () =>
      deserializeSnapshot(
        JSON.stringify({
          items: [{ itemId: 1, collectionIDs: [1, "x"] }],
          existingCollectionIDs: [],
          timestamp: "",
        }),
      ),
    /collectionIDs\[1\] is not a finite number/i,
  );
});

test("deserializeSnapshot: throws when existingCollectionIDs is not an array", () => {
  assert.throws(
    () =>
      deserializeSnapshot(
        JSON.stringify({ items: [], existingCollectionIDs: "nope", timestamp: "" }),
      ),
    /existingCollectionIDs is not an array/i,
  );
});

test("deserializeSnapshot: throws on malformed JSON", () => {
  assert.throws(() => deserializeSnapshot("{not json"), SyntaxError);
});

test("deserializeSnapshot: tolerates missing timestamp (defaults to empty string)", () => {
  const restored = deserializeSnapshot(
    JSON.stringify({ items: [], existingCollectionIDs: [] }),
  );
  assert.equal(restored.timestamp, "");
});

test("serializeSnapshot: produces stable, sorted JSON (deterministic)", () => {
  const snap = fixtureSnapshot();
  const a = serializeSnapshot(snap);
  const b = serializeSnapshot(snap);
  assert.equal(a, b);
});

// --- planCollectionCreation ------------------------------------------------

test("planCollectionCreation: all paths to create when nothing exists", () => {
  const { toCreate, toReuse } = planCollectionCreation(
    fixtureTaxonomy(),
    [],
  );
  assert.deepEqual(toCreate, [
    "SemanticComm",
    "SemanticComm/JSCC",
    "SemanticComm/JSCC/Analog",
    "ChannelCoding",
  ]);
  assert.deepEqual(toReuse, []);
});

test("planCollectionCreation: all paths to reuse when everything exists", () => {
  const existing = [
    "SemanticComm",
    "SemanticComm/JSCC",
    "SemanticComm/JSCC/Analog",
    "ChannelCoding",
  ];
  const { toCreate, toReuse } = planCollectionCreation(
    fixtureTaxonomy(),
    existing,
  );
  assert.deepEqual(toCreate, []);
  assert.deepEqual(toReuse, existing);
});

test("planCollectionCreation: mixed create + reuse", () => {
  const existing = ["SemanticComm", "ChannelCoding"];
  const { toCreate, toReuse } = planCollectionCreation(
    fixtureTaxonomy(),
    existing,
  );
  // Reuse order follows flattenTaxonomyPaths (depth-first parent-before-child),
  // so reused paths appear in the order they're encountered in the walk.
  assert.deepEqual(toReuse, ["SemanticComm", "ChannelCoding"]);
  assert.deepEqual(toCreate, [
    "SemanticComm/JSCC",
    "SemanticComm/JSCC/Analog",
  ]);
});

test("planCollectionCreation: toCreate is in dependency order (parents before children)", () => {
  // A caller creating `toCreate` in order will always know the parent ID
  // before reaching a child. Verify the invariant explicitly.
  const { toCreate } = planCollectionCreation(fixtureTaxonomy(), []);
  for (let i = 0; i < toCreate.length; i++) {
    const path = toCreate[i];
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
    if (parent !== null) {
      const parentIdx = toCreate.indexOf(parent);
      assert.ok(
        parentIdx >= 0 && parentIdx < i,
        `parent "${parent}" of "${path}" must appear before it in toCreate`,
      );
    }
  }
});

test("planCollectionCreation: empty taxonomy -> empty create + reuse", () => {
  const { toCreate, toReuse } = planCollectionCreation([], []);
  assert.deepEqual(toCreate, []);
  assert.deepEqual(toReuse, []);
});

test("planCollectionCreation: existingPaths with extras not in taxonomy are ignored", () => {
  const existing = [
    "SemanticComm",
    "DoesNotExist",
    "AlsoExtra",
  ];
  const { toCreate, toReuse } = planCollectionCreation(
    fixtureTaxonomy(),
    existing,
  );
  // Only paths that ARE in the taxonomy are reused; extras are ignored.
  assert.deepEqual(toReuse, ["SemanticComm"]);
  assert.ok(!toReuse.includes("DoesNotExist"));
  assert.ok(!toReuse.includes("AlsoExtra"));
  assert.deepEqual(toCreate, [
    "SemanticComm/JSCC",
    "SemanticComm/JSCC/Analog",
    "ChannelCoding",
  ]);
});

test("planCollectionCreation: single root -> [path]", () => {
  const t: TaxonomyNode[] = [
    { name: "Solo", path: "Solo", description: "", children: [] },
  ];
  const { toCreate, toReuse } = planCollectionCreation(t, []);
  assert.deepEqual(toCreate, ["Solo"]);
  assert.deepEqual(toReuse, []);
});

test("planCollectionCreation: single root already exists -> reuse", () => {
  const t: TaxonomyNode[] = [
    { name: "Solo", path: "Solo", description: "", children: [] },
  ];
  const { toCreate, toReuse } = planCollectionCreation(t, ["Solo"]);
  assert.deepEqual(toCreate, []);
  assert.deepEqual(toReuse, ["Solo"]);
});

test("planCollectionCreation: dedupes if existingPaths contains duplicates", () => {
  // flattenTaxonomyPaths produces unique paths; if existingPaths has dups, the
  // Set dedupes them so we don't get duplicate entries in toReuse.
  const existing = ["SemanticComm", "SemanticComm"];
  const { toReuse } = planCollectionCreation(fixtureTaxonomy(), existing);
  assert.deepEqual(toReuse, ["SemanticComm"]);
});

// --- helper ----------------------------------------------------------------

/**
 * Identity helper used in the "sorted array" test to make the intent explicit:
 * we pass a snapshot whose existingCollectionIDs Set is in arbitrary order and
 * verify the JSON has them sorted. The function is a no-op pass-through.
 */
function json_safe(snap: RevertSnapshot): RevertSnapshot {
  return snap;
}
