/**
 * jj (Jujutsu) Extension
 *
 * Provides a single `jj` tool for working with jj repos.
 * - Blocks push commands (leave to user)
 * - Warns when git commands are used in jj repos
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const MAX_DESC_LENGTH = 50;
const STATUS_REFRESH_DEBOUNCE_MS = 750;

type JjSnapshot = {
  status: string;
  footerStatus: string;
  contextMessage: string;
};

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function sanitizeStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

function fitFooterColumns(
  left: string,
  right: string,
  width: number,
  ellipsis = "...",
  minGap = 2,
): string {
  if (width <= 0) return "";
  if (!right) return truncateToWidth(left, width, ellipsis);

  const fittedRight = truncateToWidth(right, width, ellipsis);
  const fittedRightWidth = visibleWidth(fittedRight);

  // If the right side consumes the whole footer, drop the left side rather than
  // returning an over-wide line. TUI component renderers must fit `width`.
  if (fittedRightWidth >= width) return fittedRight;

  const maxLeftWidth = width - fittedRightWidth - minGap;
  if (maxLeftWidth <= 0) {
    return " ".repeat(width - fittedRightWidth) + fittedRight;
  }

  const fittedLeft = truncateToWidth(left, maxLeftWidth, ellipsis);
  const padding = " ".repeat(
    Math.max(minGap, width - visibleWidth(fittedLeft) - fittedRightWidth),
  );
  return fittedLeft + padding + fittedRight;
}

function toolResultText(result: {
  content?: Array<{ type: string; text?: string }>;
}): string {
  const text = result.content
    ?.filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
  return text || "";
}

function parseWorkingCopyChangeLine(status: string): string {
  const match = status.match(/^Working copy\s+\(@\)\s*:\s*(.+)$/m);
  return match?.[1]?.trim() ?? "(no description set)";
}

function parseWorkingCopyCounts(status: string) {
  let modified = 0;
  let added = 0;
  let removed = 0;
  let other = 0;
  let inChanges = false;

  for (const rawLine of status.split("\n")) {
    const line = rawLine.trim();

    if (!inChanges) {
      if (line === "Working copy changes:") inChanges = true;
      continue;
    }

    if (line.startsWith("Working copy") || line.startsWith("Parent commit"))
      break;
    if (!line) continue;

    const marker = line[0];
    switch (marker) {
      case "M":
        modified += 1;
        break;
      case "A":
        added += 1;
        break;
      case "D":
        removed += 1;
        break;
      default:
        other += 1;
        break;
    }
  }

  return { modified, added, removed, other };
}

function buildJjSnapshot(status: string): JjSnapshot {
  const changeLine = parseWorkingCopyChangeLine(status);
  const changeId = changeLine.split(/\s+/)[0] || "???";
  const counts = parseWorkingCopyCounts(status);
  const countParts = [];
  if (counts.added) countParts.push(`+${counts.added}`);
  if (counts.removed) countParts.push(`-${counts.removed}`);
  if (counts.modified) countParts.push(`~${counts.modified}`);
  if (counts.other) countParts.push(`Δ${counts.other}`);

  const descriptionMatch = changeLine.match(/^\S+\s+\S+\s+(.*)$/);
  const description = (descriptionMatch?.[1] || changeLine).trim();
  const truncatedDescription =
    description.length > MAX_DESC_LENGTH
      ? description.slice(0, MAX_DESC_LENGTH) + "..."
      : description;

  let footerStatus = changeId;
  if (countParts.length > 0) footerStatus += ` ${countParts.join(" ")}`;
  if (truncatedDescription) footerStatus += ` ${truncatedDescription}`;

  return {
    status,
    footerStatus,
    contextMessage: `**jj repo detected** - Use the \`jj\` tool for version control (not git/bash).\n\nCurrent change: ${changeLine}\n\nStatus:\n\`\`\`\n${status.trim()}\n\`\`\``,
  };
}

function installJjFooter(ctx: ExtensionContext) {
  if (!ctx.hasUI) return;

  ctx.ui.setFooter((tui, theme, footerData) => {
    const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

    return {
      dispose: unsubscribe,
      invalidate() {},
      render(width: number): string[] {
        let pwd = ctx.sessionManager.getCwd();
        const home = process.env.HOME || process.env.USERPROFILE;
        if (home && pwd.startsWith(home)) {
          pwd = `~${pwd.slice(home.length)}`;
        }

        const branch = footerData.getGitBranch();
        if (branch) {
          pwd = `${pwd} (${branch})`;
        }

        const sessionName = ctx.sessionManager.getSessionName();
        if (sessionName) {
          pwd = `${pwd} • ${sessionName}`;
        }

        const extensionStatuses = footerData.getExtensionStatuses();
        const jjStatus = extensionStatuses.get("jj");
        const left = theme.fg("dim", pwd);
        const right = jjStatus ? sanitizeStatusText(jjStatus) : "";
        const ellipsis = theme.fg("dim", "...");
        const pwdLine = fitFooterColumns(left, right, width, ellipsis);

        let totalInput = 0;
        let totalOutput = 0;
        let totalCost = 0;
        for (const entry of ctx.sessionManager.getBranch()) {
          if (entry.type === "message" && entry.message.role === "assistant") {
            const message = entry.message as AssistantMessage;
            totalInput += message.usage.input;
            totalOutput += message.usage.output;
            totalCost += message.usage.cost.total;
          }
        }

        const statsLeftParts = [];
        if (totalInput) statsLeftParts.push(`↑${formatTokens(totalInput)}`);
        if (totalOutput) statsLeftParts.push(`↓${formatTokens(totalOutput)}`);
        if (totalCost) statsLeftParts.push(`$${totalCost.toFixed(3)}`);
        const statsLeft = theme.fg("dim", statsLeftParts.join(" "));

        const rightSide = theme.fg("dim", ctx.model?.id || "no-model");

        let statsLine: string;
        if (statsLeftParts.length > 0) {
          statsLine = fitFooterColumns(statsLeft, rightSide, width, ellipsis);
        } else {
          const truncatedRight = truncateToWidth(rightSide, width, ellipsis);
          statsLine =
            " ".repeat(Math.max(0, width - visibleWidth(truncatedRight))) +
            truncatedRight;
        }

        const otherStatuses = Array.from(extensionStatuses.entries())
          .filter(([key]) => key !== "jj")
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, text]) => sanitizeStatusText(text));

        const lines = [pwdLine, statsLine];
        if (otherStatuses.length > 0) {
          lines.push(truncateToWidth(otherStatuses.join(" "), width, ellipsis));
        }
        return lines.map((line) => truncateToWidth(line, width, ellipsis));
      },
    };
  });
}

async function fetchJjSnapshot(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<JjSnapshot | null> {
  const { code } = await pi.exec("test", ["-d", ".jj"]);
  if (code !== 0) {
    if (ctx.hasUI) ctx.ui.setStatus("jj", undefined);
    return null;
  }

  const { stdout, stderr, code: statusCode } = await pi.exec("jj", ["st"]);
  if (statusCode !== 0) {
    if (ctx.hasUI) ctx.ui.setStatus("jj", "status unavailable");
    return {
      status: stderr || "jj st failed",
      footerStatus: "status unavailable",
      contextMessage:
        "**jj repo detected** - Use the `jj` tool for version control (not git/bash).",
    };
  }

  const snapshot = buildJjSnapshot(stdout || "");
  if (ctx.hasUI) ctx.ui.setStatus("jj", snapshot.footerStatus);
  return snapshot;
}

export default function (pi: ExtensionAPI) {
  let cachedSnapshot: JjSnapshot | null = null;
  let inJjRepo: boolean | null = null;
  let snapshotRefreshPromise: Promise<JjSnapshot | null> | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;

  const refreshSnapshot = async (
    ctx: ExtensionContext,
    force = false,
  ): Promise<JjSnapshot | null> => {
    if (!force && cachedSnapshot) return cachedSnapshot;
    if (!force && inJjRepo === false) return null;
    if (snapshotRefreshPromise) return snapshotRefreshPromise;

    snapshotRefreshPromise = fetchJjSnapshot(pi, ctx)
      .then((snapshot) => {
        cachedSnapshot = snapshot;
        inJjRepo = snapshot !== null;
        return snapshot;
      })
      .finally(() => {
        snapshotRefreshPromise = null;
      });

    return snapshotRefreshPromise;
  };

  const scheduleSnapshotRefresh = (ctx: ExtensionContext) => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      void refreshSnapshot(ctx, true);
    }, STATUS_REFRESH_DEBOUNCE_MS);
  };

  // Single jj tool
  pi.registerTool({
    name: "jj",
    label: "jj",
    description:
      "Run jj (Jujutsu) version control commands. Push commands are disabled - leave pushing to the user.",
    promptSnippet: "Run jj commands (push disabled)",
    promptGuidelines: [
      "Use the jj tool instead of bash for jj commands in repos with .jj/ directory",
      "Never push - leave `jj git push` to the user",
      "Do not prefix commit/change descriptions with `wip:` unless the change is explicitly experimental or the user asks for it",
    ],
    parameters: Type.Object({
      args: Type.Array(Type.String(), {
        description:
          "Arguments to pass to jj (e.g., ['st'], ['diff', '-r', '@-'], ['desc', '-m', 'added feature'])",
      }),
    }),
    renderResult(result) {
      // The fallback renderer can receive very long jj lines (for example long
      // commit descriptions in `jj st` / `jj diff`). Text wraps them to the
      // available component width so the TUI never gets an over-wide line.
      return new Text(toolResultText(result), 0, 0);
    },
    async execute(toolCallId, params) {
      const args = [...params.args];

      // Block push commands
      if (args[0] === "git" && args[1] === "push") {
        return {
          content: [
            {
              type: "text",
              text: "Push is disabled - leave jj git push to the user.",
            },
          ],
          isError: true,
          details: { blocked: "push" },
        };
      }

      const { stdout, stderr, code } = await pi.exec("jj", args);

      if (code !== 0) {
        return {
          content: [
            { type: "text", text: stderr || `jj exited with code ${code}` },
          ],
          isError: true,
          details: { args, exitCode: code },
        };
      }

      return {
        content: [{ type: "text", text: stdout || "(no output)" }],
        details: { args, exitCode: code },
      };
    },
  });

  // Warn when git commands are used in jj repos
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;

    const cmd = event.input.command;

    // Check for git porcelain commands that shouldn't be used in jj
    const gitCommands =
      /\bgit\s+(add|commit|stash|checkout|reset|rebase|branch|merge)\b/;
    if (!gitCommands.test(cmd)) return;

    // Check if we're in a jj repo
    const { code } = await pi.exec("test", ["-d", ".jj"]);
    if (code !== 0) return;

    // Warn the user
    if (ctx.hasUI) {
      const ok = await ctx.ui.confirm(
        "Git command in jj repo",
        `You're using git in a jj repo. jj has no staging area and uses different commands.\n\nCommand: ${cmd}\n\nProceed anyway?`,
      );
      if (!ok) {
        return {
          block: true,
          reason: "Use jj commands in jj repos (see jj-workflow skill)",
        };
      }
    }
  });

  // Inject jj context at agent start
  pi.on("before_agent_start", async (_event, ctx) => {
    const snapshot = await refreshSnapshot(ctx, false);
    if (!snapshot) return;

    return {
      message: {
        customType: "jj-context",
        content: snapshot.contextMessage,
        display: false,
      },
    };
  });

  // Update status widget on session start
  pi.on("session_start", async (_event, ctx) => {
    const snapshot = await refreshSnapshot(ctx, true);
    if (snapshot) {
      installJjFooter(ctx);
    }
  });

  // Update status widget after tool calls that may change the working copy
  pi.on("tool_execution_end", async (event, ctx) => {
    if (event.toolName === "jj") {
      await refreshSnapshot(ctx, true);
      return;
    }

    if (event.toolName === "edit" || event.toolName === "write") {
      scheduleSnapshotRefresh(ctx);
    }
  });
}
