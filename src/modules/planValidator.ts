/**
 * Pure validators for the LLM-produced JSON in the two-stage categorization
 * pipeline (Gate 3).
 *
 * Every function here is dependency-free (only imports the interface-only
 * `categorizationTypes.ts`) and runs under plain Node with no Zotero / no
 * network, so the validators are fully unit-testable as required by the work
 * order.
 *
 * The validators are intentionally strict about structure but lenient about
 * extras: unknown object keys are ignored (LLMs sometimes add helpful
 * commentary fields). They never throw; they return a discriminated result so
 * callers can drive the retry loop without try/catch noise.
 */

import type { ItemAssignment, TaxonomyNode } from "./categorizationTypes";

/**
 * Extract a JSON value from an LLM text response that may be wrapped in
 * markdown code fences or surrounded by stray prose.
 *
 * Strategy (in order):
 *  1. Try `JSON.parse(text)` directly (the strict-spec case).
 *  2. If that fails, look for the first ```json ... ``` (or ``` ... ```) fenced
 *     block and parse its contents.
 *  3. Otherwise, find the first balanced `{` ... `}` or `[` ... `]` substring
 *     and parse that.
 *
 * Returns `{ok: true, value}` on success or `{ok: false, error}`. Pure, never
 * throws. Exported so the stage modules share one extraction strategy and so
 * the strategy itself is unit-testable.
 */
export function extractJson(text: string): ValidationResult<unknown> {
  const trimmed = (text ?? "").trim();
  if (!trimmed) {
    return { ok: false, error: "empty response" };
  }

  // 1. Direct parse.
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    // fall through
  }

  // 2. Fenced code block.
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    try {
      return { ok: true, value: JSON.parse(fenceMatch[1].trim()) };
    } catch (e) {
      return {
        ok: false,
        error: `fenced block was not valid JSON: ${(e as Error).message}`,
      };
    }
  }

  // 3. First balanced object/array substring.
  const start = trimmed.search(/[{[]/);
  if (start === -1) {
    return { ok: false, error: "no JSON object or array found in response" };
  }
  const open = trimmed[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) {
        const candidate = trimmed.slice(start, i + 1);
        try {
          return { ok: true, value: JSON.parse(candidate) };
        } catch (e) {
          return {
            ok: false,
            error: `extracted substring was not valid JSON: ${(e as Error).message}`,
          };
        }
      }
    }
  }
  return { ok: false, error: "unbalanced JSON in response" };
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/** Maximum allowed depth of the taxonomy tree (root / child / grandchild). */
export const MAX_TAXONOMY_DEPTH = 3;

/**
 * Recursively validate one `TaxonomyNode` candidate and return a sanitized
 * node (with non-string fields coerced and unknown keys dropped) or an error.
 *
 * `parentPath` is the path the node MUST report (root nodes report their own
 * name; children report `parentPath + '/' + name`). `depth` is 1-indexed.
 */
function validateNode(
  raw: unknown,
  parentPath: string,
  depth: number,
): ValidationResult<TaxonomyNode> {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: `node at depth ${depth} is not an object` };
  }
  const obj = raw as Record<string, unknown>;

  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  if (!name) {
    return {
      ok: false,
      error: `node at depth ${depth} has empty or non-string name`,
    };
  }
  // Reject path component separators inside a name (would break the path
  // invariant that path === join(names, '/')).
  if (name.includes("/")) {
    return {
      ok: false,
      error: `node name "${name}" contains a '/'`,
    };
  }

  const expectedPath =
    parentPath === "" ? name : `${parentPath}/${name}`;

  const rawPath = typeof obj.path === "string" ? obj.path.trim() : "";
  if (rawPath !== expectedPath) {
    return {
      ok: false,
      error: `node "${name}" path "${rawPath}" does not match expected "${expectedPath}"`,
    };
  }

  const description =
    typeof obj.description === "string" ? obj.description : "";

  const children: TaxonomyNode[] = [];
  const rawChildren = obj.children;
  if (rawChildren !== undefined && rawChildren !== null) {
    if (!Array.isArray(rawChildren)) {
      return {
        ok: false,
        error: `node "${name}" children is not an array`,
      };
    }
    if (depth >= MAX_TAXONOMY_DEPTH && rawChildren.length > 0) {
      return {
        ok: false,
        error: `node "${name}" exceeds max depth ${MAX_TAXONOMY_DEPTH}`,
      };
    }
    for (let i = 0; i < rawChildren.length; i++) {
      const child = validateNode(rawChildren[i], expectedPath, depth + 1);
      if (!child.ok) {
        return child;
      }
      children.push(child.value);
    }
  }

  // Cycle detection: paths must be unique across the whole tree. We check
  // here by ensuring a child's path never equals one of its ancestors; the
  // recursive path-prefix rule makes self-cycles impossible (a node's path is
  // derived from its name, and names can't contain '/'), but a child could
  // echo an ancestor name — which is fine and common, so no false positives.
  return { ok: true, value: { name, path: expectedPath, description, children } };
}

/**
 * Validate an LLM-produced taxonomy payload.
 *
 * Accepts either:
 *  - an array of nodes (treated as the root list), or
 *  - an object `{ taxonomy: [...] }` (the strict schema form).
 *
 * Structural checks: non-empty names, well-formed paths, max depth 3, no
 * duplicate paths, acyclic (guaranteed by construction since paths are
 * derived). Returns the sanitized `TaxonomyNode[]` on success.
 */
export function validateTaxonomy(json: unknown): ValidationResult<TaxonomyNode[]> {
  let roots: unknown[];
  if (Array.isArray(json)) {
    roots = json;
  } else if (
    json &&
    typeof json === "object" &&
    Array.isArray((json as Record<string, unknown>).taxonomy)
  ) {
    roots = (json as Record<string, unknown>).taxonomy as unknown[];
  } else {
    return {
      ok: false,
      error: "taxonomy payload is not an array and has no `taxonomy` array",
    };
  }

  if (roots.length === 0) {
    return { ok: false, error: "taxonomy is empty" };
  }

  const seenPaths = new Set<string>();
  const out: TaxonomyNode[] = [];
  for (let i = 0; i < roots.length; i++) {
    const res = validateNode(roots[i], "", 1);
    if (!res.ok) {
      return { ok: false, error: `root[${i}]: ${res.error}` };
    }
    // Walk the subtree collecting/deduping paths.
    const stack: TaxonomyNode[] = [res.value];
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (seenPaths.has(n.path)) {
        return {
          ok: false,
          error: `duplicate taxonomy path "${n.path}"`,
        };
      }
      seenPaths.add(n.path);
      for (const c of n.children) {
        stack.push(c);
      }
    }
    out.push(res.value);
  }

  return { ok: true, value: out };
}

/**
 * Validate an LLM-produced classification payload for one batch.
 *
 * Accepts either an array of assignment objects or `{ assignments: [...] }`.
 * Each assignment must have a numeric `itemId` and an array of
 * `collectionPaths`. `validPaths` is the set of paths that exist in the
 * taxonomy; any assignment path NOT in this set is DROPPED (with the dropped
 * paths recorded so the caller can log a warning), per the work order's
 * "filter, do not throw" rule. If an assignment ends up with zero valid
 * paths, its `confidence` is forced to "low" and `collectionPaths` to `[]`.
 *
 * `confidence` is coerced to one of the three allowed values; anything else
 * (including missing) becomes "low".
 */
export function validateAssignments(
  json: unknown,
  validPaths: Set<string>,
): {
  ok: true;
  value: ItemAssignment[];
  droppedPaths: string[];
} | {
  ok: false;
  error: string;
} {
  let arr: unknown[];
  if (Array.isArray(json)) {
    arr = json;
  } else if (
    json &&
    typeof json === "object" &&
    Array.isArray((json as Record<string, unknown>).assignments)
  ) {
    arr = (json as Record<string, unknown>).assignments as unknown[];
  } else {
    return {
      ok: false,
      error:
        "classification payload is not an array and has no `assignments` array",
    };
  }

  const droppedPaths: string[] = [];
  const out: ItemAssignment[] = [];
  for (let i = 0; i < arr.length; i++) {
    const raw = arr[i];
    if (!raw || typeof raw !== "object") {
      return {
        ok: false,
        error: `assignment[${i}] is not an object`,
      };
    }
    const obj = raw as Record<string, unknown>;
    const itemId = typeof obj.itemId === "number" ? obj.itemId : Number(obj.itemId);
    if (!Number.isFinite(itemId)) {
      return {
        ok: false,
        error: `assignment[${i}] has non-numeric itemId`,
      };
    }

    const title =
      typeof obj.title === "string" ? obj.title : "";

    const rawPaths = obj.collectionPaths;
    if (!Array.isArray(rawPaths)) {
      return {
        ok: false,
        error: `assignment[${i}] (itemId ${itemId}) collectionPaths is not an array`,
      };
    }
    const keptPaths: string[] = [];
    for (const p of rawPaths) {
      if (typeof p !== "string") {
        continue;
      }
      if (validPaths.has(p)) {
        keptPaths.push(p);
      } else {
        droppedPaths.push(p);
      }
    }

    const rawConfidence = typeof obj.confidence === "string" ? obj.confidence : "";
    const confidence: ItemAssignment["confidence"] =
      rawConfidence === "high" || rawConfidence === "medium"
        ? rawConfidence
        : "low";

    out.push({
      itemId,
      title,
      collectionPaths: keptPaths.length > 0 ? keptPaths : [],
      confidence: keptPaths.length > 0 ? confidence : "low",
    });
  }

  return { ok: true, value: out, droppedPaths };
}

/**
 * Flatten a taxonomy tree into the list of every path it contains (root and
 * leaf, all depths). Order is depth-first, parent-before-child. Pure.
 */
export function flattenTaxonomyPaths(taxonomy: TaxonomyNode[]): string[] {
  const out: string[] = [];
  const stack: TaxonomyNode[] = [...taxonomy].reverse();
  while (stack.length > 0) {
    const n = stack.pop()!;
    out.push(n.path);
    for (let i = n.children.length - 1; i >= 0; i--) {
      stack.push(n.children[i]);
    }
  }
  return out;
}
