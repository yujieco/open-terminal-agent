// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

/**
 * Pane tree for one tab.
 *
 * A tab owns a tree rather than a single session, which is what makes split
 * panes possible without duplicating session state: leaves reference session ids
 * that the app already manages, so every pane keeps its own backend, shadow
 * screen and scrollback.
 *
 * Everything here is pure and immutable: callers get a new tree and decide when
 * to re-render.
 */

export type SplitDirection = "row" | "column";

export interface LeafNode {
  kind: "leaf";
  sessionId: string;
}

export interface SplitNode {
  kind: "split";
  /** `row` splits left/right, `column` splits top/bottom. */
  direction: SplitDirection;
  /** Share of the space given to `first`, clamped to a usable range. */
  ratio: number;
  first: PaneNode;
  second: PaneNode;
}

export type PaneNode = LeafNode | SplitNode;

/** Smallest and largest share a pane may take. */
export const MIN_RATIO = 0.15;
export const MAX_RATIO = 0.85;

export function leaf(sessionId: string): LeafNode {
  return { kind: "leaf", sessionId };
}

/** Clamps a ratio so a pane can never be dragged out of existence. */
export function clampRatio(ratio: number): number {
  if (Number.isNaN(ratio)) return 0.5;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

/** Session ids in visual order, left-to-right then top-to-bottom. */
export function sessionIds(node: PaneNode): string[] {
  return node.kind === "leaf"
    ? [node.sessionId]
    : [...sessionIds(node.first), ...sessionIds(node.second)];
}

/** Whether `sessionId` is present in the tree. */
export function contains(node: PaneNode, sessionId: string): boolean {
  return sessionIds(node).includes(sessionId);
}

/**
 * Splits the pane holding `targetSessionId`, putting `newSessionId` after it.
 * Returns `null` when the target is not in the tree, so callers can report the
 * mistake instead of silently growing an unrelated pane.
 */
export function split(
  node: PaneNode,
  targetSessionId: string,
  newSessionId: string,
  direction: SplitDirection,
): PaneNode | null {
  if (node.kind === "leaf") {
    if (node.sessionId !== targetSessionId) return null;
    return {
      kind: "split",
      direction,
      ratio: 0.5,
      first: node,
      second: leaf(newSessionId),
    };
  }

  if (contains(node.first, targetSessionId)) {
    const updated = split(node.first, targetSessionId, newSessionId, direction);
    return updated === null ? null : { ...node, first: updated };
  }
  if (contains(node.second, targetSessionId)) {
    const updated = split(node.second, targetSessionId, newSessionId, direction);
    return updated === null ? null : { ...node, second: updated };
  }
  return null;
}

/**
 * Removes one pane and collapses its parent into the surviving sibling.
 * Returns `null` when that was the last pane, which is the caller's signal to
 * close the tab.
 */
export function remove(node: PaneNode, sessionId: string): PaneNode | null {
  if (node.kind === "leaf") {
    return node.sessionId === sessionId ? null : node;
  }

  if (node.first.kind === "leaf" && node.first.sessionId === sessionId) {
    return node.second;
  }
  if (node.second.kind === "leaf" && node.second.sessionId === sessionId) {
    return node.first;
  }

  if (contains(node.first, sessionId)) {
    const updated = remove(node.first, sessionId);
    if (updated === null) return node.second;
    return { ...node, first: updated };
  }
  if (contains(node.second, sessionId)) {
    const updated = remove(node.second, sessionId);
    if (updated === null) return node.first;
    return { ...node, second: updated };
  }
  return node;
}

/**
 * Adjusts the ratio of the split at `path` (0 = first child, 1 = second child).
 * An invalid path returns the tree unchanged.
 */
export function setRatio(node: PaneNode, path: readonly number[], ratio: number): PaneNode {
  if (node.kind === "leaf" || path.length === 0) {
    if (node.kind === "leaf") return node;
    return { ...node, ratio: clampRatio(ratio) };
  }

  const [head, ...rest] = path;
  if (head === 0) {
    return { ...node, first: setRatio(node.first, rest, ratio) };
  }
  if (head === 1) {
    return { ...node, second: setRatio(node.second, rest, ratio) };
  }
  return node;
}

/**
 * Picks the pane that should hold focus: the requested one when it still exists,
 * otherwise the first pane in visual order.
 */
export function focusable(node: PaneNode, requested: string | null): string | null {
  if (requested !== null && contains(node, requested)) return requested;
  return sessionIds(node)[0] ?? null;
}
