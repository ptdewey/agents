# pi-plugin-manager

Global-first declarative plugin manager for Pi extensions and packages.

Install the extension globally, for example by symlinking this directory to
`~/.pi/agent/extensions/pi-plugin-manager`, then run:

```text
/plugins init
```

`init` seeds `~/.pi/agent/plugins.ts` from the packages and local extensions
already listed in `~/.pi/agent/settings.json`. Use `/plugins init --empty` if
you want the sample config instead.

Edit `~/.pi/agent/plugins.ts`:

```ts
import { definePlugins, git, local, npm } from "./extensions/pi-plugin-manager/dsl.js";

export default definePlugins({
  plugins: [
    local("~/projects/skills/extensions/review.ts"),
    local("~/projects/skills/extensions/todos.ts"),

    npm("@org/pi-tools", { version: "^1.0.0" }),
    git("github.com/user/pi-tools", { ref: "main" }),

    npm("@org/mixed-pi-package", {
      resources: {
        extensions: ["extensions/*.ts", "!extensions/legacy.ts"],
        skills: [],
        prompts: false,
      },
    }),
  ],
});
```

Then run:

```text
/plugins plan
/plugins sync
```

`sync` writes the desired packages/extensions into global settings. Pi's normal package loader handles missing package installs on reload/startup.

The manager writes only global files under `~/.pi/agent` by default:

- `plugins.ts`, `plugins.mts`, `plugins.mjs`, `plugins.js`, or `plugins.cjs`
- `settings.json`
- `plugins-lock.json`

It is non-destructive: `sync` only removes package/extension entries that were
previously recorded in `plugins-lock.json` and are no longer declared.
Manual settings entries are left alone.

## JS config with type hints

```js
// @ts-check
import { definePlugins, local, npm } from "./extensions/pi-plugin-manager/dsl.js";

export default definePlugins({
  plugins: [
    local("~/projects/skills/extensions/review.ts"),
    npm("@org/pi-tools"),
  ],
});
```

The runtime DSL is `dsl.js`; type declarations live in `dsl.d.ts`, so TypeScript
and JavaScript-with-JSDoc editors can provide completions.

## Commands

- `/plugins init [--force] [--empty]` - create `~/.pi/agent/plugins.ts`, seeded from current settings unless `--empty` is used
- `/plugins plan` - show desired settings changes
- `/plugins sync` - write `settings.json` and `plugins-lock.json`
- `/plugins reload` - sync, then reload Pi resources
- `/plugins update` - run `pi update --extensions`
- `/plugins status` - summarize desired plugins and drift
- `/plugins doctor` - show paths and loader health

Environment overrides:

- `PI_PLUGIN_MANAGER_HOME` - default `~/.pi/agent`
- `PI_PLUGIN_MANAGER_CONFIG` - explicit config file path
