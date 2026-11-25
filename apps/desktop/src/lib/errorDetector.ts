// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

export interface DetectedTerminalError {
  id: number;
  summary: string;
  sampleLine: string;
  exitCode?: number;
  timestamp: number;
}

// eslint-disable-next-line no-control-regex
const OSC_133_EXIT_RE = /\x1b\]133;D;(\d+)(?:\x07|\x1b\\)/;
// eslint-disable-next-line no-control-regex
const STRIP_ANSI_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;

interface ErrorPattern {
  regex: RegExp;
  label: string;
}

const ERROR_PATTERNS: ErrorPattern[] = [
  { regex: /command not found/i, label: "command not found" },
  { regex: /permission denied/i, label: "Permission denied" },
  { regex: /operation not permitted/i, label: "Operation not permitted" },
  { regex: /no such file or directory/i, label: "No such file or directory" },
  { regex: /address already in use|EADDRINUSE/i, label: "Address already in use" },
  { regex: /connection refused|ECONNREFUSED/i, label: "Connection refused" },
  { regex: /connection timed out|ETIMEDOUT/i, label: "Connection timed out" },
  { regex: /traceback \(most recent call last\)/i, label: "Python Traceback" },
  { regex: /thread ['"][^'"]+['"] panicked at|panic:/i, label: "Runtime panic" },
  { regex: /\berror\[E\d+\]:/i, label: "Compiler error" },
  { regex: /\b(?:SyntaxError|TypeError|ReferenceError|ModuleNotFoundError):/i, label: "Runtime exception" },
  { regex: /\bsegmentation fault\b/i, label: "Segmentation fault" },
  { regex: /\bout of memory\b|\bOOMKilled\b/i, label: "Out of memory" },
  { regex: /\bnpm ERR!\b/i, label: "npm error" },
  { regex: /^\s*fatal:\s+.+/i, label: "Fatal error" },
];

let nextErrorId = 1;

/**
 * Inspects a raw terminal stream chunk for either an OSC 133 non-zero exit
 * code or a high-confidence stderr error signature.
 */
export function detectTerminalError(chunk: string): DetectedTerminalError | null {
  if (!chunk) return null;

  const oscMatch = chunk.match(OSC_133_EXIT_RE);
  if (oscMatch?.[1]) {
    const code = Number.parseInt(oscMatch[1], 10);
    // Ignore 0 (ok) and 130 (Ctrl+C user interrupt).
    if (Number.isFinite(code) && code > 0 && code !== 130) {
      return {
        id: nextErrorId++,
        summary: `Exit ${code}`,
        sampleLine: `Command exited with status ${code}`,
        exitCode: code,
        timestamp: Date.now(),
      };
    }
  }

  const plain = chunk.replace(STRIP_ANSI_RE, "");
  const lines = plain.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length < 6 || line.length > 400) continue;
    for (const pattern of ERROR_PATTERNS) {
      if (pattern.regex.test(line)) {
        return {
          id: nextErrorId++,
          summary: pattern.label,
          sampleLine: line.slice(0, 140),
          timestamp: Date.now(),
        };
      }
    }
  }

  return null;
}
