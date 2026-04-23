/**
 * jj (Jujutsu) Extension
 *
 * Provides a single `jj` tool for working with jj repos.
 * - Auto-prefixes descriptions with "wip:"
 * - Blocks push commands (leave to user)
 * - Warns when git commands are used in jj repos
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

const MAX_DESC_LENGTH = 50;

async function updateStatusWidget(pi: ExtensionAPI, ctx: ExtensionContext) {
  // Check if we're in a jj repo
  const { code } = await pi.exec("test", ["-d", ".jj"]);
  if (code !== 0) {
    ctx.ui.setStatus("jj", "");
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

  // Get file count from status
  const { stdout: status } = await pi.exec("jj", ["st"]);
  const fileChanges = status
    .split("\n")
    .filter((line) => /^[AMDR]\s/.test(line));
  const fileCount = fileChanges.length;

  // Build status line
  let statusLine = changeId || "???";

  if (fileCount > 0) {
    statusLine += ` +${fileCount}`;
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
    await updateStatusWidget(pi, ctx);
  });

  // Update status widget after jj tool calls
  pi.on("tool_execution_end", async (event, ctx) => {
    if (event.toolName === "jj") {
      await updateStatusWidget(pi, ctx);
    }
  });
}
