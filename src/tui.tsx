import { Plugin } from "@opencode/plugin/tui"
import type { RGBA } from "@opentui/core"
import type { JSX } from "@opentui/solid/jsx-runtime"
import { createSignal } from "solid-js"
import { loadConfig } from "./config"
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
    if (
      process.env.OPENCODE_DISABLE_SANDBOX === "1" ||
      process.env.OPENCODE_DISABLE_SANDBOX === "true"
    ) {
      return
    }

    const projectDir = ctx.location?.directory ?? ctx.data.location.default().directory
    const config = await loadConfig(projectDir)
    const configDisabled = config.disabled ?? false
    const [toggledOff, setToggledOff] = createSignal(await isSandboxToggledOff(projectDir))

    // The palette command flips the persisted state and the badge signal
    // together; the server hooks re-read the file before every command.
    const toggleSandbox = async () => {
      const paused = await isSandboxToggledOff(projectDir)
      await setSandboxToggledOff(projectDir, !paused)
      setToggledOff(!paused)
    }

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

    // A keymap layer is owned by the component that creates it, so each
    // badge registers its own copy of the palette command: the keymap
    // deduplicates commands by id, and whichever badge stays mounted keeps
    // the command reachable as the other unmounts during navigation. The
    // always-mounted app slot cannot host the registration — it sits outside
    // the keymap provider, so the layer would never register.
    const Badge = () => {
      ctx.keymap.layer(() => ({
        commands: [
          {
            id: "opencode-sandbox.toggle",
            title: "Toggle Sandbox",
            description: "Pause or resume sandbox restrictions for this project",
            palette: true,
            run: toggleSandbox,
          },
        ],
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
