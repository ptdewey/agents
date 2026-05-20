---
name: nix-go-vendor-hash
description: Update a Nix buildGoModule vendorHash after Go dependency changes. Use when go.mod/go.sum changes require refreshing nix/default.nix or default.nix vendorHash.
---

# Update Nix Go `vendorHash`

Use this workflow after adding, removing, or updating Go dependencies when a Nix `buildGoModule` derivation needs a new `vendorHash`.

## When to Use

- `go.mod` or `go.sum` changed.
- `nix run` / `nix build` fails with a Go module vendor hash mismatch.
- A `default.nix` file contains `vendorHash = "sha256-...";` for a Go project.

## Procedure

1. Find the `vendorHash` in `default.nix` or `nix/default.nix`.
2. Temporarily comment out the existing hash and add `lib.fakeHash` on the next line:

   ```nix
   # vendorHash = "sha256-oldHashHere";
   vendorHash = lib.fakeHash;
   ```

3. Run the project through Nix from the repository root:

   ```bash
   nix run
   ```

4. The command is expected to fail with a hash mismatch. Copy the correct hash from the error output, usually the `got:` value:

   ```text
   got: sha256-...
   ```

5. Replace the old hash with the copied hash, remove the temporary `lib.fakeHash` line, and uncomment `vendorHash`:

   ```nix
   vendorHash = "sha256-newHashHere";
   ```

6. Run `nix run` again to verify the new hash is accepted.

## Pitfalls

- The `lib.fakeHash` failure is intentional; do not treat the first `nix run` failure as a real build failure unless it fails before reporting a hash.
- Copy the `got:` hash, not the `specified:` / fake hash value.
- Preserve existing Nix formatting and indentation.
- Do not leave both the real `vendorHash` and `lib.fakeHash` active.
- If the repo uses jj, use `jj diff` / `jj st` for version-control checks, not git.

## Verification

- `default.nix` or `nix/default.nix` has exactly one active `vendorHash` assignment.
- The active hash is the new `sha256-...` hash reported by Nix.
- `nix run` no longer fails with a vendor hash mismatch.
