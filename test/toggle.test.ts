import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { cleanupOldToggleFiles, isSandboxToggledOff, setSandboxToggledOff } from "../src/toggle"

let testCacheHome: string | undefined
let isolatedCacheHome: string | undefined
const PROJECT_DIR = "/tmp/test-project"

describe("toggle", () => {
  beforeAll(() => {
    testCacheHome = process.env.XDG_CACHE_HOME
    isolatedCacheHome = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-sandbox-toggle-test-"))
    process.env.XDG_CACHE_HOME = isolatedCacheHome
  })

  afterAll(() => {
    if (isolatedCacheHome) fs.rmSync(isolatedCacheHome, { force: true, recursive: true })
    if (testCacheHome === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = testCacheHome
  })

  test("defaults to not toggled off", async () => {
    const off = await isSandboxToggledOff(PROJECT_DIR)
    expect(off).toBe(false)
  })

  test("set and read toggle state", async () => {
    await setSandboxToggledOff(PROJECT_DIR, true)
    expect(await isSandboxToggledOff(PROJECT_DIR)).toBe(true)

    await setSandboxToggledOff(PROJECT_DIR, false)
    expect(await isSandboxToggledOff(PROJECT_DIR)).toBe(false)
  })

  test("projects are isolated", async () => {
    await setSandboxToggledOff(PROJECT_DIR, true)
    expect(await isSandboxToggledOff("/another/project")).toBe(false)
    expect(await isSandboxToggledOff(PROJECT_DIR)).toBe(true)
  })

  test("cleanup removes old files", async () => {
    if (!isolatedCacheHome) throw new Error("isolatedCacheHome not set")
    const toggleDir = path.join(isolatedCacheHome, "opencode-sandbox", "toggle")
    fs.mkdirSync(toggleDir, { recursive: true })
    const oldFile = path.join(toggleDir, "old.json")
    fs.writeFileSync(oldFile, JSON.stringify({ disabled: true }))

    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000
    fs.utimesSync(oldFile, tenDaysAgo / 1000, tenDaysAgo / 1000)

    await cleanupOldToggleFiles()
    expect(fs.existsSync(oldFile)).toBe(false)
  })

  test("cleanup preserves recent files", async () => {
    if (!isolatedCacheHome) throw new Error("isolatedCacheHome not set")
    const toggleDir = path.join(isolatedCacheHome, "opencode-sandbox", "toggle")
    fs.mkdirSync(toggleDir, { recursive: true })
    const recentFile = path.join(toggleDir, "recent.json")
    fs.writeFileSync(recentFile, JSON.stringify({ disabled: true }))

    await cleanupOldToggleFiles()
    expect(fs.existsSync(recentFile)).toBe(true)
  })
})
