import {
  definePlugins,
  npm,
  local,
  git,
} from "./extensions/pi-plugin-manager/dsl.js";

export default definePlugins({
  // Seeded from /Users/patrick.dewey/.pi/agent/settings.json.
  plugins: [
    // npm("pi-subagents"),
    npm("@mjakl/pi-subagent"),
    npm("pi-hermes-memory"),
    npm("pi-rtk-optimizer"),
    npm("pi-bar"),
    local("~/projects/agents/extensions/thinking-settings.ts"),
    local("~/projects/skills/packages/pi-notify", {
      package: true,
      resources: {
        extensions: ["extensions/pi-notify.ts"],
      },
    }),
    npm("@latentminds/pi-quotas"),
    npm("@howaboua/pi-codex-conversion"),
    npm("pi-codex-goal"),
    npm("@tmustier/pi-ralph-wiggum"),
  ],
});
