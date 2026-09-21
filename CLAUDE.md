# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Ropex is a GitOps control plane for AI agent fleets. Desired state lives in git (`fleets/**/*.yaml`); a controller reconciles it into ephemeral, immutable workers. Each worker pairs **Hermes** (brain: compose/plan/learn) with a pluggable **execute** stage — the embedded DeepSeek/Cordis harness by default, or an external headless CLI (Claude Code, Codex, Copilot). Everything is network-free and API-key-free by default (embedded simulated backends); live backends are opt-in.

`AGENTS.md` at the repo root carries the same core rules in a denser form — read it too, it is kept in sync with this file.

## Commands

```bash
npm install                 # small deps only — do NOT install optionalDependencies (@deepseek-ai/dsh) by default
npm test                    # vitest run — full suite, network-free
npm run test:watch          # vitest watch mode
npx vitest run tests/runtime.test.ts        # single test file
npx vitest run -t "test name substring"     # single test by name

npm run build                # tsc (src -> dist) + web build
npm run build:web            # Vite build of web/ -> dist/ui (needed before `ropex ui` serves anything)
npm run dev                  # tsx src/cli.ts (run CLI from source, no build step)
npm run web:dev              # Vite dev server for the dashboard (web/)

npm run up / npm run down    # one-click stack (Podman Compose or local fallback) -> http://127.0.0.1:7780

# Typecheck the SPA (no root-level lint/typecheck script for src/ beyond `tsc` via build)
npm --prefix web run typecheck
```

If `npm install` hangs, it's pulling `optionalDependencies`; use `bash scripts/bootstrap.sh` or delete the `optionalDependencies` block from `package.json` and reinstall.

Useful CLI entry points during development (`npx tsx src/cli.ts <cmd>`): `demo`, `apply <fleet.yaml>`, `pipeline "<prompt>"`, `drain --concurrency N`, `trajectories --jsonl`, `metrics --prometheus`, `health`, `runtimes`.

## Architecture

### One spine: start → transform → result

Every task run — regardless of ingress — reduces to five Hermes/DeepSeek stages grouped onto three phases. Keep this spine intact when touching workflow or executor code:

| Phase | Stages | Owner | `workflow.ts` field | `executor.ts` field |
| --- | --- | --- | --- | --- |
| Start | compose, plan | Hermes | `input` | `input` |
| Transform | execute | pluggable runtime | `stages` | `stages` |
| Result | deliver, learn | Hermes/harness | `result` | `result` |

`workflowPhases()` reports this for a single-task run; `pipelinePhase(run)` reports it for a multi-stage executor pipeline. `src/runtime.ts::runTask` is the single-task path; `src/executor.ts` runs multi-stage pipelines (for external orchestrators like Magentic) by enqueueing `pipelineId:stageId` tasks and doing a scoped queue drain per stage.

### Layers (top to bottom, roughly `fleets/` → `src/` → `web/`)

1. **GitOps desired state** — `fleets/**/*.yaml` declares `GitRepo` / `Agent` / `Fleet` / `Policy` / `Task` / `Memory`. `controller.ts` reconciles: expand Fleet → DesiredAgent (`spec.ts`), cap by `Policy.maxReplicas`, stamp an **agent image digest** (`image.ts`, sha256 over soul+skills+harness+runtime+github config), create/retire workers. Digest changes always retire-old + create-new — never mutate a live worker's harness/plugins/model/runtime in place.
2. **Scheduling** — `queue.ts` (fair LRU, leases, retry/DLQ), `scheduler.ts` (drain), `placement.ts` (require/prefer/taints/tolerations), `admission.ts` / `approval.ts` (policy gates before spawn — **never allow uncapped fleets**).
3. **Single-task runtime** — `runtime.ts::runTask` always couples Hermes to the executor: `bootHermes` → `bootWorker({ hermes })` → run. `workflow.ts` defines the 5 stages. `hermes.ts` owns compose/plan/learn for *every* runtime; only `execute` is pluggable via `spec.runtime` (`worker-runtime.ts` registry + boot dispatch, `cli-runtimes.ts` per-CLI descriptors, `proc.ts` subprocess primitive). Default runtime is `dsh` (`dsh.ts` + `plugins.ts`, embedded Cordis kernel); `ROPEX_DSH_BACKEND=live` / `ROPEX_HERMES_BACKEND=live` swap in live processes and fail closed if unavailable.
4. **Executor API** — `pipeline.ts` (stage planners: heuristic or hermes-seeded) + `executor.ts` (SSE, scoped sequential drain) expose an engine-neutral HTTP+SSE contract so external orchestrators (Magentic) can run multi-agent pipelines without reimplementing queue semantics.
5. **Surfaces** — `cli.ts` (keep thin — new behavior belongs in spec/controller/runtime, not the CLI), `api.ts` (HTTP control plane, also serves the built SPA), `web/` (Vite + React + TS dashboard, source in `web/`, builds to `dist/ui`).

### Pluggable worker runtimes

`spec.runtime.kind` on an `Agent` swaps only the `execute` stage; compose/plan/deliver/learn are unaffected. Options: `dsh` (default, in-process), `claude-code` (`claude -p`), `codex` (`codex exec`), `copilot` (`copilot -p`). A CLI runtime gets a rendered **brief** (`brief.ts`) instead of a tool program, runs in the worker's isolated git worktree, and its whole session becomes one `TrajectoryStep` tagged `runtime:<kind>`. Ropex policy denials are translated into each CLI's own permission flags; an unmappable deny makes `bootWorker` fail closed rather than silently under-enforcing. `spec.runtime` is part of the image digest. Full details, the policy-translation table, and flag-accuracy caveats: `docs/worker-runtimes.md`.

### Shared memory & skills

Memory and skills outlive individual workers — they live on scoped buses (`worker` | `agent` | `fleet` | `cluster`) rather than per-replica state, so learning survives ephemeral spawn/destroy. `src/memory.ts` / `src/gitmemory.ts` hold the store; `hermes.share.{read,write}` policy is baked into the image digest; worker-local facts are promoted to `agent` scope on destroy (`scale.ts`). Skills are versioned in a registry (`skills.ts`) and can be promoted to all agents.

### Immutable workers, not warm pools

Default scale is **on-demand**: admit → spawn under `min(maxConcurrent, Policy.maxReplicas)` → run → destroy (`idleTTLMs: 0`). `scale: static` opts into a standing pool instead. Do not hard-code replica lists anywhere in application code — the controller derives them from desired state.

### Ingress and delivery

Work enters via GitHub webhooks (`github.ts`, `webhook.ts`, HMAC-verified + rate-limited), Task YAML (`tasks.ts`, forge-neutral), the CLI, or the executor API (`executor.ts`). Results leave via `journal.ts` as a comment, check, pull request, or git writeback.

## Working conventions

- Tests in `tests/` must stay runnable with no network access and no API keys — they exercise the embedded/simulated backends. Vitest config only looks at `tests/**/*.test.ts`; source lives in `src/`, one module per concern (see the module map in `AGENTS.md`).
- `docs/` is kept in sync with behavior changes — update `docs/operations.md`, `docs/api.md`, and `docs/README.md` when you change what they document. `docs/architecture.md` has the full diagram set (layered architecture, digest model, worker lifecycle, queue state machine, etc.) if you need the deeper picture before changing control-plane code.
- License is MIT (`LICENSE`); the repo is meant to run overnight/offline in CI without secrets — don't introduce a hard dependency on live API keys in the default path.
