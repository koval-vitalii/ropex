import { describe, expect, it } from "vitest";
import {
  CLI_RUNTIMES,
  classifyPolicy,
  isKnownRopexTool,
} from "../src/cli-runtimes.ts";
import { buildAgentImage } from "../src/image.ts";
import { expandDesired, parseManifests } from "../src/spec.ts";
import {
  credentialPresent,
  resolveRuntimeBin,
  resolveRuntimeKind,
  runtimeBinEnvVar,
  workerRuntimeScaffold,
  WORKER_RUNTIME_KINDS,
} from "../src/worker-runtime.ts";

const base = `
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  scale: static
  replicas: 1
  harness:
    profile: code
    plugins: [fs, shell]
  hermes:
    memory: none
    learning: false
    skills: []
`;

describe("cli runtime descriptors", () => {
  it("builds claude-code argv with prompt, model, and permission flags", () => {
    const argv = CLI_RUNTIMES["claude-code"].argv({
      prompt: "do the thing",
      model: "claude-opus-5",
      cwd: "/wt",
      permissionArgs: ["--permission-mode", "acceptEdits"],
    });
    // `-p` is --print; the prompt is the positional right after it, and must
    // come before the variadic permission flags or they would swallow it.
    expect(argv.slice(0, 4)).toEqual(["-p", "do the thing", "--output-format", "json"]);
    expect(argv).toContain("claude-opus-5");
    expect(argv.slice(-2)).toEqual(["--permission-mode", "acceptEdits"]);
  });

  it("puts the prompt last for codex and passes the worktree via --cd", () => {
    const argv = CLI_RUNTIMES.codex.argv({
      prompt: "do the thing",
      cwd: "/wt",
      permissionArgs: ["--sandbox", "workspace-write"],
    });
    expect(argv[0]).toBe("exec");
    expect(argv).toContain("--json");
    expect(argv[argv.indexOf("--cd") + 1]).toBe("/wt");
    expect(argv[argv.length - 1]).toBe("do the thing");
  });

  it("builds copilot argv in programmatic mode", () => {
    const argv = CLI_RUNTIMES.copilot.argv({
      prompt: "do the thing",
      cwd: "/wt",
      permissionArgs: ["--deny-tool", "shell"],
    });
    expect(argv.slice(0, 2)).toEqual(["-p", "do the thing"]);
    expect(argv).toContain("--log-level");
    expect(argv.slice(-2)).toEqual(["--deny-tool", "shell"]);
  });
});

describe("policy translation", () => {
  it("splits known tool denies from advisory capability labels", () => {
    const { toolDenies, advisory } = classifyPolicy({
      deny: ["shell", "prod-write"],
      requireApproval: ["force-push"],
    });
    expect(toolDenies).toEqual(["shell"]);
    expect(advisory).toEqual(["prod-write", "force-push"]);
    expect(isKnownRopexTool("shell")).toBe(true);
    expect(isKnownRopexTool("prod-write")).toBe(false);
  });

  it("folds requireApproval into deny — a headless CLI cannot pause for approval", () => {
    const plan = CLI_RUNTIMES["claude-code"].permissions({
      deny: [],
      requireApproval: ["shell"],
    });
    expect(plan.args).toContain("--disallowedTools");
    expect(plan.args.slice(plan.args.indexOf("--disallowedTools") + 1)).toContain("Bash");
    expect(plan.unmappable).toEqual([]);
  });

  it("maps claude-code denies onto its own tool names and always sets a headless mode", () => {
    const plan = CLI_RUNTIMES["claude-code"].permissions({
      deny: ["fs", "web"],
      requireApproval: [],
    });
    expect(plan.args.slice(0, 2)).toEqual(["--permission-mode", "acceptEdits"]);
    const denied = plan.args.slice(plan.args.indexOf("--disallowedTools") + 1);
    expect(denied).toContain("Edit");
    expect(denied).toContain("WebFetch");
    expect(plan.unmappable).toEqual([]);
  });

  it("tightens the codex sandbox when writes or shell are denied", () => {
    const open = CLI_RUNTIMES.codex.permissions({ deny: [], requireApproval: [] });
    expect(open.args).toEqual(["--sandbox", "workspace-write"]);
    const locked = CLI_RUNTIMES.codex.permissions({ deny: ["shell"], requireApproval: [] });
    expect(locked.args).toEqual(["--sandbox", "read-only"]);
  });

  it("reports denies a runtime cannot express so boot can fail closed", () => {
    // codex gates by sandbox level only — it has no per-tool web switch.
    expect(CLI_RUNTIMES.codex.permissions({ deny: ["web"], requireApproval: [] }).unmappable)
      .toEqual(["web"]);
    // claude-code has no equivalent of the inspect tool.
    expect(
      CLI_RUNTIMES["claude-code"].permissions({ deny: ["inspect"], requireApproval: [] }).unmappable,
    ).toEqual(["inspect"]);
    // copilot emits one --deny-tool per mapped tool.
    const copilot = CLI_RUNTIMES.copilot.permissions({ deny: ["shell", "fs"], requireApproval: [] });
    expect(copilot.args).toEqual(["--deny-tool", "shell", "--deny-tool", "write"]);
  });

  it("passes --disallowedTools variadically, never comma-joined", () => {
    // `--disallowedTools <tools...>` is variadic. A comma-joined string is read
    // as one tool name that matches nothing, so the gate would silently vanish.
    const plan = CLI_RUNTIMES["claude-code"].permissions({
      deny: ["shell", "web"],
      requireApproval: [],
    });
    const denied = plan.args.slice(plan.args.indexOf("--disallowedTools") + 1);
    expect(denied.length).toBeGreaterThan(1);
    for (const tool of denied) expect(tool).not.toContain(",");
    // ...and it must be the last flag, so the variadic list ends the argv.
    expect(plan.args.indexOf("--disallowedTools")).toBe(plan.args.length - denied.length - 1);
  });

  it("treats memory as already denied — it is never surfaced to an external CLI", () => {
    const plan = CLI_RUNTIMES["claude-code"].permissions({ deny: ["memory"], requireApproval: [] });
    expect(plan.unmappable).toEqual([]);
    expect(plan.args).not.toContain("--disallowedTools");
  });
});

describe("output parsing", () => {
  it("unwraps the claude-code json result envelope", () => {
    const parsed = CLI_RUNTIMES["claude-code"].parse(
      JSON.stringify({ type: "result", is_error: false, result: "patched login.ts" }),
      "",
    );
    expect(parsed.observations).toEqual(["patched login.ts"]);
  });

  it("flags a claude-code envelope that reports failure while exiting 0", () => {
    const parsed = CLI_RUNTIMES["claude-code"].parse(
      JSON.stringify({ type: "result", is_error: true, result: "rate limit exceeded" }),
      "",
    );
    expect(parsed.isError).toBe(true);
    const ok = CLI_RUNTIMES["claude-code"].parse(
      JSON.stringify({ type: "result", is_error: false, result: "done" }),
      "",
    );
    expect(ok.isError).toBe(false);
  });

  it("takes the last message from codex jsonl and ignores interleaved noise", () => {
    const stdout = [
      "not json at all",
      JSON.stringify({ message: "reading files" }),
      JSON.stringify({ message: "done: 2 files changed" }),
    ].join("\n");
    expect(CLI_RUNTIMES.codex.parse(stdout, "").observations).toEqual(["done: 2 files changed"]);
  });

  it("falls back to raw text for copilot and for unparseable output", () => {
    expect(CLI_RUNTIMES.copilot.parse("all done\n", "").observations).toEqual(["all done"]);
    expect(CLI_RUNTIMES["claude-code"].parse("{not json", "").observations).toEqual(["{not json"]);
    expect(CLI_RUNTIMES.codex.parse("", "warn: nothing to do").observations).toEqual([
      "warn: nothing to do",
    ]);
  });
});

describe("runtime resolution", () => {
  it("defaults to dsh and reads spec.runtime.kind otherwise", () => {
    const agent = expandDesired(parseManifests(base))[0];
    expect(resolveRuntimeKind(agent.spec)).toBe("dsh");
    expect(resolveRuntimeKind({ ...agent.spec, runtime: { kind: "codex" } })).toBe("codex");
  });

  it("prefers spec.runtime.command over the env override over the default bin", () => {
    const descriptor = CLI_RUNTIMES["claude-code"];
    const env = { ROPEX_RUNTIME_BIN_CLAUDE_CODE: "/opt/claude" };
    expect(runtimeBinEnvVar("claude-code")).toBe("ROPEX_RUNTIME_BIN_CLAUDE_CODE");
    expect(resolveRuntimeBin(descriptor, undefined, {})).toBe("claude");
    expect(resolveRuntimeBin(descriptor, undefined, env)).toBe("/opt/claude");
    expect(resolveRuntimeBin(descriptor, { kind: "claude-code", command: "/usr/bin/cc" }, env)).toBe(
      "/usr/bin/cc",
    );
  });

  it("detects credentials from any of a runtime's accepted env vars", () => {
    const descriptor = CLI_RUNTIMES["claude-code"];
    expect(credentialPresent(descriptor, {})).toBeUndefined();
    expect(credentialPresent(descriptor, { CLAUDE_CODE_OAUTH_TOKEN: "t" })).toBe(
      "CLAUDE_CODE_OAUTH_TOKEN",
    );
  });
});

describe("runtime scaffold", () => {
  it("reports dsh ready and every CLI not-ready on a bare environment", () => {
    const statuses = workerRuntimeScaffold({ PATH: "" });
    expect(statuses.map((s) => s.kind)).toEqual(WORKER_RUNTIME_KINDS);
    const dsh = statuses.find((s) => s.kind === "dsh");
    expect(dsh?.ready).toBe(true);
    for (const status of statuses.filter((s) => s.kind !== "dsh")) {
      expect(status.ready).toBe(false);
      expect(status.binPresent).toBe(false);
      expect(status.hint).toMatch(/Install|ROPEX_RUNTIME_BIN/);
    }
  });

  it("separates a missing binary from missing credentials in the hint", () => {
    const statuses = workerRuntimeScaffold({
      PATH: "",
      ROPEX_RUNTIME_BIN_CLAUDE_CODE: process.execPath,
      ANTHROPIC_API_KEY: "sk-test",
    });
    const claude = statuses.find((s) => s.kind === "claude-code");
    expect(claude?.binPresent).toBe(true);
    expect(claude?.credentialSource).toBe("ANTHROPIC_API_KEY");
    expect(claude?.ready).toBe(true);

    const noKey = workerRuntimeScaffold({
      PATH: "",
      ROPEX_RUNTIME_BIN_CODEX: process.execPath,
    }).find((s) => s.kind === "codex");
    expect(noKey?.binPresent).toBe(true);
    expect(noKey?.ready).toBe(false);
    expect(noKey?.hint).toMatch(/OPENAI_API_KEY/);
  });
});

describe("image digest", () => {
  it("leaves agents without spec.runtime at their existing digest", () => {
    const agent = expandDesired(parseManifests(base))[0];
    const withUndefined = { ...agent, spec: { ...agent.spec, runtime: undefined } };
    expect(buildAgentImage(withUndefined).digest).toBe(buildAgentImage(agent).digest);
  });

  it("rolls the digest when the runtime changes", () => {
    const agent = expandDesired(parseManifests(base))[0];
    const dsh = buildAgentImage(agent).digest;
    const claude = buildAgentImage({
      ...agent,
      spec: { ...agent.spec, runtime: { kind: "claude-code" } },
    }).digest;
    const codex = buildAgentImage({
      ...agent,
      spec: { ...agent.spec, runtime: { kind: "codex" } },
    }).digest;
    expect(new Set([dsh, claude, codex]).size).toBe(3);
  });
});

describe("manifest validation", () => {
  const agentWith = (specLines: string) => `
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  scale: static
  replicas: 1
${specLines}
  harness:
    profile: code
    plugins: [fs]
  hermes:
    memory: none
    learning: false
    skills: []
`;

  it("accepts every supported runtime kind", () => {
    for (const kind of WORKER_RUNTIME_KINDS) {
      expect(() => parseManifests(agentWith(`  runtime:\n    kind: ${kind}`))).not.toThrow();
    }
  });

  it("rejects an unknown runtime kind", () => {
    expect(() => parseManifests(agentWith("  runtime:\n    kind: nope"))).toThrow(
      /unsupported runtime.kind "nope"/,
    );
  });

  it("rejects commandArgs without command", () => {
    expect(() =>
      parseManifests(agentWith("  runtime:\n    kind: codex\n    commandArgs: [exec]")),
    ).toThrow(/commandArgs requires runtime.command/);
  });

  it("rejects an unknown harness profile that previously failed silently", () => {
    expect(() =>
      parseManifests(`
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  scale: static
  replicas: 1
  harness:
    profile: turbo
    plugins: [fs]
  hermes:
    memory: none
    learning: false
    skills: []
`),
    ).toThrow(/unsupported harness.profile "turbo"/);
  });

  it("validates a Fleet template spec too", () => {
    expect(() =>
      parseManifests(`
apiVersion: ropex.dev/v1
kind: Fleet
metadata:
  name: builders
spec:
  replicas: 2
  template:
    spec:
      runtime:
        kind: bogus
      harness:
        profile: code
        plugins: [fs]
      hermes:
        memory: none
        learning: false
        skills: []
`),
    ).toThrow(/unsupported runtime.kind "bogus"/);
  });
});
