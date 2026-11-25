// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { formatShortcut } from "../lib/platform";

interface GlobalContextMenuProps {
  onFavoriteCommand: (command: string) => void;
}

type EditableElement = HTMLInputElement | HTMLTextAreaElement;

interface MenuState {
  x: number;
  y: number;
  editable: EditableElement | null;
  selectedText: string;
}

function findEditable(target: EventTarget | null): EditableElement | null {
  if (!(target instanceof HTMLElement)) return null;
  if (target instanceof HTMLTextAreaElement) return target;
  if (target instanceof HTMLInputElement) {
    const type = target.type.toLowerCase();
    if (["text", "search", "password", "url", "email", "number"].includes(type)) {
      return target;
    }
  }
  return null;
}

function setNativeValue(element: EditableElement, value: string): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  descriptor?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Intercepts unhandled right-clicks across the workbench so the native English
 * WebView menu ("Reload / Inspect Element") never leaks into sidebars or panels,
 * while providing a localized edit/copy menu whenever text or inputs are targeted.
 */
export function GlobalContextMenu({ onFavoriteCommand }: GlobalContextMenuProps) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<MenuState | null>(null);

  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      event.preventDefault();

      const editable = findEditable(event.target);
      let selectedText = "";
      if (editable) {
        const start = editable.selectionStart ?? 0;
        const end = editable.selectionEnd ?? 0;
        if (end > start) {
          selectedText = editable.value.slice(start, end);
        }
      } else {
        selectedText = window.getSelection()?.toString() ?? "";
      }

      if (!editable && selectedText.trim().length === 0) {
        setMenu(null);
        return;
      }

      setMenu({
        x: Math.min(event.clientX, window.innerWidth - 192),
        y: Math.min(event.clientY, window.innerHeight - 170),
        editable,
        selectedText,
      });
    };

    const close = () => setMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };

    window.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  if (!menu) return null;

  const hasSelection = menu.selectedText.length > 0;
  const trimmedSelection = menu.selectedText.trim();

  const handleCopy = async () => {
    if (!hasSelection) return;
    try {
      await navigator.clipboard.writeText(menu.selectedText);
    } catch {
      document.execCommand("copy");
    }
    setMenu(null);
  };

  const handleCut = async () => {
    const el = menu.editable;
    if (!el || !hasSelection) return;
    try {
      await navigator.clipboard.writeText(menu.selectedText);
    } catch {
      // Clipboard may be unavailable; still remove selected text.
    }
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    const next = el.value.slice(0, start) + el.value.slice(end);
    setNativeValue(el, next);
    el.focus();
    el.setSelectionRange(start, start);
    setMenu(null);
  };

  const handlePaste = async () => {
    const el = menu.editable;
    if (!el) return;
    try {
      const clip = await navigator.clipboard.readText();
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      const next = el.value.slice(0, start) + clip + el.value.slice(end);
      setNativeValue(el, next);
      el.focus();
      const caret = start + clip.length;
      el.setSelectionRange(caret, caret);
    } catch {
      el.focus();
      document.execCommand("paste");
    }
    setMenu(null);
  };

  const handleSelectAll = () => {
    const el = menu.editable;
    if (!el) return;
    el.focus();
    el.select();
    setMenu(null);
  };

  return (
    <div
      onMouseDown={(event) => event.stopPropagation()}
      className="fixed z-50 w-44 overflow-hidden rounded-lg border border-[var(--border-strong)] py-1 shadow-xl backdrop-blur-xl"
      style={{
        left: menu.x,
        top: menu.y,
        backgroundColor: "color-mix(in srgb, var(--bg-surface) 92%, transparent)",
      }}
    >
      {menu.editable ? (
        <>
          <button
            type="button"
            disabled={!hasSelection || menu.editable.readOnly || menu.editable.disabled}
            onClick={() => void handleCut()}
            className="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs text-[var(--text-primary)] transition hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <span>{t("contextMenu.cut")}</span>
            <span className="font-mono text-[10px] text-[var(--text-muted)]">
              {formatShortcut("X")}
            </span>
          </button>
          <button
            type="button"
            disabled={!hasSelection}
            onClick={() => void handleCopy()}
            className="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs text-[var(--text-primary)] transition hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <span>{t("contextMenu.copy")}</span>
            <span className="font-mono text-[10px] text-[var(--text-muted)]">
              {formatShortcut("C")}
            </span>
          </button>
          <button
            type="button"
            disabled={menu.editable.readOnly || menu.editable.disabled}
            onClick={() => void handlePaste()}
            className="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs text-[var(--text-primary)] transition hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <span>{t("contextMenu.paste")}</span>
            <span className="font-mono text-[10px] text-[var(--text-muted)]">
              {formatShortcut("V")}
            </span>
          </button>
          <div className="my-1 border-t border-[var(--border-subtle)]" />
          <button
            type="button"
            onClick={handleSelectAll}
            className="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs text-[var(--text-primary)] transition hover:bg-[var(--bg-hover)]"
          >
            <span>{t("contextMenu.selectAll")}</span>
            <span className="font-mono text-[10px] text-[var(--text-muted)]">
              {formatShortcut("A")}
            </span>
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs text-[var(--text-primary)] transition hover:bg-[var(--bg-hover)]"
          >
            <span>{t("contextMenu.copy")}</span>
            <span className="font-mono text-[10px] text-[var(--text-muted)]">
              {formatShortcut("C")}
            </span>
          </button>
          {trimmedSelection.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                onFavoriteCommand(trimmedSelection);
                setMenu(null);
              }}
              className="flex w-full items-center px-3 py-1.5 text-left text-xs text-[var(--text-primary)] transition hover:bg-[var(--bg-hover)]"
            >
              <span>{t("snippets.favoriteSelection")}</span>
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
