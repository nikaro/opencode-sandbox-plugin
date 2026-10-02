import { Plugin } from "@opencode/plugin/tui"
import type { RGBA } from "@opentui/core"
import { loadConfig } from "./config"

type Color = string | RGBA
type Mode = "enforce" | "permissive" | "off"

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

    const config = await loadConfig(ctx.location?.directory ?? process.cwd())
    const mode: Mode = config.disabled ? "off" : (config.mode ?? "permissive")

    // NOTE: bun's JSX transform evaluates props eagerly (react-style, not
    // solid's), so the badge is a static label rendered once at mount — the
    // mode it displays is fixed for the session anyway. Live state (running
    // sandboxed commands) would need solid's babel transform or manual
    // reactive bindings.
    const text = ctx.theme.text as Text
    const fg =
      mode === "enforce"
        ? colorOf(text.feedback.success)
        : mode === "permissive"
          ? colorOf(text.feedback.warning)
          : (text.subdued ?? text.muted)

    const Badge = () => (
      <box flexDirection="row" flexShrink={0}>
        <text fg={text.default ?? text.base}>
          <span style={{ fg }}>⊙ </span>
          sandbox: {mode}
        </text>
      </box>
    )

    const claims = [
      ctx.ui.slot({ append: "home.footer.status", render: Badge }),
      ctx.ui.slot({ append: "prompt.footer.status", render: Badge }),
    ]
    return () => {
      for (const dispose of claims) dispose()
    }
  },
})
