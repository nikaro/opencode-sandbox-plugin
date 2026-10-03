import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime"

export interface SandboxPluginConfig {
  disabled?: boolean
  filesystem?: {
    denyRead?: string[]
    allowRead?: string[]
    allowWrite?: string[]
    denyWrite?: string[]
  }
  network?: {
    allowedDomains?: string[]
    deniedDomains?: string[]
    allowUnixSockets?: string[]
    allowAllUnixSockets?: boolean
    allowLocalBinding?: boolean
  }
}

const DEFAULT_DENY_READ_DIRS = [
  ".ssh",
  ".gnupg",
  ".aws/credentials",
  ".azure",
  ".config/gcloud",
  ".config/gh",
  ".kube",
  ".docker/config.json",
  ".npmrc",
  ".netrc",
  ".env",
]

const DEFAULT_ALLOWED_DOMAINS = [
  "registry.npmjs.org",
  "*.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "*.pypi.org",
  "crates.io",
  "*.crates.io",
  "github.com",
  "*.github.com",
  "gitlab.com",
  "*.gitlab.com",
  "bitbucket.org",
  "*.bitbucket.org",
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "*.googleapis.com",
]

const UNSAFE_WRITE_PATHS = new Set([
  "/",
  "/home",
  "/usr",
  "/etc",
  "/var",
  "/opt",
  "/Library",
  "/System",
  "/private",
  "/Volumes",
  "/Users",
])

function isSafeWritePath(p: string): boolean {
  const normalized = path.resolve(p)
  if (UNSAFE_WRITE_PATHS.has(normalized)) {
    console.warn(`[opencode-sandbox] Rejecting unsafe write path: ${normalized}`)
    return false
  }
  return true
}

export function resolveConfig(
  projectDir: string,
  worktree: string,
  user?: SandboxPluginConfig,
): SandboxRuntimeConfig {
  const homeDir = os.homedir()

  const candidatePaths = [projectDir, worktree, os.tmpdir()].filter(Boolean)
  const safePaths = candidatePaths.filter((p) => isSafeWritePath(p))
  const writePaths = user?.filesystem?.allowWrite ?? [
    ...new Set(safePaths.map((p) => path.resolve(p))),
  ]

  return {
    filesystem: {
      denyRead:
        user?.filesystem?.denyRead ?? DEFAULT_DENY_READ_DIRS.map((p) => path.join(homeDir, p)),
      allowRead: user?.filesystem?.allowRead ?? [],
      allowWrite: writePaths,
      denyWrite: user?.filesystem?.denyWrite ?? [],
    },
    network: {
      allowedDomains: user?.network?.allowedDomains ?? DEFAULT_ALLOWED_DOMAINS,
      deniedDomains: user?.network?.deniedDomains ?? [],
      allowUnixSockets: user?.network?.allowUnixSockets,
      allowAllUnixSockets: user?.network?.allowAllUnixSockets,
      allowLocalBinding: user?.network?.allowLocalBinding ?? false,
    },
  }
}

export function isSandboxGloballyDisabled(): boolean {
  return (
    process.env.OPENCODE_DISABLE_SANDBOX === "1" || process.env.OPENCODE_DISABLE_SANDBOX === "true"
  )
}

async function tryLoadJsonFile(filePath: string): Promise<SandboxPluginConfig | null> {
  let content: string
  try {
    content = await fs.readFile(filePath, "utf-8")
  } catch {
    return null
  }
  try {
    return JSON.parse(content) as SandboxPluginConfig
  } catch {
    console.warn(`[opencode-sandbox] Invalid JSON in config file: ${filePath}`)
    return null
  }
}

export async function loadConfig(projectDir: string): Promise<SandboxPluginConfig> {
  const envConfig = process.env.OPENCODE_SANDBOX_CONFIG
  if (envConfig) {
    try {
      return JSON.parse(envConfig) as SandboxPluginConfig
    } catch {
      console.warn("[opencode-sandbox] Invalid JSON in OPENCODE_SANDBOX_CONFIG, using defaults")
    }
  }

  const envConfigPath = process.env.OPENCODE_SANDBOX_CONFIG_PATH
  if (envConfigPath) {
    const customConfig = await tryLoadJsonFile(envConfigPath)
    if (customConfig) return customConfig
    console.warn(
      `[opencode-sandbox] Failed to load config from OPENCODE_SANDBOX_CONFIG_PATH: ${envConfigPath}`,
    )
  }

  const configBase = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  const legacyDir = path.join(configBase, "opencode-sandbox")
  const standardDir = path.join(configBase, "opencode")
  const projectName = path.basename(projectDir)

  const sources = [
    path.join(standardDir, "projects", `${projectName}.sandbox.json`),
    path.join(legacyDir, "projects", `${projectName}.json`),
    path.join(standardDir, "sandbox.json"),
    path.join(legacyDir, "config.json"),
  ]

  for (const source of sources) {
    const config = await tryLoadJsonFile(source)
    if (config) return config
  }

  return {}
}
