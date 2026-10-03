import { Plugin } from "@opencode/plugin/tui"
import type { RGBA } from "@opentui/core"
import type { JSX } from "@opentui/solid/jsx-runtime"
import { createSignal } from "solid-js"
import { isSandboxGloballyDisabled, loadConfig } from "./config"
import { isSandboxToggledOff, setSandboxToggledOff } from "./toggle"

type Color = string | RGBA

// The theme schema is moving between OpenCode releases (npm @opencode/theme 2.0.22
// ships text.base/text.muted and feedback.*.base; the beta TUI reads
// text.default/text.subdued and feedback.*.default). Read both spellings.
type StatefulColor = { readonly default?: Color; readonly base?: Color }
type Text = {
  readonly default?: Color
  readonly base?: Color
  readonly subdued?: Color
  readonly muted?: Color
  readonly feedback: Readonly<Record<"success" | "warning", StatefulColor>>
}
const colorOf = (color: StatefulColor): Color | undefined => color.default ?? color.base

// The same id as the server module, so enabling/disabling "opencode-sandbox"
// toggles both halves together.
export default Plugin.define({
  id: "opencode-sandbox",
  async setup(ctx) {
    if (isSandboxGloballyDisabled()) {
      return
    }

    const projectDir = ctx.location?.directory ?? ctx.data.location.default().directory

    // The signal must be created synchronously while Solid's owner context is
    // still active; after an await the owner may be lost.  We initialise it
    // with a placeholder and backfill the real value once the async toggle
    // state has been read.
    const [toggledOff, setToggledOff] = createSignal(false)

    const toggleSandbox = async () => {
      const paused = toggledOff()
      await setSandboxToggledOff(projectDir, !paused)
      setToggledOff(!paused)
    }

    const config = await loadConfig(projectDir)
    const configDisabled = config.disabled ?? false
    setToggledOff(await isSandboxToggledOff(projectDir))

    const text = ctx.theme.text as Text

    // One status drives both the label and its color.
    type Status = "on" | "paused" | "off"
    const statusOf = (): Status => {
      if (configDisabled) return "off"
      return toggledOff() ? "paused" : "on"
    }
    const colorFor = (status: Status): Color | undefined =>
      ({
        on: colorOf(text.feedback.success),
        paused: colorOf(text.feedback.warning),
        off: text.subdued ?? text.muted,
      })[status]

    // bun's JSX transform evaluates props eagerly (react-style, not solid's),
    // so the label must be a function child: the compiled renderer wraps a
    // function child in createRenderEffect, re-rendering when the signals it
    // reads change. Its type is narrower than what the renderer accepts,
    // hence the cast.
    const liveLabel = () => {
      const status = statusOf()
      return <span style={{ fg: colorFor(status) }}>{`⊙ sandbox: ${status}`}</span>
    }

    // The badge registers the palette command so the layer is owned by a
    // mounted component (the slot renderer).  Without mode: "global" the layer
    // defaults to the "base" input mode and the command disappears when the
    // command palette opens its own mode.
    const Badge = () => {
      ctx.keymap.layer(() => ({
        mode: "global",
        commands: [
          {
            id: "opencode-sandbox.toggle",
            title: "Toggle Sandbox",
            description: "Enable or disable the sandbox for this project",
            palette: true,
            enabled: true,
            run: toggleSandbox,
          },
        ],
        bindings: ["opencode-sandbox.toggle"],
      }))
      return (
        <box flexDirection="row" flexShrink={0}>
          <text fg={text.default ?? text.base}>{liveLabel as unknown as JSX.Element}</text>
        </box>
      )
    }

    const claims = [
      ctx.ui.slot({ append: "home.footer.status", render: Badge }),
      ctx.ui.slot({ append: "prompt.footer.status", render: Badge }),
    ]

    return () => {
      for (const dispose of claims) dispose()
    }
  },
})
