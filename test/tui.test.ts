import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Mock the TUI plugin SDK: define() is an identity function in tests
mock.module("@opencode/plugin/tui", () => ({
  Plugin: { define: (plugin: unknown) => plugin },
}))

// Stub the JSX runtime: rendering produces plain { type, props } trees so
// tests can assert on the badge content without a renderer.
const fakeJsx = (type: unknown, props: Record<string, unknown>) => ({ type, props })
mock.module("@opentui/solid/jsx-runtime", () => ({
  jsx: fakeJsx,
  jsxs: fakeJsx,
  Fragment: (props: { children?: unknown }) => props.children ?? null,
}))
mock.module("@opentui/solid/jsx-dev-runtime", () => ({
  jsxDEV: fakeJsx,
  Fragment: (props: { children?: unknown }) => props.children ?? null,
}))

const pluginModule = await import("../src/tui")
// Root tui.ts is what the OpenCode 2 CLI loads from a local plugin directory;
// it must stay a working re-export of the TUI module.
const rootModule = await import("../tui")

// Exercises both theme spellings: success via .default, warning via .base
const theme = {
  text: {
    default: "#text-default",
    base: "#text-base",
    subdued: "#text-subdued",
    muted: "#text-muted",
    feedback: { success: { default: "#success" }, warning: { base: "#warning" } },
  },
}

type Claim = { path: string; render: () => unknown; disposed: boolean }

const makeCtx = (directory = "/tmp/project") => {
  const claims: Claim[] = []
  const ctx = {
    location: { directory },
    theme,
    ui: {
      slot: (claim: { append: string; render: () => unknown }) => {
        const entry: Claim = { path: claim.append, render: claim.render, disposed: false }
        claims.push(entry)
        return () => {
          entry.disposed = true
        }
      },
    },
  }
  return { ctx, claims }
}

const badgeOf = (claim: Claim) => claim.render() as { type: string; props: Record<string, unknown> }

describe("TUI plugin", () => {
  let testConfigHome: string | undefined
  let isolatedConfigHome: string | undefined

  beforeAll(() => {
    testConfigHome = process.env.XDG_CONFIG_HOME
    isolatedConfigHome = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-sandbox-tui-test-"))
    process.env.XDG_CONFIG_HOME = isolatedConfigHome
  })

  afterAll(() => {
    if (isolatedConfigHome) fs.rmSync(isolatedConfigHome, { force: true, recursive: true })
    if (testConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = testConfigHome
  })

  beforeEach(() => {
    delete process.env.OPENCODE_DISABLE_SANDBOX
    delete process.env.OPENCODE_SANDBOX_CONFIG
    delete process.env.OPENCODE_SANDBOX_CONFIG_PATH
  })

  test("exports the module shape: default { id, setup }", () => {
    expect(pluginModule.default.id).toBe("opencode-sandbox")
    expect(typeof pluginModule.default.setup).toBe("function")
  })

  test("root tui.ts re-exports the TUI plugin for local path loading", () => {
    expect(rootModule.default).toBe(pluginModule.default)
  })

  test("registers no badge when OPENCODE_DISABLE_SANDBOX=1", async () => {
    process.env.OPENCODE_DISABLE_SANDBOX = "1"
    const { ctx, claims } = makeCtx()
    const cleanup = await pluginModule.default.setup(ctx)
    expect(claims).toHaveLength(0)
    expect(cleanup).toBeUndefined()
  })

  test("claims a status-bar badge on both footers", async () => {
    const { ctx, claims } = makeCtx()
    await pluginModule.default.setup(ctx)
    expect(claims.map((c) => c.path)).toEqual(["home.footer.status", "prompt.footer.status"])
  })

  test("default config shows the permissive mode in warning color", async () => {
    const { ctx, claims } = makeCtx()
    await pluginModule.default.setup(ctx)

    const badge = badgeOf(claims[0])
    expect(badge.type).toBe("box")
    const label = JSON.stringify(badge)
    expect(label).toContain("sandbox: ")
    expect(label).toContain("permissive")
    expect(label).toContain("#warning")
    expect(label).toContain("#text-default")
  })

  test("enforce config shows the enforce mode in success color", async () => {
    process.env.OPENCODE_SANDBOX_CONFIG = JSON.stringify({ mode: "enforce" })
    const { ctx, claims } = makeCtx()
    await pluginModule.default.setup(ctx)

    const label = JSON.stringify(badgeOf(claims[1]))
    expect(label).toContain("enforce")
    expect(label).toContain("#success")
  })

  test("disabled config shows the plugin as off in subdued color", async () => {
    process.env.OPENCODE_SANDBOX_CONFIG = JSON.stringify({ disabled: true })
    const { ctx, claims } = makeCtx()
    await pluginModule.default.setup(ctx)

    const label = JSON.stringify(badgeOf(claims[0]))
    expect(label).toContain("off")
    expect(label).toContain("#text-subdued")
  })

  test("cleanup disposes both claims", async () => {
    const { ctx, claims } = makeCtx()
    const cleanup = await pluginModule.default.setup(ctx)
    await cleanup?.()
    expect(claims.every((claim) => claim.disposed)).toBe(true)
  })
})
