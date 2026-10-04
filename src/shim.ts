import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const ENFORCEMENT_MESSAGE = "opencode-sandbox: sandbox unavailable; command blocked"

// The shim defers to a command string the host prepared with
// SandboxManager.wrapWithSandbox(); `realShell -c <wrapped>` is exactly what
// SandboxManager.wrapWithSandboxArgv() would have spawned. Keeping the raw
// command in invocation.command lets OpenCode's permission rules and shell
// scanning operate on the unsandboxed text while the sandbox applies at
// process spawn.
const SHIM_SCRIPT = `#!/bin/sh
exec "\${OPENCODE_SANDBOX_REAL_SHELL:?}" -c "\${OPENCODE_SANDBOX_WRAPPED_COMMAND:?}"
`

type ShimKind = "sandbox" | "blocked"

// POSIX single-quoting: the message is embedded in a single-quoted echo, so
// embedded quotes get the '"'"' splice idiom.
function blockedScript(message: string): string {
  const escaped = message.replace(/'/g, `'\\''`)
  return `#!/bin/sh
echo '${escaped}' >&2
exit 126
`
}

function cacheDir(): string {
  const base = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache")
  return path.join(base, "opencode-sandbox")
}

const pending = new Map<string, Promise<string>>()

// Returns an executable shim whose basename matches the real shell, so
// OpenCode's ShellSelect.args() and shell-syntax scanning treat it like the
// shell it stands in for. A custom blocked `message` changes the shim content,
// so it takes part in both the cache key and the file name.
export function ensureShim(
  shellPath: string,
  kind: ShimKind,
  message: string = ENFORCEMENT_MESSAGE,
): Promise<string> {
  const key = `${kind}:${shellPath}:${message}`
  let entry = pending.get(key)
  if (entry === undefined) {
    entry = writeShim(shellPath, kind, message)
    pending.set(key, entry)
    // Transient failures (unwritable cache, full disk) must not poison the
    // shell permanently; the next call retries.
    entry.catch(() => pending.delete(key))
  }
  return entry
}

async function writeShim(shellPath: string, kind: ShimKind, message: string): Promise<string> {
  const script = kind === "sandbox" ? SHIM_SCRIPT : blockedScript(message)
  const name =
    message === ENFORCEMENT_MESSAGE
      ? path.basename(shellPath)
      : `${createHash("sha256").update(message).digest("hex").slice(0, 12)}-${path.basename(shellPath)}`
  const file = path.join(cacheDir(), "shim", kind, name)
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  await fs.promises.writeFile(file, script, {
    mode: 0o755,
  })
  // writeFile's mode only applies to newly created files; enforce it on updates too.
  await fs.promises.chmod(file, 0o755)
  return file
}
