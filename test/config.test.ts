import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { loadConfig, resolveConfig, type SandboxPluginConfig } from "../src/config"

const PROJECT_DIR = `/tmp/test-project-sandbox-${process.pid}`
const CONFIG_DIR = `/tmp/test-sandbox-config-${process.pid}`
const WORKTREE = PROJECT_DIR

describe("resolveConfig", () => {
  test("returns sensible defaults when no user config", () => {
    const config = resolveConfig(PROJECT_DIR, WORKTREE)

    // Filesystem
    expect(config.filesystem?.denyRead).toContain(path.join(os.homedir(), ".ssh"))
    expect(config.filesystem?.denyRead).toContain(path.join(os.homedir(), ".gnupg"))
    expect(config.filesystem?.denyRead).toContain(path.join(os.homedir(), ".aws/credentials"))
    expect(config.filesystem?.denyRead).toContain(path.join(os.homedir(), ".azure"))
    expect(config.filesystem?.denyRead).toContain(path.join(os.homedir(), ".config/gcloud"))
    expect(config.filesystem?.denyRead).toContain(path.join(os.homedir(), ".config/gh"))
    expect(config.filesystem?.denyRead).toContain(path.join(os.homedir(), ".kube"))
    expect(config.filesystem?.denyRead).toContain(path.join(os.homedir(), ".docker/config.json"))
    expect(config.filesystem?.denyRead).toContain(path.join(os.homedir(), ".npmrc"))
    expect(config.filesystem?.denyRead).toContain(path.join(os.homedir(), ".netrc"))
    expect(config.filesystem?.denyRead).toContain(path.join(os.homedir(), ".env"))
    expect(config.filesystem?.allowRead).toEqual([])
    expect(config.filesystem?.allowWrite).toContain(PROJECT_DIR)
    expect(config.filesystem?.allowWrite).toContain(os.tmpdir())
    expect(config.filesystem?.denyWrite).toEqual([])

    // Network
    expect(config.network?.allowedDomains).toContain("registry.npmjs.org")
    expect(config.network?.allowedDomains).toContain("github.com")
    expect(config.network?.allowedDomains).toContain("api.openai.com")
    expect(config.network?.allowedDomains).toContain("api.anthropic.com")
    expect(config.network?.allowLocalBinding).toBe(false)
    expect(config.network?.deniedDomains).toEqual([])
  })

  test("user filesystem config overrides defaults", () => {
    const user: SandboxPluginConfig = {
      filesystem: {
        denyRead: ["/custom/secret"],
        allowRead: ["/custom/secret.pub"],
        allowWrite: ["/custom/output"],
        denyWrite: ["/custom/no-write"],
      },
    }
    const config = resolveConfig(PROJECT_DIR, WORKTREE, user)

    expect(config.filesystem?.denyRead).toEqual(["/custom/secret"])
    expect(config.filesystem?.allowRead).toEqual(["/custom/secret.pub"])
    expect(config.filesystem?.allowWrite).toEqual(["/custom/output"])
    expect(config.filesystem?.denyWrite).toEqual(["/custom/no-write"])
  })

  test("user network config overrides defaults", () => {
    const user: SandboxPluginConfig = {
      network: {
        allowedDomains: ["my-api.internal.com"],
        deniedDomains: ["evil.com"],
      },
    }
    const config = resolveConfig(PROJECT_DIR, WORKTREE, user)

    expect(config.network?.allowedDomains).toEqual(["my-api.internal.com"])
    expect(config.network?.deniedDomains).toEqual(["evil.com"])
  })

  test("partial user config keeps other defaults", () => {
    const user: SandboxPluginConfig = {
      filesystem: {
        denyRead: ["/only-this"],
        allowRead: ["/except-this"],
      },
    }
    const config = resolveConfig(PROJECT_DIR, WORKTREE, user)

    // overridden
    expect(config.filesystem?.denyRead).toEqual(["/only-this"])
    expect(config.filesystem?.allowRead).toEqual(["/except-this"])
    // defaults kept
    expect(config.filesystem?.allowWrite).toContain(PROJECT_DIR)
    expect(config.network?.allowedDomains).toContain("github.com")
  })

  test("includes both projectDir and worktree in allowWrite", () => {
    const config = resolveConfig("/project", "/worktree")
    expect(config.filesystem?.allowWrite).toContain("/project")
    expect(config.filesystem?.allowWrite).toContain("/worktree")
  })

  test("rejects root path '/' as worktree to prevent sandbox bypass", () => {
    const config = resolveConfig("/project", "/")
    expect(config.filesystem?.allowWrite).toContain("/project")
    expect(config.filesystem?.allowWrite).not.toContain("/")
  })

  test("rejects unsafe broad paths from allowWrite", () => {
    const config = resolveConfig("/home", "/usr")
    expect(config.filesystem?.allowWrite).not.toContain("/home")
    expect(config.filesystem?.allowWrite).not.toContain("/usr")
  })

  test("rejects macOS system paths from allowWrite", () => {
    for (const unsafePath of ["/Library", "/System", "/private", "/Volumes", "/Users"]) {
      const config = resolveConfig(unsafePath, "/project")
      expect(config.filesystem?.allowWrite).not.toContain(unsafePath)
    }
  })

  test("deduplicates identical projectDir and worktree", () => {
    const config = resolveConfig("/project", "/project")
    const writeList = config.filesystem?.allowWrite ?? []
    const projectCount = writeList.filter((p) => p === "/project").length
    expect(projectCount).toBe(1)
  })

  test("resolves relative user paths against projectDir", () => {
    const user: SandboxPluginConfig = {
      filesystem: {
        denyRead: [".env*", "*.key"],
        allowRead: [".env.example"],
        allowWrite: ["."],
        denyWrite: ["*.pem", "sandbox.json"],
      },
    }
    const config = resolveConfig("/project", WORKTREE, user)

    expect(config.filesystem?.denyRead).toEqual([
      path.resolve("/project", ".env*"),
      path.resolve("/project", "*.key"),
    ])
    expect(config.filesystem?.allowRead).toEqual([path.resolve("/project", ".env.example")])
    expect(config.filesystem?.allowWrite).toEqual([path.resolve("/project", ".")])
    expect(config.filesystem?.denyWrite).toEqual([
      path.resolve("/project", "*.pem"),
      path.resolve("/project", "sandbox.json"),
    ])
  })

  test("leaves absolute and tilde paths untouched", () => {
    const user: SandboxPluginConfig = {
      filesystem: {
        denyRead: ["/absolute", "~/.ssh"],
        allowWrite: ["~/. cache", "/tmp"],
        denyWrite: ["/etc/passwd", "~/.env"],
      },
    }
    const config = resolveConfig("/project", WORKTREE, user)

    expect(config.filesystem?.denyRead).toEqual(["/absolute", "~/.ssh"])
    expect(config.filesystem?.allowWrite).toEqual(["~/. cache", "/tmp"])
    expect(config.filesystem?.denyWrite).toEqual(["/etc/passwd", "~/.env"])
  })

  test("handles unix socket config", () => {
    const user: SandboxPluginConfig = {
      network: {
        allowUnixSockets: ["/var/run/docker.sock"],
        allowAllUnixSockets: false,
      },
    }
    const config = resolveConfig(PROJECT_DIR, WORKTREE, user)

    expect(config.network?.allowUnixSockets).toEqual(["/var/run/docker.sock"])
    expect(config.network?.allowAllUnixSockets).toBe(false)
  })
})

describe("loadConfig", () => {
  const sandboxConfigDir = path.join(CONFIG_DIR, "opencode-sandbox")
  const projectName = path.basename(PROJECT_DIR)

  beforeEach(async () => {
    delete process.env.OPENCODE_SANDBOX_CONFIG
    delete process.env.OPENCODE_SANDBOX_CONFIG_PATH
    process.env.XDG_CONFIG_HOME = CONFIG_DIR
    await fs.rm(CONFIG_DIR, { recursive: true, force: true })
    await fs.mkdir(path.join(sandboxConfigDir, "projects"), { recursive: true })
  })

  afterAll(async () => {
    delete process.env.XDG_CONFIG_HOME
    delete process.env.OPENCODE_SANDBOX_CONFIG
    delete process.env.OPENCODE_SANDBOX_CONFIG_PATH
    await fs.rm(CONFIG_DIR, { recursive: true, force: true })
  })

  test("returns empty config when no file and no env var", async () => {
    const config = await loadConfig(PROJECT_DIR)
    expect(config).toEqual({})
  })

  test("loads config from OPENCODE_SANDBOX_CONFIG env var", async () => {
    process.env.OPENCODE_SANDBOX_CONFIG = JSON.stringify({
      disabled: false,
      filesystem: { denyRead: ["/secret"], allowRead: ["/secret.pub"] },
    })
    const config = await loadConfig(PROJECT_DIR)
    expect(config.disabled).toBe(false)
    expect(config.filesystem?.denyRead).toEqual(["/secret"])
    expect(config.filesystem?.allowRead).toEqual(["/secret.pub"])
  })

  test("loads config from OPENCODE_SANDBOX_CONFIG_PATH env var", async () => {
    const customConfigPath = path.join(CONFIG_DIR, "custom-sandbox.json")
    await fs.writeFile(
      customConfigPath,
      JSON.stringify({ filesystem: { denyRead: ["/from-path"] } }),
    )
    process.env.OPENCODE_SANDBOX_CONFIG_PATH = customConfigPath
    const config = await loadConfig(PROJECT_DIR)
    expect(config.filesystem?.denyRead).toEqual(["/from-path"])
  })

  test("OPENCODE_SANDBOX_CONFIG takes priority over OPENCODE_SANDBOX_CONFIG_PATH", async () => {
    const customConfigPath = path.join(CONFIG_DIR, "custom-sandbox.json")
    await fs.writeFile(
      customConfigPath,
      JSON.stringify({ filesystem: { denyRead: ["/from-path"] } }),
    )
    process.env.OPENCODE_SANDBOX_CONFIG_PATH = customConfigPath
    process.env.OPENCODE_SANDBOX_CONFIG = JSON.stringify({
      filesystem: { denyRead: ["/from-env"] },
    })
    const config = await loadConfig(PROJECT_DIR)
    expect(config.filesystem?.denyRead).toEqual(["/from-env"])
  })

  test("OPENCODE_SANDBOX_CONFIG_PATH takes priority over per-project config", async () => {
    const customConfigPath = path.join(CONFIG_DIR, "custom-sandbox.json")
    await fs.writeFile(
      customConfigPath,
      JSON.stringify({ filesystem: { denyRead: ["/from-path"] } }),
    )
    process.env.OPENCODE_SANDBOX_CONFIG_PATH = customConfigPath
    await fs.writeFile(
      path.join(sandboxConfigDir, "projects", `${projectName}.json`),
      JSON.stringify({ filesystem: { denyRead: ["/from-project"] } }),
    )
    const config = await loadConfig(PROJECT_DIR)
    expect(config.filesystem?.denyRead).toEqual(["/from-path"])
  })

  test("handles invalid JSON in OPENCODE_SANDBOX_CONFIG_PATH gracefully", async () => {
    const customConfigPath = path.join(CONFIG_DIR, "broken.json")
    await fs.writeFile(customConfigPath, "broken{json")
    process.env.OPENCODE_SANDBOX_CONFIG_PATH = customConfigPath
    const config = await loadConfig(PROJECT_DIR)
    expect(config).toEqual({})
  })

  test("handles missing OPENCODE_SANDBOX_CONFIG_PATH file gracefully", async () => {
    process.env.OPENCODE_SANDBOX_CONFIG_PATH = path.join(CONFIG_DIR, "does-not-exist.json")
    const config = await loadConfig(PROJECT_DIR)
    expect(config).toEqual({})
  })

  test("loads per-project config", async () => {
    await fs.writeFile(
      path.join(sandboxConfigDir, "projects", `${projectName}.json`),
      JSON.stringify({ network: { allowedDomains: ["example.com"] } }),
    )
    const config = await loadConfig(PROJECT_DIR)
    expect(config.network?.allowedDomains).toEqual(["example.com"])
  })

  test("loads per-project config from opencode/projects/<name>.sandbox.json", async () => {
    const projectsDir = path.join(CONFIG_DIR, "opencode", "projects")
    await fs.mkdir(projectsDir, { recursive: true })
    await fs.writeFile(
      path.join(projectsDir, `${projectName}.sandbox.json`),
      JSON.stringify({ network: { allowedDomains: ["example.com"] } }),
    )
    const config = await loadConfig(PROJECT_DIR)
    expect(config.network?.allowedDomains).toEqual(["example.com"])
  })

  test("standard per-project config takes priority over legacy per-project config", async () => {
    const projectsDir = path.join(CONFIG_DIR, "opencode", "projects")
    await fs.mkdir(projectsDir, { recursive: true })
    await fs.writeFile(
      path.join(projectsDir, `${projectName}.sandbox.json`),
      JSON.stringify({ filesystem: { denyRead: ["/from-standard-project"] } }),
    )
    await fs.writeFile(
      path.join(sandboxConfigDir, "projects", `${projectName}.json`),
      JSON.stringify({ filesystem: { denyRead: ["/from-legacy-project"] } }),
    )
    const config = await loadConfig(PROJECT_DIR)
    expect(config.filesystem?.denyRead).toEqual(["/from-standard-project"])
  })

  test("per-project config takes priority over standard global config", async () => {
    const projectsDir = path.join(CONFIG_DIR, "opencode", "projects")
    await fs.mkdir(projectsDir, { recursive: true })
    await fs.writeFile(
      path.join(projectsDir, `${projectName}.sandbox.json`),
      JSON.stringify({ filesystem: { denyRead: ["/from-project"] } }),
    )
    const openCodeConfigDir = path.join(CONFIG_DIR, "opencode")
    await fs.writeFile(
      path.join(openCodeConfigDir, "sandbox.json"),
      JSON.stringify({ filesystem: { denyRead: ["/from-standard-global"] } }),
    )
    const config = await loadConfig(PROJECT_DIR)
    expect(config.filesystem?.denyRead).toEqual(["/from-project"])
  })

  test("loads global config", async () => {
    await fs.writeFile(
      path.join(sandboxConfigDir, "config.json"),
      JSON.stringify({ filesystem: { denyRead: ["/global-secret"] } }),
    )
    const config = await loadConfig(PROJECT_DIR)
    expect(config.filesystem?.denyRead).toEqual(["/global-secret"])
  })

  test("loads standard global config from opencode/sandbox.json", async () => {
    const openCodeConfigDir = path.join(CONFIG_DIR, "opencode")
    await fs.mkdir(openCodeConfigDir, { recursive: true })
    await fs.writeFile(
      path.join(openCodeConfigDir, "sandbox.json"),
      JSON.stringify({ filesystem: { denyRead: ["/from-standard-global"] } }),
    )
    const config = await loadConfig(PROJECT_DIR)
    expect(config.filesystem?.denyRead).toEqual(["/from-standard-global"])
  })

  test("standard global config takes priority over legacy global config", async () => {
    const openCodeConfigDir = path.join(CONFIG_DIR, "opencode")
    await fs.mkdir(openCodeConfigDir, { recursive: true })
    await fs.writeFile(
      path.join(openCodeConfigDir, "sandbox.json"),
      JSON.stringify({ filesystem: { denyRead: ["/from-standard-global"] } }),
    )
    await fs.writeFile(
      path.join(sandboxConfigDir, "config.json"),
      JSON.stringify({ filesystem: { denyRead: ["/from-legacy-global"] } }),
    )
    const config = await loadConfig(PROJECT_DIR)
    expect(config.filesystem?.denyRead).toEqual(["/from-standard-global"])
  })

  test("per-project config takes priority over standard global config", async () => {
    const openCodeConfigDir = path.join(CONFIG_DIR, "opencode")
    await fs.mkdir(openCodeConfigDir, { recursive: true })
    await fs.writeFile(
      path.join(openCodeConfigDir, "sandbox.json"),
      JSON.stringify({ filesystem: { denyRead: ["/from-standard-global"] } }),
    )
    await fs.writeFile(
      path.join(sandboxConfigDir, "projects", `${projectName}.json`),
      JSON.stringify({ filesystem: { denyRead: ["/from-project"] } }),
    )
    const config = await loadConfig(PROJECT_DIR)
    expect(config.filesystem?.denyRead).toEqual(["/from-project"])
  })

  test("env var takes priority over per-project config", async () => {
    process.env.OPENCODE_SANDBOX_CONFIG = JSON.stringify({
      filesystem: { denyRead: ["/from-env"] },
    })
    await fs.writeFile(
      path.join(sandboxConfigDir, "projects", `${projectName}.json`),
      JSON.stringify({ filesystem: { denyRead: ["/from-project"] } }),
    )
    const config = await loadConfig(PROJECT_DIR)
    expect(config.filesystem?.denyRead).toEqual(["/from-env"])
  })

  test("per-project config takes priority over global config", async () => {
    await fs.writeFile(
      path.join(sandboxConfigDir, "projects", `${projectName}.json`),
      JSON.stringify({ filesystem: { denyRead: ["/from-project"] } }),
    )
    await fs.writeFile(
      path.join(sandboxConfigDir, "config.json"),
      JSON.stringify({ filesystem: { denyRead: ["/from-global"] } }),
    )
    const config = await loadConfig(PROJECT_DIR)
    expect(config.filesystem?.denyRead).toEqual(["/from-project"])
  })

  test("handles invalid JSON in env var gracefully", async () => {
    process.env.OPENCODE_SANDBOX_CONFIG = "not-valid-json"
    const config = await loadConfig(PROJECT_DIR)
    expect(config).toEqual({})
  })

  test("handles invalid JSON in file gracefully", async () => {
    await fs.writeFile(path.join(sandboxConfigDir, "config.json"), "broken{json")
    const config = await loadConfig(PROJECT_DIR)
    expect(config).toEqual({})
  })
})
