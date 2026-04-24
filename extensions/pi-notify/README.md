# Pi Notification Extension

A project-local Pi extension that sends native desktop notifications when Pi:

- finishes a task and is ready for the next prompt
- appears to be waiting for clarification or confirmation

It uses [`node-notifier`](https://www.npmjs.com/package/node-notifier) for cross-platform notifications.

## Files

- `.pi/agent/extensions/pi-notify/index.ts` — extension entry point
- `.pi/agent/extensions/pi-notify/test-notify.js` — standalone notification smoke test
- `.pi/agent/extensions/pi-notify/package.json` — dependency manifest

## Install

Install the dependency in the extension directory:

```bash
cd .pi/agent/extensions/pi-notify
npm install
```

Then reload Pi:

```text
/reload
```

## Test the notification backend

From this repo:

```bash
cd .pi/agent/extensions/pi-notify
node test-notify.js
```

You can also override the title/message:

```bash
node test-notify.js "Pi test" "Hello from Pi"
```

## Behavior

The extension listens to `agent_end`.

- If the final assistant message looks like a request for clarification or confirmation, it sends a **waiting for input** notification.
- Otherwise it sends a **task completed** notification.
- Notifications are immediate by default.
- If Pi is running inside tmux, notifications are suppressed while the current tmux pane is visible in the active tmux window.
- If a delayed notification is pending and you refocus that tmux pane before the timer fires, the notification is dropped.

The waiting-for-input detection is heuristic and based on the final assistant text.

## Configuration

Set environment variables before launching Pi.

| Variable | Default | Purpose |
|---|---|---|
| `PI_NOTIFY_APP_ID` | `Pi` | App identifier passed to the notifier |
| `PI_NOTIFY_SOUND` | `true` | `true`, `false`, or a platform-specific sound name |
| `PI_NOTIFY_TIMEOUT` | `10` | Timeout in seconds, or `false` |
| `PI_NOTIFY_DEBUG` | `false` | Log extension behavior to console |
| `PI_NOTIFY_DELAY_MS` | `0` | Delay before sending a notification |
| `PI_NOTIFY_SUPPRESS_WHEN_TMUX_PANE_ACTIVE` | `true` | Suppress notifications when the current tmux pane is visible in the active tmux window |
| `PI_NOTIFY_COMPLETED_ENABLED` | `true` | Enable completed notifications |
| `PI_NOTIFY_COMPLETED_TITLE` | `Pi task completed` | Completed notification title |
| `PI_NOTIFY_COMPLETED_MESSAGE` | `Pi finished and is ready for your next instruction.` | Completed notification body |
| `PI_NOTIFY_WAITING_ENABLED` | `true` | Enable waiting-for-input notifications |
| `PI_NOTIFY_WAITING_TITLE` | `Pi needs input` | Waiting notification title |
| `PI_NOTIFY_WAITING_MESSAGE` | `Pi is waiting for clarification or confirmation.` | Waiting notification body |

### Example

```bash
export PI_NOTIFY_SOUND=Glass
export PI_NOTIFY_DELAY_MS=0
export PI_NOTIFY_SUPPRESS_WHEN_TMUX_PANE_ACTIVE=true
export PI_NOTIFY_COMPLETED_TITLE="Agent done"
export PI_NOTIFY_WAITING_TITLE="Agent blocked"
pi
```

## Notes

- `node-notifier` uses Notification Center on macOS, `notify-send`/libnotify on Linux, and Windows toast notifications on Windows/WSL.
- On Linux, native notifications may require `notify-send` or a compatible notification daemon.
- The extension only notifies when Pi has a UI (`ctx.hasUI`).
- tmux suppression relies on `TMUX_PANE` and `tmux display-message`, so it only applies when Pi is running inside tmux.
- The tmux visibility check now requires the pane itself and its window to be active, which avoids suppressing notifications for panes in background sessions.
