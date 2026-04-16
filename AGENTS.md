# Global conventions

## Version control: Jujutsu (jj), not git

In many of my projects, I use jj, not git. **Before running any VCS command, check for a `.jj/` directory** (especially in `~/workspace/<project>-<ticket>/` paths — those are jj workspaces by default). If `.jj/` is present, use jj; do not fall back to git porcelain.

Common mappings I use:

- `jj st` — status (use instead of `git status`)
- `jj diff` / `jj diff -r <rev>` — diff
- `jj desc -m "msg"` — set description on current change (like commit message)
- `jj new` — start new change on top
- `jj edit @-` — move working copy to parent
- `jj squash` — fold current change into parent; I often run `jj squash && jj edit @-` as a pair
- `jj bookmark set <name> -r @-` — move bookmark (like `git branch -f`)
- `jj git push` — push; add `--allow-new` for first push of a new bookmark
- `jj git fetch` — fetch
- `jj restore <path>` — undo file changes (use instead of `git checkout --`)
- `jj op log` / `jj op restore <id>` — rewind the whole repo state

Shipping sequence I typically use: `jj desc -m …` → `jj bookmark set <name> -r @` → `jj git push` (with `--allow-new` if new) → `jj new`.

Do not suggest `git add`, `git commit`, `git stash`, `git checkout`, `git reset`, or `git rebase` in a jj workspace. jj snapshots the working copy automatically — there is no staging area.

## Use Go Tooling Effectively

When working in Go codebases, always do the following:

- To see source files from a dependency, or to answer questions
  about a dependency, run `go mod download -json MODULE` and use
  the returned `Dir` path to read the files.

- Use `go doc foo.Bar` or `go doc -all foo` to read documentation
  for packages, types, functions, etc.

- Use `go run .` or `go run ./cmd/foo` instead of `go build` to
  run programs, to avoid leaving behind build artifacts.
