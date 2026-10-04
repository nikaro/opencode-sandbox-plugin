import { describe, expect, mock, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import { probeCommand, type RunSandboxed, runEnforcementProbe } from "../src/probe"

const mockWrapWithSandboxArgv = mock((command: string, shell: string) =>
  Promise.resolve({ argv: [shell, "-c", command], env: {} }),
)
const mockCleanupAfterCommand = mock(() => undefined)

mock.module("@anthropic-ai/sandbox-runtime", () => ({
  SandboxManager: {
    wrapWithSandboxArgv: mockWrapWithSandboxArgv,
    cleanupAfterCommand: mockCleanupAfterCommand,
  },
}))

const fakeRunner = (code: number | null, stderr = ""): RunSandboxed =>
  mock(() => Promise.resolve({ code, stderr }))

describe("probeCommand", () => {
  test("checks the write target before the read target and quotes both", () => {
    const command = probeCommand("/tmp/probe dir/write", "/tmp/probe dir/read")
    expect(command).toContain("exit 101")
    expect(command).toContain("exit 102")
    expect(command.indexOf("/tmp/probe dir/write")).toBeLessThan(
      command.indexOf("/tmp/probe dir/read"),
    )
    expect(command).toContain("'/tmp/probe dir/write'")
  })
})

describe("runEnforcementProbe", () => {
  test("resolves when both denials are enforced", async () => {
    const runSandboxed = fakeRunner(0)
    await runEnforcementProbe(runSandboxed)

    const [command, config] = runSandboxed.mock.calls[0]
    // The probe config must explicitly deny both targets and allow no writes,
    // regardless of the user's real policy.
    expect(config.filesystem.allowWrite).toEqual([])
    expect(config.filesystem.denyWrite).toHaveLength(1)
    expect(config.filesystem.denyRead).toHaveLength(1)
    expect(command).toContain(config.filesystem.denyWrite[0])
    expect(command).toContain(config.filesystem.denyRead[0])
  })

  test("fails when a forbidden write succeeds", async () => {
    await expect(runEnforcementProbe(fakeRunner(101))).rejects.toThrow(
      "did not block a write outside the allowed write paths",
    )
  })

  test("fails when a forbidden read succeeds", async () => {
    await expect(runEnforcementProbe(fakeRunner(102))).rejects.toThrow(
      "did not block a read of a denied path",
    )
  })

  test("fails when enforcement cannot be verified, surfacing stderr", async () => {
    await expect(
      runEnforcementProbe(fakeRunner(126, "line1\nbwrap: setting up uid map failed")),
    ).rejects.toThrow(/could not be verified.*bwrap: setting up uid map failed/)
  })

  test("default runner spawns the wrapped argv and cleans up the command", async () => {
    mockWrapWithSandboxArgv.mockImplementation((command: string, shell: string) =>
      Promise.resolve({ argv: [shell, "-c", command], env: {} }),
    )
    // The real wrap is replaced with the identity, so the probe command runs
    // unsandboxed: the forbidden write succeeds and the probe must fail.
    await expect(runEnforcementProbe()).rejects.toThrow("exit 101")
    expect(mockWrapWithSandboxArgv).toHaveBeenCalledWith(
      expect.any(String),
      "/bin/sh",
      expect.anything(),
    )
    expect(mockCleanupAfterCommand).toHaveBeenCalled()

    // No probe scratch dirs are left behind.
    const tmpEntries = await fs.readdir(os.tmpdir())
    expect(tmpEntries.filter((entry) => entry.startsWith("opencode-sandbox-probe-"))).toEqual([])
  })
})
