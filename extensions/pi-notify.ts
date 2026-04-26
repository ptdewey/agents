import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

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

function sendNotificationLinux(title: string, message: string, sound: boolean | string): void {
  const args = [title, message];
  if (!sound) {
    args.push("--hint=int:value:1"); // Suppress sound without breaking timeout
  }
  // Use spawn for fire-and-forget
  const { spawn } = require("node:child_process") as typeof import("node:child_process");
  spawn("notify-send", args, { detached: true, stdio: "ignore" }).unref();
}

function sendNotificationMac(title: string, message: string, sound: boolean | string): void {
  const script = `
    display notification "${message.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"
    ${sound ? 'sound name "default"' : ""}
  `;
  // sound: play sound "default beep" if sound enabled
  const finalScript = sound
    ? `display notification "${message.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}" sound name "default"`
    : `display notification "${message.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"`;

  const { spawn } = require("node:child_process") as typeof import("node:child_process");
  spawn("osascript", ["-e", finalScript], { detached: true, stdio: "ignore" }).unref();
}

function sendNotification(config: NotifyConfig, kind: NotificationKind): void {
  const payload = kind === "waiting-for-input" ? config.waiting : config.completed;
  if (!payload.enabled) return;

  const platform = process.platform;
  if (platform === "linux") {
    sendNotificationLinux(payload.title, payload.message, config.sound);
  } else if (platform === "darwin") {
    sendNotificationMac(payload.title, payload.message, config.sound);
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
      sendNotification(config, kind);
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
