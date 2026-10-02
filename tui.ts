// TUI entrypoint for OpenCode 2: the CLI loads tui.ts from the same directory
// as index.ts for local path plugins (published installs resolve
// exports["./tui"] instead).
export { default } from "./src/tui"
