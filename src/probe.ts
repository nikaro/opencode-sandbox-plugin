import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime"

const PROBE_TIMEOUT_MS = 15_000

const LINUX_HINT =
  " (on Linux, check that bubblewrap is installed and usable — see 'Linux prerequisites' in the opencode-sandbox README)"

// POSIX single-quote splice so targets embed safely in the probe command.
const shQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

export type RunSandboxed = (
  command: string,
  config: Partial<SandboxRuntimeConfig>,
) => Promise<{ code: number | null; stderr: string }>

/** The probe command itself. Exit codes: 0 = both denials enforced, 101 = a
 * forbidden write succeeded, 102 = a forbidden read succeeded. */
export function probeCommand(writeTarget: string, readTarget: string): string {
  return [
    `if echo probe > ${shQuote(writeTarget)} 2>/dev/null; then exit 101; fi`,
    `if cat ${shQuote(readTarget)} > /dev/null 2>&1; then exit 102; fi`,
    "exit 0",
  ].join("; ")
}

// The probe command is POSIX sh syntax, so it always runs under /bin/sh — never
// the user's shell (fish would reject it and falsely fail the probe).
// Seatbelt/bwrap enforcement does not depend on the shell binary.
const PROBE_SHELL = "/bin/sh"

async function spawnSandboxed(
  command: string,
  config: Partial<SandboxRuntimeConfig>,
): Promise<{ code: number | null; stderr: string }> {
  const { argv, env } = await SandboxManager.wrapWithSandboxArgv(command, PROBE_SHELL, config)
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(argv[0], argv.slice(1), {
        shell: false,
        env,
        stdio: ["ignore", "ignore", "pipe"],
      })
      let stderr = ""
      child.stderr?.on("data", (chunk) => {
        if (stderr.length < 2000) stderr += String(chunk)
      })
      const timer = setTimeout(() => {
        child.kill("SIGKILL")
        reject(new Error(`probe timed out after ${PROBE_TIMEOUT_MS}ms`))
      }, PROBE_TIMEOUT_MS)
      child.on("error", (err) => {
        clearTimeout(timer)
        reject(err)
      })
      child.on("close", (code) => {
        clearTimeout(timer)
        resolve({ code, stderr })
      })
    })
  } finally {
    // Release this wrapped command's mount-point refcount, mirroring what the
    // shell "ended" handler does for agent commands.
    SandboxManager.cleanupAfterCommand()
  }
}

/** Verify the sandbox actually enforces before trusting it with agent
 * commands: initialization succeeding says nothing about seatbelt/bwrap
 * working at spawn time. Throws when enforcement is absent or unverifiable —
 * callers fail closed (block commands) on any throw. */
export async function runEnforcementProbe(
  runSandboxed: RunSandboxed = spawnSandboxed,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-sandbox-probe-"))
  const writeTarget = path.join(dir, "denied-write")
  const readTarget = path.join(dir, "denied-read")
  try {
    await fs.writeFile(readTarget, "opencode-sandbox enforcement probe\n")
    // The per-call filesystem config replaces the initialized policy for this
    // one command, so the probe's expectations hold regardless of user config:
    // both targets are explicitly denied and no writes are allowed anywhere.
    const config: Partial<SandboxRuntimeConfig> = {
      filesystem: { allowWrite: [], denyWrite: [writeTarget], denyRead: [readTarget] },
    }
    const { code, stderr } = await runSandboxed(probeCommand(writeTarget, readTarget), config)
    const hint = process.platform === "linux" ? LINUX_HINT : ""
    if (code === 0) return
    if (code === 101)
      throw new Error(
        `the sandbox did not block a write outside the allowed write paths (probe exit 101)${hint}`,
      )
    if (code === 102)
      throw new Error(`the sandbox did not block a read of a denied path (probe exit 102)${hint}`)
    const lastLine = stderr.trim().split("\n").at(-1)
    throw new Error(
      `sandbox enforcement could not be verified (probe exit ${code ?? "killed"})${lastLine ? `: ${lastLine}` : ""}${hint}`,
    )
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
