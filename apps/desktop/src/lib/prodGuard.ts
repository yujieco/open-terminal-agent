// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

export interface DangerousCommandMatch {
  command: string;
  reasonKey: string;
  severity: "critical" | "high";
}

interface GuardRule {
  regex: RegExp;
  reasonKey: string;
  severity: "critical" | "high";
}

const GUARD_RULES: GuardRule[] = [
  {
    regex: /\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+|--(?:recursive|force)\s+)+(?:\/(?:\s|$|\*)|~|\$HOME|\*|\.\.)/i,
    reasonKey: "prodGuard.reasons.recursiveDelete",
    severity: "critical",
  },
  {
    regex: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\b|\brm\s+-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\b/i,
    reasonKey: "prodGuard.reasons.recursiveDelete",
    severity: "high",
  },
  {
    regex: /\b(?:mkfs(?:\.[a-z0-9]+)?|wipefs|fdisk|parted|shred)\b/i,
    reasonKey: "prodGuard.reasons.diskFormat",
    severity: "critical",
  },
  {
    regex: /\bdd\s+[^\n]*\bof=\/dev\//i,
    reasonKey: "prodGuard.reasons.diskWrite",
    severity: "critical",
  },
  {
    regex: /(?:^|[;&|]\s*)(?:sudo\s+)?(?:reboot|shutdown|poweroff|halt|init\s+[06])\b/i,
    reasonKey: "prodGuard.reasons.systemPower",
    severity: "critical",
  },
  {
    regex: /\b(?:DROP\s+(?:DATABASE|SCHEMA|TABLE)|TRUNCATE\s+TABLE|FLUSHALL|FLUSHDB)\b/i,
    reasonKey: "prodGuard.reasons.databaseDrop",
    severity: "critical",
  },
  {
    regex: /\b(?:iptables\s+-F|iptables\s+--flush|ufw\s+disable|nft\s+flush\s+ruleset)\b/i,
    reasonKey: "prodGuard.reasons.firewallFlush",
    severity: "high",
  },
  {
    regex: /\bchmod\s+-R\s+777\s+\/|\bchown\s+-R\s+\S+\s+\/(?:\s|$)/i,
    reasonKey: "prodGuard.reasons.rootPermissions",
    severity: "critical",
  },
  {
    regex: /\bkill\s+-9\s+(?:1|-1)\b|\bkillall\s+-9\b/i,
    reasonKey: "prodGuard.reasons.killCritical",
    severity: "high",
  },
  {
    regex: /\bdocker\s+system\s+prune\s+[^\n]*-a|\bkubectl\s+delete\s+(?:ns|namespace)\b/i,
    reasonKey: "prodGuard.reasons.clusterWipe",
    severity: "high",
  },
  {
    regex: /\bgit\s+push\s+[^\n]*(?:--force|-f)\b/i,
    reasonKey: "prodGuard.reasons.forcePush",
    severity: "high",
  },
  {
    regex: />\s*\/dev\/(?:sd[a-z]|nvme\d+n\d+|vd[a-z])/i,
    reasonKey: "prodGuard.reasons.diskWrite",
    severity: "critical",
  },
];

/** Checks whether a command line matches a production destructive pattern. */
export function matchDangerousCommand(raw: string): DangerousCommandMatch | null {
  const command = raw.trim();
  if (!command) return null;
  for (const rule of GUARD_RULES) {
    if (rule.regex.test(command)) {
      return {
        command,
        reasonKey: rule.reasonKey,
        severity: rule.severity,
      };
    }
  }
  return null;
}

/**
 * Tracks a user's live terminal input line so production sessions can
 * intercept dangerous commands right before the final Enter hits the wire.
 */
export class ProdInputTracker {
  private buffer = "";

  reset(): void {
    this.buffer = "";
  }

  /**
   * Processes outgoing xterm keystrokes. Returns `{ blocked, payload }` where
   * `blocked` is non-null if execution should be paused for human confirmation.
   */
  inspect(data: string): {
    blocked: DangerousCommandMatch | null;
    pendingPayload: string;
  } {
    // Handle multi-char paste or Enter submission.
    if (data.includes("\r") || data.includes("\n")) {
      const candidate = `${this.buffer}${data}`.replace(/\r\n?/g, "\n");
      const lines = candidate.split("\n");
      for (const line of lines) {
        const hit = matchDangerousCommand(line);
        if (hit) {
          return { blocked: hit, pendingPayload: data };
        }
      }
      this.buffer = lines[lines.length - 1] ?? "";
      return { blocked: null, pendingPayload: data };
    }

    // Control keys that clear or reset the line.
    if (data === "\x03" || data === "\x15" || data === "\x04") {
      this.buffer = "";
      return { blocked: null, pendingPayload: data };
    }

    // Backspace / Delete.
    if (data === "\x7f" || data === "\b") {
      this.buffer = this.buffer.slice(0, -1);
      return { blocked: null, pendingPayload: data };
    }

    // Escape sequences (arrow keys, etc.) — leave buffer alone or reset on up/down history.
    if (data.startsWith("\x1b")) {
      if (data === "\x1b[A" || data === "\x1b[B") {
        this.buffer = "";
      }
      return { blocked: null, pendingPayload: data };
    }

    // Append printable characters.
    if (data.length > 0 && !/[\x00-\x1f]/.test(data)) {
      this.buffer = (this.buffer + data).slice(-512);
    }

    return { blocked: null, pendingPayload: data };
  }
}
