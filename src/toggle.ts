import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

function toggleDir(): string {
  const base = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache")
  return path.join(base, "opencode-sandbox", "toggle")
}

function keyForDirectory(dir: string): string {
  return createHash("sha256").update(path.resolve(dir)).digest("hex").slice(0, 16)
}

function toggleFile(projectDir: string): string {
  return path.join(toggleDir(), `${keyForDirectory(projectDir)}.json`)
}

export async function isSandboxToggledOff(projectDir: string): Promise<boolean> {
  try {
    const content = await fs.readFile(toggleFile(projectDir), "utf-8")
    const state = JSON.parse(content) as { disabled: boolean }
    return state.disabled === true
  } catch {
    return false
  }
}

export async function setSandboxToggledOff(projectDir: string, disabled: boolean): Promise<void> {
  const file = toggleFile(projectDir)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify({ disabled }), "utf-8")
}

/** Removes toggle state files older than maxAgeMs. */
export async function cleanupOldToggleFiles(maxAgeMs = 7 * 24 * 60 * 60 * 1000): Promise<void> {
  const dir = toggleDir()
  try {
    const entries = await fs.readdir(dir)
    const now = Date.now()
    for (const entry of entries) {
      const filePath = path.join(dir, entry)
      try {
        const stat = await fs.stat(filePath)
        if (now - stat.mtimeMs > maxAgeMs) {
          await fs.unlink(filePath)
        }
      } catch {
        // Ignore individual file errors
      }
    }
  } catch {
    // Directory might not exist yet
  }
}
