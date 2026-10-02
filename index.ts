// Local-path entrypoint for OpenCode 2: path plugins load index.ts from a
// directory, so point `plugins` at the repository root. Published installs
// resolve dist/index.js through package.json exports["./server"] instead.
export { default } from "./src/index"
