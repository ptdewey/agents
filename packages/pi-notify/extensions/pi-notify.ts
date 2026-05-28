import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type NotificationKind = "task-completed" | "waiting-for-input";

type NotifyConfig = {
  sound: boolean | string;
  timeout: number | false;
  debug: boolean;
  delayMs: number;
  suppressWhenTmuxPaneActive: boolean;
  completed: {
    enabled: boolean;
    title: string;
    message: string;
  };
  waiting: {
    enabled: boolean;
    title: string;
    message: string;
  };
};

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function envBool(name: string, fallback: boolean): boolean {
  const value = env(name);
  if (!value) return fallback;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function envNumber(name: string, fallback: number | false): number | false {
  const value = env(name);
  if (!value) return fallback;
  if (value.toLowerCase() === "false") return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envSound(name: string, fallback: boolean | string): boolean | string {
  const value = env(name);
  if (!value) return fallback;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  return value;
}

function loadConfig(): NotifyConfig {
  return {
    sound: envSound("PI_NOTIFY_SOUND", true),
    timeout: envNumber("PI_NOTIFY_TIMEOUT", 10),
    debug: envBool("PI_NOTIFY_DEBUG", false),
    delayMs: Number(envNumber("PI_NOTIFY_DELAY_MS", 0)) || 0,
    suppressWhenTmuxPaneActive: envBool("PI_NOTIFY_SUPPRESS_WHEN_TMUX_PANE_ACTIVE", true),
    completed: {
      enabled: envBool("PI_NOTIFY_COMPLETED_ENABLED", true),
      title: env("PI_NOTIFY_COMPLETED_TITLE") ?? "Pi task completed",
      message: env("PI_NOTIFY_COMPLETED_MESSAGE") ?? "Pi finished and is ready for your next instruction.",
    },
    waiting: {
      enabled: envBool("PI_NOTIFY_WAITING_ENABLED", true),
      title: env("PI_NOTIFY_WAITING_TITLE") ?? "Pi needs input",
      message: env("PI_NOTIFY_WAITING_MESSAGE") ?? "Pi is waiting for clarification or confirmation.",
    },
  };
}

function extractMessageText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (part.type === "text" && typeof part.text === "string") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function getLastAssistantText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === "assistant") {
      const text = extractMessageText(message);
      if (text) return text;
    }
  }
  return "";
}

function extractSummaryFromMessages(messages: any[]): string {
  const parts: string[] = [];
  let lastToolCall: string | undefined;
  let lastToolResult: string | undefined;

  for (const message of messages) {
    if (message?.role === "assistant") {
      const content = message?.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part?.type === "tool_use" || part?.type === "function_call") {
            const name = part.name || part.function?.name || "tool";
            lastToolCall = name.replace(/([A-Z])/g, " $1").trim().toLowerCase();
          }
        }
      }
    } else if (message?.role === "tool") {
      const content = message?.content;
      if (typeof content === "string") {
        // Truncate long tool results
        lastToolResult = content.length > 200 
          ? content.substring(0, 200).trim() + "..."
          : content.trim();
      }
    }
  }

  if (lastToolCall) {
    parts.push(`called: ${lastToolCall}`);
  }
  if (lastToolResult) {
    parts.push(`result: ${lastToolResult}`);
  }

  // Add last assistant response summary
  const lastText = getLastAssistantText(messages);
  if (lastText && lastText.length > 500) {
    parts.push(`response: ${lastText.substring(0, 500).trim()}...`);
  } else if (lastText) {
    parts.push(`response: ${lastText}`);
  }

  return parts.join(" | ");
}


function resolveMessageTemplate(template: string, messages: any[]): string {
  const lastText = getLastAssistantText(messages);
  const summary = extractSummaryFromMessages(messages);

  return template
    .replace(/\{last_response\}/g, lastText || "")
    .replace(/\{summary\}/g, summary || "completed")
    .replace(/\{truncated_last_response\}/g, lastText.length > 300 ? lastText.substring(0, 300) + "..." : lastText);
}

function classifyNotification(messages: any[]): NotificationKind {
  const text = getLastAssistantText(messages);
  if (!text) return "task-completed";

  const waitingPatterns = [
    /\?\s*$/,
    /\b(let me know|tell me|could you|can you|would you|please provide|need more (?:info|information|details)|need (?:your )?(?:input|confirmation)|waiting for (?:your )?(?:input|confirmation)|what should i|which option|do you want me to|should i continue)\b/i,
  ];

  return waitingPatterns.some((pattern) => pattern.test(text))
    ? "waiting-for-input"
    : "task-completed";
}

async function isTmuxPaneVisible(pi: ExtensionAPI, config: NotifyConfig): Promise<boolean> {
  if (!config.suppressWhenTmuxPaneActive) return false;

  const tmuxPane = env("TMUX_PANE");
  if (!tmuxPane) return false;

  const { stdout, code } = await pi.exec("tmux", [
    "display-message",
    "-p",
    "-t",
    tmuxPane,
    "#{pane_active} #{window_active} #{session_attached}",
  ]);

  if (code !== 0) {
    if (config.debug) {
      console.log("[pi-notify] tmux probe failed; continuing with notification");
    }
    return false;
  }

  const [paneActive, windowActive, sessionAttached] = stdout.trim().split(/\s+/);
  return paneActive === "1" && windowActive === "1" && sessionAttached !== "0";
}

function spawnNotificationCommand(
  command: string,
  args: string[],
  debug: boolean,
  onMissing?: () => void,
): void {
  const { spawn } = require("node:child_process") as typeof import("node:child_process");
  const child = spawn(command, args, {
    detached: true,
    stdio: debug ? ["ignore", "pipe", "pipe"] : "ignore",
  });

  let stderr = "";
  if (debug && child.stderr) {
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
  }

  child.on("error", (err: NodeJS.ErrnoException) => {
    if (err?.code === "ENOENT") {
      if (debug) {
        console.log(`[pi-notify] ${command} not found`);
      }
      onMissing?.();
      return;
    }
    if (debug) {
      console.log(`[pi-notify] ${command} failed: ${err.message}`);
    }
  });

  if (debug) {
    child.on("close", (code) => {
      if (!code || code === 0) return;
      const details = stderr.trim();
      console.log(
        `[pi-notify] ${command} exited with code ${code}${details ? `: ${details}` : ""}`,
      );
    });
  }

  child.unref();
}

function sendNotificationLinux(
  title: string,
  message: string,
  sound: boolean | string,
  debug: boolean,
): void {
  // Truncate message for notify-send (typically ~200 char limit for some implementations)
  const truncated = message.length > 500 ? message.substring(0, 500) + "..." : message;
  const args = [title, truncated];
  if (!sound) {
    args.push("--hint=int:value:1"); // Suppress sound without breaking timeout
  }
  spawnNotificationCommand("notify-send", args, debug);
}

function sendNotificationMacViaOsa(
  title: string,
  truncated: string,
  soundName: string | undefined,
  debug: boolean,
): void {
  // Pass title/message as argv values so osascript handles escaping safely.
  const script = `
on run argv
  set notificationTitle to item 1 of argv
  set notificationMessage to item 2 of argv
  if (count of argv) > 2 then
    set notificationSound to item 3 of argv
    display notification notificationMessage with title notificationTitle sound name notificationSound
  else
    display notification notificationMessage with title notificationTitle
  end if
end run
`.trim();

  const args = ["-e", script, title, truncated];
  if (soundName) args.push(soundName);
  spawnNotificationCommand("osascript", args, debug);
}

type NodeNotifierLike = {
  notify: (
    options: Record<string, unknown>,
    callback?: (error: Error | null, response?: unknown, metadata?: unknown) => void,
  ) => void;
};

let cachedNodeNotifier: NodeNotifierLike | null | undefined;

function loadNodeNotifier(debug: boolean): NodeNotifierLike | undefined {
  if (cachedNodeNotifier !== undefined) {
    return cachedNodeNotifier ?? undefined;
  }

  try {
    const mod = require("node-notifier") as { default?: NodeNotifierLike } | NodeNotifierLike;
    const notifier = ((mod as { default?: NodeNotifierLike }).default ?? mod) as NodeNotifierLike;
    if (notifier && typeof notifier.notify === "function") {
      cachedNodeNotifier = notifier;
      return notifier;
    }
  } catch (err) {
    if (debug) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[pi-notify] node-notifier unavailable: ${message}`);
    }
  }

  cachedNodeNotifier = null;
  return undefined;
}

function sendNotificationMac(
  title: string,
  message: string,
  sound: boolean | string,
  timeout: number | false,
  debug: boolean,
): void {
  // Truncate for macOS notification center.
  const truncated = message.length > 500 ? message.substring(0, 500) + "..." : message;
  const soundName = sound === true ? "default" : typeof sound === "string" ? sound : undefined;

  const notifier = loadNodeNotifier(debug);
  if (!notifier) {
    if (debug) {
      console.log("[pi-notify] falling back to osascript backend");
    }
    sendNotificationMacViaOsa(title, truncated, soundName, debug);
    return;
  }

  const options: Record<string, unknown> = {
    title,
    message: truncated,
  };
  if (typeof timeout === "number") {
    options.timeout = timeout;
  }

  if (sound === false) {
    options.sound = false;
  } else if (sound === true) {
    options.sound = true;
  } else {
    options.sound = sound;
  }

  notifier.notify(options, (error) => {
    if (!error) return;
    if (debug) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[pi-notify] node-notifier failed: ${message}`);
      console.log("[pi-notify] falling back to osascript backend");
    }
    sendNotificationMacViaOsa(title, truncated, soundName, debug);
  });
}

function sendNotification(config: NotifyConfig, kind: NotificationKind, messages: any[]): void {
  const payload = kind === "waiting-for-input" ? config.waiting : config.completed;
  if (!payload.enabled) return;

  const message = resolveMessageTemplate(payload.message, messages);

  const platform = process.platform;
  if (platform === "linux") {
    sendNotificationLinux(payload.title, message, config.sound, config.debug);
  } else if (platform === "darwin") {
    sendNotificationMac(payload.title, message, config.sound, config.timeout, config.debug);
  } else if (config.debug) {
    console.log(`[pi-notify] unsupported platform: ${platform}`);
  }
}

export default function piNotifyExtension(pi: ExtensionAPI) {
  const config = loadConfig();
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingNotificationId = 0;

  function clearPendingNotification(): void {
    if (!pendingTimer) return;
    clearTimeout(pendingTimer);
    pendingTimer = undefined;
  }

  pi.on("session_start", async (event) => {
    if (!config.debug) return;
    console.log(`[pi-notify] loaded (${event.reason})`);
  });

  pi.on("agent_start", async () => {
    pendingNotificationId += 1;
    clearPendingNotification();
  });

  pi.on("input", async () => {
    pendingNotificationId += 1;
    clearPendingNotification();
    return { action: "continue" } as const;
  });

  pi.on("session_shutdown", async () => {
    pendingNotificationId += 1;
    clearPendingNotification();
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!ctx.hasUI) return;


    const kind = classifyNotification(event.messages as any[]);
    const messages = event.messages as any[];
    const notificationId = ++pendingNotificationId;
    clearPendingNotification();


    if (config.debug) {
      console.log(`[pi-notify] agent_end => ${kind}`);
    }

    if (await isTmuxPaneVisible(pi, config)) {
      if (config.debug) {
        console.log("[pi-notify] skipping notification because tmux pane is visible");
      }
      return;
    }

    const send = async () => {
      if (notificationId !== pendingNotificationId) return;

      if (await isTmuxPaneVisible(pi, config)) {
        if (config.debug) {
          console.log("[pi-notify] dropped delayed notification because tmux pane became visible");
        }
        return;
      }

      if (config.debug) {
        console.log("[pi-notify] sending notification");
      }
      sendNotification(config, kind, messages);
      pendingTimer = undefined;
    };

    if (config.delayMs <= 0) {
      await send();
      return;
    }

    if (config.debug) {
      console.log(`[pi-notify] scheduling notification in ${config.delayMs}ms`);
    }
    pendingTimer = setTimeout(() => {
      void send();
    }, config.delayMs);
  });
}
