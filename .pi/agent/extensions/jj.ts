/**
 * jj (Jujutsu) Extension
 *
 * Provides a single `jj` tool for working with jj repos.
 * - Auto-prefixes descriptions with "wip:"
 * - Blocks push commands (leave to user)
 * - Warns when git commands are used in jj repos
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const MAX_DESC_LENGTH = 50;

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

function parseDiffLineStats(diff: string) {
  let added = 0;
  let removed = 0;
  let modified = 0;
  let pendingAdded = 0;
  let pendingRemoved = 0;
  let inHunk = false;

  const flushPending = () => {
    if (pendingAdded === 0 && pendingRemoved === 0) return;
    const paired = Math.min(pendingAdded, pendingRemoved);
    modified += paired;
    added += Math.max(0, pendingAdded - paired);
    removed += Math.max(0, pendingRemoved - paired);
    pendingAdded = 0;
    pendingRemoved = 0;
  };

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ") || line.startsWith("@@ ")) {
      flushPending();
      inHunk = line.startsWith("@@ ");
      continue;
    }
    if (!inHunk || line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("+")) {
      pendingAdded += 1;
    } else if (line.startsWith("-")) {
      pendingRemoved += 1;
    } else {
      flushPending();
    }
  }

  flushPending();
  return { added, removed, modified };
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
        const leftWidth = visibleWidth(left);
        const rightWidth = visibleWidth(right);
        const minGap = right ? 2 : 0;

        let pwdLine: string;
        if (right && leftWidth + minGap + rightWidth <= width) {
          const padding = " ".repeat(width - leftWidth - rightWidth);
          pwdLine = left + padding + right;
        } else if (right) {
          const maxLeftWidth = Math.max(1, width - rightWidth - minGap);
          const truncatedLeft = truncateToWidth(left, maxLeftWidth, theme.fg("dim", "..."));
          const padding = " ".repeat(Math.max(0, width - visibleWidth(truncatedLeft) - rightWidth));
          pwdLine = truncatedLeft + padding + right;
        } else {
          pwdLine = truncateToWidth(left, width, theme.fg("dim", "..."));
        }

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

        let statsLine = statsLeft;
        if (statsLeftParts.length > 0) {
          const availableForLeft = Math.max(1, width - visibleWidth(rightSide) - 2);
          const truncatedStatsLeft = truncateToWidth(statsLeft, availableForLeft, theme.fg("dim", "..."));
          const padding = " ".repeat(Math.max(1, width - visibleWidth(truncatedStatsLeft) - visibleWidth(rightSide)));
          statsLine = truncatedStatsLeft + padding + rightSide;
        } else {
          const truncatedRight = truncateToWidth(rightSide, width, theme.fg("dim", "..."));
          statsLine = " ".repeat(Math.max(0, width - visibleWidth(truncatedRight))) + truncatedRight;
        }

        const otherStatuses = Array.from(extensionStatuses.entries())
          .filter(([key]) => key !== "jj")
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, text]) => sanitizeStatusText(text));

        const lines = [pwdLine, statsLine];
        if (otherStatuses.length > 0) {
          lines.push(truncateToWidth(otherStatuses.join(" "), width, theme.fg("dim", "...")));
        }
        return lines;
      },
    };
  });
}

async function updateStatusWidget(pi: ExtensionAPI, ctx: ExtensionContext) {
  // Check if we're in a jj repo
  const { code } = await pi.exec("test", ["-d", ".jj"]);
  if (code !== 0) {
    ctx.ui.setStatus("jj", undefined);
    return;
  }

  // Get change info: id, bookmarks, description
  const { stdout: info } = await pi.exec("jj", [
    "log",
    "-r",
    "@",
    "--no-graph",
    "-T",
    'change_id.short() ++ "\n" ++ bookmarks.join(", ") ++ "\n" ++ description.first_line()',
  ]);
  const [changeId, bookmarks, description] = info.trim().split("\n");

  // Get line counts from diff
  const { stdout: diff } = await pi.exec("jj", ["diff", "--git", "--color=never"]);
  const { added, removed, modified } = parseDiffLineStats(diff);

  // Build status line
  let statusLine = changeId || "???";

  if (added || removed || modified) {
    statusLine += ` +${added}/-${removed}/~${modified}`;
  }

  if (bookmarks) {
    statusLine += ` [${bookmarks}]`;
  }

  if (description) {
    const truncated =
      description.length > MAX_DESC_LENGTH
        ? description.slice(0, MAX_DESC_LENGTH) + "..."
        : description;
    statusLine += ` ${truncated}`;
  } else {
    statusLine += " (no description)";
  }

  ctx.ui.setStatus("jj", statusLine);
}

export default function (pi: ExtensionAPI) {
  // Single jj tool
  pi.registerTool({
    name: "jj",
    label: "jj",
    description:
      "Run jj (Jujutsu) version control commands. Descriptions are auto-prefixed with 'wip:'. Push commands are disabled - leave pushing to the user.",
    promptSnippet: "Run jj commands (descriptions auto-prefixed with wip:, push disabled)",
    promptGuidelines: [
      "Use the jj tool instead of bash for jj commands in repos with .jj/ directory",
      "Never push - leave `jj git push` to the user",
    ],
    parameters: Type.Object({
      args: Type.Array(Type.String(), {
        description:
          "Arguments to pass to jj (e.g., ['st'], ['diff', '-r', '@-'], ['desc', '-m', 'added feature'])",
      }),
    }),
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

      // Auto-prefix descriptions with "wip:"
      if (args[0] === "desc" || args[0] === "describe") {
        const msgIdx = args.indexOf("-m");
        if (msgIdx !== -1 && args[msgIdx + 1]) {
          const msg = args[msgIdx + 1];
          if (!msg.toLowerCase().startsWith("wip:")) {
            args[msgIdx + 1] = `wip: ${msg}`;
          }
        }
      }

      const { stdout, stderr, code } = await pi.exec("jj", args);

      if (code !== 0) {
        return {
          content: [{ type: "text", text: stderr || `jj exited with code ${code}` }],
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
    const gitCommands = /\bgit\s+(add|commit|stash|checkout|reset|rebase|branch|merge)\b/;
    if (!gitCommands.test(cmd)) return;

    // Check if we're in a jj repo
    const { code } = await pi.exec("test", ["-d", ".jj"]);
    if (code !== 0) return;

    // Warn the user
    if (ctx.hasUI) {
      const ok = await ctx.ui.confirm(
        "Git command in jj repo",
        `You're using git in a jj repo. jj has no staging area and uses different commands.\n\nCommand: ${cmd}\n\nProceed anyway?`
      );
      if (!ok) {
        return { block: true, reason: "Use jj commands in jj repos (see jj-workflow skill)" };
      }
    }
  });

  // Inject jj context at agent start
  pi.on("before_agent_start", async (event, ctx) => {
    // Check if we're in a jj repo
    const { code } = await pi.exec("test", ["-d", ".jj"]);
    if (code !== 0) return;

    const { stdout: status } = await pi.exec("jj", ["st"]);
    const { stdout: log } = await pi.exec("jj", [
      "log",
      "-r",
      "@",
      "--no-graph",
      "-T",
      "change_id.short() ++ ' | ' ++ description.first_line()",
    ]);

    return {
      message: {
        customType: "jj-context",
        content: `**jj repo detected** - Use the \`jj\` tool for version control (not git/bash).

Current change: ${log.trim() || "(no description)"}

Status:
\`\`\`
${status.trim()}
\`\`\``,
        display: false,
      },
    };
  });

  // Update status widget on session start
  pi.on("session_start", async (_event, ctx) => {
    const { code } = await pi.exec("test", ["-d", ".jj"]);
    if (code === 0) {
      installJjFooter(ctx);
    }
    await updateStatusWidget(pi, ctx);
  });

  // Update status widget after tool calls that may change the working copy
  pi.on("tool_execution_end", async (event, ctx) => {
    if (["jj", "bash", "edit", "write"].includes(event.toolName)) {
      await updateStatusWidget(pi, ctx);
    }
  });
}
