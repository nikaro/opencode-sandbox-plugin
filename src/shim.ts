import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const ENFORCEMENT_MESSAGE =
  "opencode-sandbox: sandbox unavailable in enforce mode; command blocked"

// The shim defers to a command string the host prepared with
// SandboxManager.wrapWithSandbox(); `realShell -c <wrapped>` is exactly what
// SandboxManager.wrapWithSandboxArgv() would have spawned. Keeping the raw
// command in invocation.command lets OpenCode's permission rules and shell
// scanning operate on the unsandboxed text while the sandbox applies at
// process spawn.
const SHIM_SCRIPT = `#!/bin/sh
exec "\${OPENCODE_SANDBOX_REAL_SHELL:?}" -c "\${OPENCODE_SANDBOX_WRAPPED_COMMAND:?}"
`

const BLOCKED_SCRIPT = `#!/bin/sh
echo '${ENFORCEMENT_MESSAGE}' >&2
exit 126
`

type ShimKind = "sandbox" | "blocked"

function cacheDir(): string {
  const base = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache")
  return path.join(base, "opencode-sandbox")
}

const pending = new Map<string, Promise<string>>()

// Returns an executable shim whose basename matches the real shell, so
// OpenCode's ShellSelect.args() and shell-syntax scanning treat it like the
// shell it stands in for.
export function ensureShim(shellPath: string, kind: ShimKind): Promise<string> {
  const key = `${kind}:${shellPath}`
  let entry = pending.get(key)
  if (entry === undefined) {
    entry = writeShim(shellPath, kind)
    pending.set(key, entry)
    // Transient failures (unwritable cache, full disk) must not poison the
    // shell permanently; the next call retries.
    entry.catch(() => pending.delete(key))
  }
  return entry
}

async function writeShim(shellPath: string, kind: ShimKind): Promise<string> {
  const file = path.join(cacheDir(), "shim", kind, path.basename(shellPath))
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  await fs.promises.writeFile(file, kind === "sandbox" ? SHIM_SCRIPT : BLOCKED_SCRIPT, {
    mode: 0o755,
  })
  // writeFile's mode only applies to newly created files; enforce it on updates too.
  await fs.promises.chmod(file, 0o755)
  return file
}
