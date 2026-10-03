import { SandboxManager } from "@anthropic-ai/sandbox-runtime"
import { Plugin } from "@opencode/plugin"
import { loadConfig, resolveConfig } from "./config"
import { ENFORCEMENT_MESSAGE, ensureShim } from "./shim"
import { cleanupOldToggleFiles, isSandboxToggledOff } from "./toggle"

export type { SandboxPluginConfig } from "./config"

const log = (level: "warn" | "error", message: string) =>
  console[level](`[opencode-sandbox] ${message}`)
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

// Sandboxes by swapping the shell binary for a shim (src/shim.ts) and leaving
// invocation.command untouched: OpenCode's permission rules, shell scanning and
// directory authorization all evaluate the raw command, while the sandbox still
// applies to every process the shell spawns.
export default Plugin.define({
  id: "opencode-sandbox",
  async setup(ctx) {
    if (
      process.env.OPENCODE_DISABLE_SANDBOX === "1" ||
      process.env.OPENCODE_DISABLE_SANDBOX === "true"
    ) {
      return
    }

    const projectDir = ctx.location.directory
    const userConfig = await loadConfig(projectDir)
    if (userConfig.disabled) return

    await cleanupOldToggleFiles()

    if (process.platform === "win32") {
      log("error", "Windows sandboxing is not available; commands will be blocked")
      const registration = await ctx.shell.hook("create.before", async (invocation) => {
        if (await isSandboxToggledOff(projectDir)) return
        invocation.shell = await ensureShim(invocation.shell, "blocked")
      })
      return () => {
        void registration.dispose()
      }
    }

    // resolveConfig takes a project and a worktree directory; OpenCode plugin locations carry
    // only the session directory, which is the worktree in practice.
    const runtimeConfig = resolveConfig(projectDir, projectDir, userConfig)

    let initialization: Promise<boolean> | undefined
    const ensureSandboxReady = () =>
      (initialization ??= SandboxManager.initialize(runtimeConfig)
        .then(() => {
          console.debug(
            `[opencode-sandbox] initialized — writes allowed in: ${runtimeConfig.filesystem?.allowWrite?.join(", ")}`,
          )
          return true
        })
        .catch((err) => {
          log("error", `Failed to initialize; commands will be blocked: ${messageOf(err)}`)
          return false
        }))

    // Sandbox shims currently handed out; shell "ended" events carrying one of
    // these paths belong to commands this instance wrapped and must release the
    // runtime's per-command mount-point refcount.
    const sandboxShimPaths = new Set<string>()

    const cleanupCommand = () => {
      try {
        SandboxManager.cleanupAfterCommand()
      } catch (err) {
        log("warn", `Failed to clean up sandbox mount points: ${messageOf(err)}`)
      }
    }

    const shellRegistration = await ctx.shell.hook("create.before", async (invocation) => {
      if (await isSandboxToggledOff(projectDir)) return
      if (!invocation.command) return

      try {
        if (!(await ensureSandboxReady())) throw new Error("sandbox initialization failed")
        const wrapped = await SandboxManager.wrapWithSandbox(
          invocation.command,
          invocation.shell,
          undefined,
          undefined,
          { commandId: crypto.randomUUID(), commandText: invocation.command },
        )
        // No restrictions apply to this command; skip the shim entirely.
        if (wrapped === invocation.command) return

        const shimPath = await ensureShim(invocation.shell, "sandbox")
        sandboxShimPaths.add(shimPath)
        invocation.env = {
          ...invocation.env,
          OPENCODE_SANDBOX_REAL_SHELL: invocation.shell,
          OPENCODE_SANDBOX_WRAPPED_COMMAND: wrapped,
        }
        invocation.shell = shimPath
      } catch (err) {
        log("error", `Failed to sandbox command; blocking it: ${messageOf(err)}`)
        try {
          invocation.shell = await ensureShim(invocation.shell, "blocked")
        } catch {
          // Fail closed even when the blocked shim cannot be written.
          invocation.command = `echo '${ENFORCEMENT_MESSAGE}' >&2; exit 126`
        }
      }
    })

    // cleanupAfterCommand() must run exactly once per wrapped command, in this
    // process (the runtime's mount-point refcount lives here). The shell "ended"
    // event fires for every Shell.create exit path — completion, failure,
    // timeout, interrupt.
    let disposed = false
    let stopped: (() => void) | undefined
    const stoppedPromise = new Promise<void>((resolve) => (stopped = resolve))
    const iterator = ctx.event.subscribe()[Symbol.asyncIterator]()
    type Next = Awaited<ReturnType<typeof iterator.next>>
    void (async () => {
      try {
        while (!disposed) {
          // Race the next event against teardown: a parked next() would keep the
          // subscription (and the host process) alive long after dispose.
          const stop: Next = { done: true, value: undefined as never }
          const result = await Promise.race([iterator.next(), stoppedPromise.then(() => stop)])
          if (result.done) break
          if (result.value.type !== "session.shell.ended") continue
          if (sandboxShimPaths.has(result.value.data.shell.shell)) cleanupCommand()
        }
      } catch {
        // Stream closed (server shutdown or plugin teardown); nothing to clean.
      }
    })()

    return () => {
      disposed = true
      stopped?.()
      void iterator.return?.()
      void shellRegistration.dispose()
    }
  },
})
