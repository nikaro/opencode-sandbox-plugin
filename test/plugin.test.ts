import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Mock the SandboxManager before importing the plugin
const mockInitialize = mock(() => Promise.resolve())
const mockWrapWithSandbox = mock((cmd: string) => Promise.resolve(`srt-wrapped: ${cmd}`))
const mockCleanupAfterCommand = mock(() => undefined)

mock.module("@anthropic-ai/sandbox-runtime", () => ({
  SandboxManager: {
    initialize: mockInitialize,
    wrapWithSandbox: mockWrapWithSandbox,
    cleanupAfterCommand: mockCleanupAfterCommand,
  },
}))

// Mock the plugin SDK: define() is an identity function in tests
mock.module("@opencode/plugin", () => ({
  Plugin: { define: (plugin: unknown) => plugin },
}))

const pluginModule = await import("../src/index")
// Root index.ts is what OpenCode 2 loads for local path plugins; it must stay
// a working re-export of the server module.
const rootModule = await import("../index")

// Isolated cache dir so shim writes never touch the developer's real home
let testCacheHome: string | undefined
let isolatedCacheHome: string | undefined

const shimDir = () => path.join(isolatedCacheHome ?? "", "opencode-sandbox", "shim")

type ShellHook = (invocation: {
  command: string
  cwd: string
  timeout: number
  shell: string
  env: Record<string, string | undefined>
}) => Promise<void>

const makeEventBus = () => {
  const events: unknown[] = []
  let notify: (() => void) | undefined
  return {
    push(event: unknown) {
      events.push(event)
      notify?.()
    },
    subscribe: () =>
      ({
        [Symbol.asyncIterator]() {
          let index = 0
          return {
            async next() {
              while (index >= events.length)
                await new Promise<void>((resolve) => (notify = resolve))
              return { value: events[index++], done: false }
            },
            async return() {
              return { done: true, value: undefined }
            },
          }
        },
      }) as AsyncIterable<unknown>,
  }
}

const makeCtx = (directory = "/tmp/project") => {
  const hooks: Record<string, ShellHook> = {}
  const bus = makeEventBus()
  const ctx = {
    location: { directory },
    shell: {
      hook: (name: string, callback: ShellHook) => {
        hooks[name] = callback
        return Promise.resolve({ dispose: () => Promise.resolve() })
      },
    },
    event: { subscribe: () => bus.subscribe() },
  }
  return { ctx, hooks, bus }
}

const makeInvocation = (shell = "/bin/bash") => ({
  command: "echo hello",
  cwd: "/tmp/project",
  timeout: 0,
  shell,
  env: { TERM: "xterm-256color" },
})

const setupPlugin = async (directory?: string) => {
  const made = makeCtx(directory)
  const cleanup = await pluginModule.default.setup(made.ctx)
  return { ...made, cleanup }
}

describe("plugin", () => {
  let testConfigHome: string | undefined
  let isolatedConfigHome: string | undefined

  beforeAll(() => {
    testConfigHome = process.env.XDG_CONFIG_HOME
    isolatedConfigHome = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-sandbox-test-config-"))
    process.env.XDG_CONFIG_HOME = isolatedConfigHome

    testCacheHome = process.env.XDG_CACHE_HOME
    isolatedCacheHome = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-sandbox-test-cache-"))
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

  beforeEach(() => {
    mockInitialize.mockReset()
    mockInitialize.mockImplementation(() => Promise.resolve())
    mockWrapWithSandbox.mockReset()
    mockWrapWithSandbox.mockImplementation((cmd: string) => Promise.resolve(`srt-wrapped: ${cmd}`))
    mockCleanupAfterCommand.mockClear()
    delete process.env.OPENCODE_DISABLE_SANDBOX
    delete process.env.OPENCODE_SANDBOX_CONFIG
    delete process.env.OPENCODE_SANDBOX_CONFIG_PATH
  })

  test("exports the module shape: default { id, setup }", () => {
    expect(pluginModule.default.id).toBe("opencode-sandbox")
    expect(typeof pluginModule.default.setup).toBe("function")
  })

  test("root index.ts re-exports the plugin for local path loading", () => {
    expect(rootModule.default).toBe(pluginModule.default)
  })

  test("registers a shell create.before hook", async () => {
    const { hooks } = await setupPlugin()
    expect(hooks["create.before"]).toBeDefined()
  })

  test("registers no hooks when OPENCODE_DISABLE_SANDBOX=1", async () => {
    process.env.OPENCODE_DISABLE_SANDBOX = "1"
    const { hooks } = await setupPlugin()
    expect(hooks["create.before"]).toBeUndefined()
  })

  test("registers no hooks when config disables the plugin", async () => {
    process.env.OPENCODE_SANDBOX_CONFIG = JSON.stringify({ disabled: true })
    const { hooks } = await setupPlugin()
    expect(hooks["create.before"]).toBeUndefined()
  })

  test("swaps the shell for a shim and leaves the command untouched", async () => {
    if (process.platform === "win32") return
    const { hooks } = await setupPlugin()
    const invocation = makeInvocation()

    await hooks["create.before"]?.(invocation)

    // The command must stay raw: OpenCode's permission rules evaluate it.
    expect(invocation.command).toBe("echo hello")
    expect(mockInitialize).toHaveBeenCalledTimes(1)

    const shimPath = path.join(shimDir(), "sandbox", "bash")
    expect(invocation.shell).toBe(shimPath)
    expect(invocation.env.OPENCODE_SANDBOX_REAL_SHELL).toBe("/bin/bash")
    expect(invocation.env.OPENCODE_SANDBOX_WRAPPED_COMMAND).toBe("srt-wrapped: echo hello")
    // Pre-existing invocation env survives the merge
    expect(invocation.env.TERM).toBe("xterm-256color")

    const stat = fs.statSync(shimPath)
    expect(stat.mode & 0o111).not.toBe(0)
    const script = fs.readFileSync(shimPath, "utf8")
    expect(script).toContain("OPENCODE_SANDBOX_REAL_SHELL")
    expect(script).toContain("OPENCODE_SANDBOX_WRAPPED_COMMAND")
  })

  test("leaves the invocation untouched when the wrap is a no-op", async () => {
    if (process.platform === "win32") return
    mockWrapWithSandbox.mockImplementation((cmd: string) => Promise.resolve(cmd))
    const { hooks } = await setupPlugin()
    const invocation = makeInvocation("/bin/zsh")

    await hooks["create.before"]?.(invocation)

    expect(invocation.shell).toBe("/bin/zsh")
    expect(invocation.env.OPENCODE_SANDBOX_WRAPPED_COMMAND).toBeUndefined()
    expect(fs.existsSync(path.join(shimDir(), "sandbox", "zsh"))).toBe(false)
  })

  test("audit mode: wrap failure leaves the invocation unsandboxed", async () => {
    if (process.platform === "win32") return
    mockWrapWithSandbox.mockImplementation(() => Promise.reject(new Error("boom")))
    const { hooks } = await setupPlugin()
    const invocation = makeInvocation()

    await hooks["create.before"]?.(invocation)

    expect(invocation.command).toBe("echo hello")
    expect(invocation.shell).toBe("/bin/bash")
    expect(invocation.env.OPENCODE_SANDBOX_WRAPPED_COMMAND).toBeUndefined()
  })

  test("enforce mode: wrap failure installs the blocked shim", async () => {
    if (process.platform === "win32") return
    process.env.OPENCODE_SANDBOX_CONFIG = JSON.stringify({ mode: "enforce" })
    mockWrapWithSandbox.mockImplementation(() => Promise.reject(new Error("boom")))
    const { hooks } = await setupPlugin()
    const invocation = makeInvocation("/bin/zsh")

    await hooks["create.before"]?.(invocation)

    expect(invocation.command).toBe("echo hello")
    const blockedPath = path.join(shimDir(), "blocked", "zsh")
    expect(invocation.shell).toBe(blockedPath)
    const script = fs.readFileSync(blockedPath, "utf8")
    expect(script).toContain("command blocked")
  })

  test("enforce mode: init failure installs the blocked shim", async () => {
    if (process.platform === "win32") return
    process.env.OPENCODE_SANDBOX_CONFIG = JSON.stringify({ mode: "enforce" })
    mockInitialize.mockImplementation(() => Promise.reject(new Error("no bwrap")))
    const { hooks } = await setupPlugin()
    const invocation = makeInvocation("/bin/ksh")

    await hooks["create.before"]?.(invocation)

    expect(invocation.shell).toBe(path.join(shimDir(), "blocked", "ksh"))
  })

  test("cleans up once per sandboxed shell on session.shell.ended", async () => {
    if (process.platform === "win32") return
    const { hooks, bus } = await setupPlugin()
    const invocation = makeInvocation()
    await hooks["create.before"]?.(invocation)
    const shimPath = invocation.shell

    // A shell that is not ours must not trigger cleanup
    bus.push({
      type: "session.shell.ended",
      data: { sessionID: "s1", shell: { shell: "/bin/bash" } },
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(mockCleanupAfterCommand).not.toHaveBeenCalled()

    bus.push({ type: "session.shell.ended", data: { sessionID: "s1", shell: { shell: shimPath } } })
    bus.push({ type: "session.shell.ended", data: { sessionID: "s1", shell: { shell: shimPath } } })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(mockCleanupAfterCommand).toHaveBeenCalledTimes(2)
  })

  test("ignores unrelated event types", async () => {
    if (process.platform === "win32") return
    const { hooks, bus } = await setupPlugin()
    const invocation = makeInvocation()
    await hooks["create.before"]?.(invocation)

    bus.push({ type: "session.idle", data: { sessionID: "s1" } })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(mockCleanupAfterCommand).not.toHaveBeenCalled()
  })

  test("cleanup stops the event loop", async () => {
    if (process.platform === "win32") return
    const { hooks, bus, cleanup } = await setupPlugin()
    const invocation = makeInvocation()
    await hooks["create.before"]?.(invocation)

    expect(typeof cleanup).toBe("function")
    await cleanup?.()

    bus.push({
      type: "session.shell.ended",
      data: { sessionID: "s1", shell: { shell: invocation.shell } },
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(mockCleanupAfterCommand).not.toHaveBeenCalled()
  })
})
