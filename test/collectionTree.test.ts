/**
 * No-network unit tests for the pure collection-path builder and the stable
 * library serializer.
 *
 * These import only dependency-free logic (no Zotero globals, no config) so
 * they run under plain Node with `--experimental-strip-types`.
 *
 * Run with: node --test --experimental-strip-types test/collectionTree.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCollectionPath,
  type CollectionNode,
} from "../src/modules/collectionTree.ts";
import {
  serializeLibrary,
  summarizeLibrary,
  type LibraryItem,
} from "../src/modules/libraryModel.ts";

// --- buildCollectionPath --------------------------------------------------

test("buildCollectionPath: nested path A -> B -> C returns 'A/B/C'", () => {
  const nodes = new Map<number, CollectionNode>([
    [1, { id: 1, name: "A", parentID: false }],
    [2, { id: 2, name: "B", parentID: 1 }],
    [3, { id: 3, name: "C", parentID: 2 }],
  ]);
  const lookup = (id: number) => nodes.get(id);
  assert.equal(buildCollectionPath(3, lookup), "A/B/C");
});

test("buildCollectionPath: root-level collection returns just its name", () => {
  const nodes = new Map<number, CollectionNode>([
    [10, { id: 10, name: "SemanticComm", parentID: false }],
  ]);
  const lookup = (id: number) => nodes.get(id);
  assert.equal(buildCollectionPath(10, lookup), "SemanticComm");
});

test("buildCollectionPath: parentID 0 is treated as root", () => {
  const nodes = new Map<number, CollectionNode>([
    [20, { id: 20, name: "Root", parentID: 0 }],
  ]);
  const lookup = (id: number) => nodes.get(id);
  assert.equal(buildCollectionPath(20, lookup), "Root");
});

test("buildCollectionPath: missing collection (lookup undefined) returns ''", () => {
  const lookup = (_id: number) => undefined;
  assert.equal(buildCollectionPath(999, lookup), "");
});

test("buildCollectionPath: cycle A -> B -> A throws", () => {
  const nodes = new Map<number, CollectionNode>([
    [1, { id: 1, name: "A", parentID: 2 }],
    [2, { id: 2, name: "B", parentID: 1 }],
  ]);
  const lookup = (id: number) => nodes.get(id);
  assert.throws(
    () => buildCollectionPath(1, lookup),
    /cycle/i,
  );
});

test("buildCollectionPath: deeper nesting 4 levels", () => {
  const nodes = new Map<number, CollectionNode>([
    [1, { id: 1, name: "SemanticComm", parentID: false }],
    [2, { id: 2, name: "JSCC", parentID: 1 }],
    [3, { id: 3, name: "Analog", parentID: 2 }],
    [4, { id: 4, name: "Feedback", parentID: 3 }],
  ]);
  const lookup = (id: number) => nodes.get(id);
  assert.equal(buildCollectionPath(4, lookup), "SemanticComm/JSCC/Analog/Feedback");
});

// --- serializeLibrary -----------------------------------------------------

function fixtureItem(overrides: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: 1,
    key: "ABCD1234",
    itemType: "journalArticle",
    title: "A Paper",
    abstract: "An abstract.",
    date: "2024-01-01",
    doi: "10.1000/xyz",
    publicationTitle: "Nature",
    creators: [
      { firstName: "Alice", lastName: "Smith", creatorType: "author" },
    ],
    tags: ["wireless", "jscc"],
    attachmentCount: 2,
    collectionPaths: ["SemanticComm/JSCC/Analog", "PureML/LLM"],
    ...overrides,
  };
}

test("serializeLibrary: produces valid JSON with sorted object keys", () => {
  const items = [fixtureItem()];
  const json = serializeLibrary(items);
  const parsed = JSON.parse(json);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 1);

  // Top-level item keys must be sorted alphabetically.
  const itemKeys = Object.keys(parsed[0]);
  assert.deepEqual(
    itemKeys,
    [...itemKeys].sort(),
    "top-level keys must be sorted",
  );
});

test("serializeLibrary: contains all expected LibraryItem fields", () => {
  const items = [fixtureItem()];
  const parsed = JSON.parse(serializeLibrary(items))[0];
  const expectedKeys = [
    "abstract",
    "attachmentCount",
    "collectionPaths",
    "creators",
    "date",
    "doi",
    "id",
    "itemType",
    "key",
    "publicationTitle",
    "tags",
    "title",
  ];
  assert.deepEqual(Object.keys(parsed).sort(), expectedKeys);
  assert.equal(parsed.id, 1);
  assert.equal(parsed.key, "ABCD1234");
  assert.equal(parsed.title, "A Paper");
  assert.deepEqual(parsed.tags, ["wireless", "jscc"]);
  assert.deepEqual(parsed.collectionPaths, [
    "SemanticComm/JSCC/Analog",
    "PureML/LLM",
  ]);
});

test("serializeLibrary: is stable (same input -> identical output)", () => {
  const items = [fixtureItem({ id: 5 }), fixtureItem({ id: 2, title: "B" })];
  const a = serializeLibrary(items);
  const b = serializeLibrary(items);
  assert.equal(a, b);
});

test("serializeLibrary: empty array produces '[]'", () => {
  assert.equal(serializeLibrary([]), "[]");
});

test("serializeLibrary: nested object keys (creators[0]) are sorted", () => {
  const items = [
    fixtureItem({
      creators: [
        { firstName: "Zoe", lastName: "Zhang", creatorType: "author" },
      ],
    }),
  ];
  const parsed = JSON.parse(serializeLibrary(items))[0];
  const creatorKeys = Object.keys(parsed.creators[0]);
  assert.deepEqual(creatorKeys, [...creatorKeys].sort());
});

// --- summarizeLibrary -----------------------------------------------------

test("summarizeLibrary: counts abstract/doi/tag/attachment and unfiled", () => {
  const items: LibraryItem[] = [
    fixtureItem({ id: 1 }), // has everything, filed
    fixtureItem({
      id: 2,
      abstract: "",
      doi: "",
      tags: [],
      attachmentCount: 0,
      collectionPaths: [],
    }), // unfiled, no metadata
    fixtureItem({ id: 3, collectionPaths: [] }), // unfiled but has metadata
    fixtureItem({
      id: 4,
      collectionPaths: ["SemanticComm/JSCC/Analog"],
    }), // filed
  ];
  const s = summarizeLibrary(items);
  assert.equal(s.total, 4);
  assert.equal(s.withAbstract, 3);
  assert.equal(s.withDoi, 3);
  assert.equal(s.withTag, 3);
  assert.equal(s.withAttachment, 3);
  assert.equal(s.unfiled, 2);
});

test("summarizeLibrary: top 5 collection paths by count, sorted desc", () => {
  const items: LibraryItem[] = [];
  for (let i = 0; i < 3; i++) {
    items.push(fixtureItem({ id: i, collectionPaths: ["A"] }));
  }
  for (let i = 3; i < 5; i++) {
    items.push(fixtureItem({ id: i, collectionPaths: ["B"] }));
  }
  items.push(fixtureItem({ id: 5, collectionPaths: ["C"] }));
  const s = summarizeLibrary(items);
  assert.equal(s.topCollectionPaths.length, 3);
  assert.equal(s.topCollectionPaths[0].path, "A");
  assert.equal(s.topCollectionPaths[0].count, 3);
  assert.equal(s.topCollectionPaths[1].path, "B");
  assert.equal(s.topCollectionPaths[1].count, 2);
  assert.equal(s.topCollectionPaths[2].path, "C");
  assert.equal(s.topCollectionPaths[2].count, 1);
});
