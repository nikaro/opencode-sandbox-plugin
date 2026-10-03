import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { isSandboxToggledOff, setSandboxToggledOff } from "../src/toggle"

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
type Element = { type: unknown; props: Record<string, unknown> }
type PaletteCommand = {
  id?: string
  title?: string
  palette?: boolean
  slash?: { name?: string }
  run?: () => Promise<unknown>
}
type KeymapLayer = { commands?: readonly PaletteCommand[] }

// The badge defers its label and color to a function child (see src/tui.tsx);
// resolve thunks so assertions see the actual strings and colors.
const resolveChildren = (node: unknown): unknown => {
  if (typeof node === "function") return resolveChildren(node())
  if (Array.isArray(node)) return node.map(resolveChildren)
  if (node && typeof node === "object" && "props" in (node as Element)) {
    const el = node as Element
    return { ...el, props: { ...el.props, children: resolveChildren(el.props.children) } }
  }
  return node
}

const badgeOf = (claim: Claim) => resolveChildren(claim.render()) as Element
// Serialized badge tree, for substring assertions on labels and colors.
const labelOf = (claim: Claim) => JSON.stringify(badgeOf(claim))

const makeCtx = (directory = "/tmp/project", withLocation = true) => {
  const claims: Claim[] = []
  const keymapLayers: (() => KeymapLayer)[] = []
  const ctx = {
    location: withLocation ? { directory } : undefined,
    data: {
      location: {
        default: () => ({ directory }),
      },
    },
    theme,
    keymap: {
      layer: (input: () => KeymapLayer) => {
        keymapLayers.push(input)
      },
    },
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
  return { ctx, claims, keymapLayers }
}

// Renders a badge (registering its palette layer) and returns the command.
const paletteCommandOf = (claims: Claim[], keymapLayers: (() => KeymapLayer)[]) => {
  badgeOf(claims[0])
  const command = keymapLayers.at(-1)?.().commands?.[0]
  if (!command) throw new Error("palette command missing")
  return command
}

describe("TUI plugin", () => {
  let testConfigHome: string | undefined
  let isolatedConfigHome: string | undefined
  let testCacheHome: string | undefined
  let isolatedCacheHome: string | undefined

  beforeAll(() => {
    testConfigHome = process.env.XDG_CONFIG_HOME
    isolatedConfigHome = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-sandbox-tui-test-"))
    process.env.XDG_CONFIG_HOME = isolatedConfigHome

    testCacheHome = process.env.XDG_CACHE_HOME
    isolatedCacheHome = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-sandbox-tui-test-cache-"))
    process.env.XDG_CACHE_HOME = isolatedCacheHome
  })

  afterAll(() => {
    if (isolatedConfigHome) fs.rmSync(isolatedConfigHome, { force: true, recursive: true })
    if (testConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = testConfigHome

    if (isolatedCacheHome) fs.rmSync(isolatedCacheHome, { force: true, recursive: true })
    if (testCacheHome === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = testCacheHome
  })

  beforeEach(async () => {
    delete process.env.OPENCODE_DISABLE_SANDBOX
    delete process.env.OPENCODE_SANDBOX_CONFIG
    delete process.env.OPENCODE_SANDBOX_CONFIG_PATH
    await setSandboxToggledOff("/tmp/project", false)
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

  test("default config shows the sandbox as on in success color", async () => {
    const { ctx, claims } = makeCtx()
    await pluginModule.default.setup(ctx)

    const badge = badgeOf(claims[0])
    expect(badge.type).toBe("box")
    const label = JSON.stringify(badge)
    expect(label).toContain("sandbox: on")
    expect(label).toContain("#success")
    expect(label).toContain("#text-default")
  })

  test("disabled config shows the plugin as off in subdued color", async () => {
    process.env.OPENCODE_SANDBOX_CONFIG = JSON.stringify({ disabled: true })
    const { ctx, claims } = makeCtx()
    await pluginModule.default.setup(ctx)

    const label = labelOf(claims[0])
    expect(label).toContain("sandbox: off")
    expect(label).toContain("#text-subdued")
  })

  test("toggled off shows paused in warning color", async () => {
    await setSandboxToggledOff("/tmp/project", true)
    const { ctx, claims } = makeCtx()
    await pluginModule.default.setup(ctx)

    const label = labelOf(claims[0])
    expect(label).toContain("sandbox: paused")
    expect(label).toContain("#warning")
  })

  test("registers a Toggle Sandbox command in the palette", async () => {
    const { ctx, claims, keymapLayers } = makeCtx()
    await pluginModule.default.setup(ctx)

    const command = paletteCommandOf(claims, keymapLayers)
    expect(command.id).toBe("opencode-sandbox.toggle")
    expect(command.title).toBe("Toggle Sandbox")
    expect(command.palette).toBe(true)
    expect(command.slash).toBeUndefined()
  })

  test("each badge registers its own palette layer", async () => {
    const { ctx, claims, keymapLayers } = makeCtx()
    await pluginModule.default.setup(ctx)
    badgeOf(claims[1])
    expect(keymapLayers.length).toBe(1)
    expect(keymapLayers[0]().commands?.[0]?.id).toBe("opencode-sandbox.toggle")
  })

  test("palette command toggles the sandbox and the badge follows", async () => {
    const { ctx, claims, keymapLayers } = makeCtx()
    await pluginModule.default.setup(ctx)
    const command = paletteCommandOf(claims, keymapLayers)

    await command.run?.()
    expect(await isSandboxToggledOff("/tmp/project")).toBe(true)
    expect(labelOf(claims[0])).toContain("sandbox: paused")
    expect(labelOf(claims[0])).toContain("#warning")

    await command.run?.()
    expect(await isSandboxToggledOff("/tmp/project")).toBe(false)
    expect(labelOf(claims[0])).toContain("sandbox: on")
    expect(labelOf(claims[0])).toContain("#success")
  })

  test("falls back to the default location when the TUI has none", async () => {
    const fallbackDir = "/tmp/fallback-project"
    await setSandboxToggledOff(fallbackDir, true)
    const { ctx, claims } = makeCtx(fallbackDir, false)
    await pluginModule.default.setup(ctx)

    const label = labelOf(claims[0])
    expect(label).toContain("sandbox: paused")
    await setSandboxToggledOff(fallbackDir, false)
  })

  test("cleanup disposes all claims", async () => {
    const { ctx, claims } = makeCtx()
    const cleanup = await pluginModule.default.setup(ctx)
    await cleanup?.()
    expect(claims.every((claim) => claim.disposed)).toBe(true)
  })
})
