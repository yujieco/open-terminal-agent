// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

/** True on macOS / iOS WebViews where Command (⌘) is the primary modifier key. */
export const isMac: boolean =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);

/** Formats a cross-platform shortcut label (`⌘D` / `⇧⌘D` on macOS, `Ctrl+D` / `Ctrl+Shift+D` on Windows/Linux). */
export function formatShortcut(key: string, shift = false): string {
  const upper = key.toUpperCase();
  if (isMac) {
    return shift ? `⇧⌘${upper}` : `⌘${upper}`;
  }
  return shift ? `Ctrl+Shift+${upper}` : `Ctrl+${upper}`;
}
