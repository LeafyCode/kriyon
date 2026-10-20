# Per-session CPU + memory in Kriyon — research (2026-10-03)

## 1. What Kriyon measures today

**Memory only. No CPU anywhere** (grep for cpu / ri_user_time finds nothing).

| What | Where |
|---|---|
| Reader: `libproc::pid_rusage::pidrusage::<RUsageInfoV4>(pid)` → `ri_phys_footprint / 1 MiB` | `src-tauri/src/memory.rs:32-38` |
| Doc: footprint, never RSS (RSS misreads under pressure, double-counts shared pages) | `src-tauri/src/memory.rs:6-9`, `CONTEXT.md:388-391` |
| Sweep: `sample_and_emit` → per-session MB + total, `session-memory` event, cached on `AppState.memory` | `src-tauri/src/memory.rs:48-92`, `src-tauri/src/lib.rs:94-101` |
| Pure fold (`fold_footprints`, `FootprintSweep`, `forget`) + budget (`MemoryBudget` 6144 MB default, 30 min warn cooldown) | `crates/kriyon-core/src/memory.rs:17-95` |
| Which pids: daemon (`kriyon-ptyd`, matched by argv[0] + socket id) then BFS over ppid children | `crates/kriyon-core/src/proc.rs:391-410`, daemon match `:111-134` |
| Process table: one `ps -axww -o pid=,ppid=,tpgid=,args=` fork, cached 2 s (TTL) | `src-tauri/src/status_rt.rs:295, 329-345, 369-388` |
| Cadence: ticker 2 s; memory + sleep pass every 3rd tick → **every 6 s** | `src-tauri/src/lib.rs:182, 187, 214-217` |
| UI: sidebar chip, amber at 1/6 budget, red at 1/3 | `src/sidebar/memoryChip.ts:15-16` |
| UI: tray total | `src/tray/TrayPanel.tsx:14, 428` |
| Budget warning notification (top 3 sessions) | `src-tauri/src/memory.rs:98-148` |
| Auto-sleep (kills idle `claude` to reclaim footprint; default on, 3 h) | `crates/kriyon-core/src/sleep.rs:34-41`, `src-tauri/src/sleep_rt.rs:78-119` |
| Adopted daemons counted too (ADR 0022) | `docs/superpowers/specs/2026-09-20-session-process-lifecycle-design.md:21,160` |

**Counted:** the daemon (~1.6–3 MB measured), the login shell, `claude`, and every descendant still linked by ppid: Bash tool children, stdio MCP servers (claude's children), background shells, dev servers started from the shell. Subagents run inside claude's process, so they are already in claude's footprint.

**Known inaccuracies:**
1. **Processes that leave the tree are missed.** The walk follows ppid only. A process that daemonizes (fork + setsid, parent exits → ppid 1), or whose parent died, falls out. Live example on this machine: a plugin helper process (node, 37 MB RSS). It has ppid 1 and its own pgid, but still carries its session's `KRIYON_SESSION` in its env, so it is not counted.
2. **Rounding down per pid.** Each pid's value is cut to whole MB *before* summing (`memory.rs:37`). Up to ~1 MB lost per pid, about 10 MB on a 10-process tree. Fix: sum bytes, convert once.
3. **Kriyon itself is not counted.** The app, its WebKit WebContent/GPU/Network XPC helpers, and anything launchd/XPC starts on a session's behalf (Docker VM, simulators) are outside the tree. The "total" is the sessions' total, not Kriyon's.
4. Small pid race between the `ps` snapshot and the `pidrusage` call. A vanished pid reads 0 (fine). A reused pid could be wrongly charged (rare).
5. Pids are never shared between trees (each pid has one parent), so nothing is double-counted. That also means a shared helper used by several sessions is charged to whichever tree spawned it, or to none if it escaped.

## 2. The right way on macOS

**Memory metric.** Use `phys_footprint`, which Kriyon already does. That is the Memory column in Activity Monitor and what jetsam / memory pressure charges. It is roughly internal (dirty anon) + compressed + IOKit-mapped + purgeable non-volatile + page tables. It leaves out clean file-backed and shared-cache pages, so unlike RSS, shared libraries are not double-counted.
- WWDC18 "iOS Memory Deep Dive": https://developer.apple.com/videos/play/wwdc2018/416/
- XNU accounting (`task.c`, `phys_footprint` ledger): https://github.com/apple-oss-distributions/xnu
- Measured here: one session's `claude` has RSS 519 MB vs footprint 364 MB; another has 320 MB vs 230 MB. RSS overstates by ~40%. Under pressure it goes the other way: compressed pages leave RSS but stay in footprint.
- The rusage call also returns `ri_lifetime_max_phys_footprint` / `ri_interval_max_phys_footprint` (peaks), `ri_billed_energy`, and `ri_instructions` / `ri_cycles`. Peaks or energy come at no extra cost.

**APIs:**
- `proc_pid_rusage(pid, RUSAGE_INFO_V4…)` → `ri_phys_footprint`, `ri_user_time`, `ri_system_time`, `ri_proc_start_abstime`. One syscall per pid, no fork. Works for same-uid processes with no entitlement. libproc crate 0.14.11 (latest; already a dependency, `src-tauri/Cargo.toml:59`).
- `proc_pidinfo(PROC_PIDTASKINFO)` → `pti_resident_size` (RSS) and `pti_total_user/system`. `proc_pidinfo(PROC_PIDTBSDINFO)` → `pbi_ppid`, `pbi_pgid`, `e_tdev` (controlling tty), `pbi_start_tvsec`.
- `task_info(TASK_VM_INFO).phys_footprint` needs a task port (`task_for_pid`), which needs root or entitlements for other processes. Not usable; `proc_pid_rusage` gives the same number without it.
- **Apple Silicon trap:** `ri_user_time` / `ri_system_time` (and `pti_total_*`) are in **mach absolute-time ticks, not ns**. Multiply by `mach_timebase_info` numer/denom (125/3 on M-series, 1/1 on Intel), or CPU reads ~42× too low. Bugs in osquery and psutil:
  - https://github.com/osquery/osquery/issues/7459
  - https://github.com/osquery/osquery/pull/7473

**`sysinfo` crate:** 0.39.6 is the latest (https://crates.io/crates/sysinfo). Very actively maintained (~50M recent downloads). But on macOS `Process::memory()` = `pti_resident_size`, which is **RSS, not footprint** (source: `src/unix/apple/macos/process.rs`). So it would be a step back from the current memory reading. `cpu_usage()` needs **two refreshes** with at least `MINIMUM_CPU_UPDATE_INTERVAL` between them and can go above 100% on multi-core (https://docs.rs/sysinfo/latest/sysinfo/struct.Process.html). It also refreshes the whole process table, the same cost class as `ps`. **Verdict: don't add it.** Libproc, already a dependency, gives everything with footprint semantics.

**What other tools do:**
- Activity Monitor: footprint, updates every 5 s by default.
- `top`: RSS-like `MEM` plus CPU over a 1 s sample.
- btop on macOS: `proc_pidinfo` task info (RSS), 2 s default update.
- bottom: uses sysinfo (RSS), 1 s default.

None measure whole trees by footprint. Kriyon's approach is already better than these for memory.

**CPU% for a tree.** CPU is a rate, so it needs two samples. For each pid keyed by `(pid, ri_proc_start_abstime)`, which guards against pid reuse:
`cpu% = Δ(user+sys in ns) / Δwall_ns × 100`. Sum over the session's pids. The result is in cores: 100% = one full core, a max of N×100. You can also show it divided by `hw.ncpu` as "% of machine".
- A pid seen for the first time: if it started after the previous sample, use its whole cumulative time as the delta. Otherwise skip it this round (no baseline).
- A pid that exited between samples loses its last partial interval. Small under-read, acceptable.
- Don't use `ps %cpu`. It is a decaying average, not interval-exact.

**Listing a session's descendants** (best combination, cheapest first):
1. **ppid walk from the daemon** (today). Catches the normal tree.
2. **Controlling tty (`e_tdev`) = the session's PTY device.** Survives parent death: an orphaned `npm run dev &` keeps the tty even after reparenting to launchd. `getsid()` would also survive, but the macOS man page lets `getsid` refuse with EPERM for processes outside the caller's session, so prefer `e_tdev` from `PROC_PIDTBSDINFO` (verify with a test).
3. **`KRIYON_SESSION` env marker**, already exported into every session's spawn env (`src-tauri/src/commands.rs:347-352`, `crates/kriyon-core/src/shellinit.rs:87`). Catches true daemonizers (setsid + detach, like the plugin helper above). Reading env needs `sysctl(KERN_PROCARGS2)` per pid (same uid OK), which is more expensive. Only run it on unattributed same-uid processes with ppid 1, and cache the result per `(pid, start)`. A process can scrub its env, so this is best-effort.
- Process group is useless here. Every shell job gets its own pgid, and daemonizers change it.

**Cost:**
- `ps` fork: ~30 ms wall for ~990 processes (measured), already shared through the 2 s cache.
- `proc_pid_rusage`: a few µs per pid. 30 sessions × ~10 pids is about 1 ms.
- Optionally, swap `ps` for `proc_listallpids` + `PROC_PIDTBSDINFO` (no fork, a few ms). argv is then only needed for `kriyon-ptyd` rows (`KERN_PROCARGS2` filtered by comm).

## 3. Can Claude Code mods help?

Mostly no for measurement.
- **The mod API has no pid, memory or CPU surface.** `$.process.run`/`spawn` only runs commands (d.ts:2767-2820). `$.agent.list()` returns `AgentInfo {id, description, type, status}`, with no pid (d.ts:121-140); subagents are in-process anyway. `$.env.set` exists (d.ts:2439-2468), but `KRIYON_SESSION` is already inherited.
- **`BackgroundTaskSummary`** `{id, type: shell|subagent|monitor|workflow, status, description, command?, agent_type?, server?, tool?, name?}` has **no pid** (d.ts:669-700). It comes on the `Stop` / `SubagentStop` hook inputs (d.ts:12149, 12291), so plain hooks already deliver it without mods, and Kriyon already uses hook-derived "running shells" (`sleep.rs:73-75`). Useful only to **label** pids in a breakdown, e.g. match `command` to a child's argv: "dev server: npm run dev — 410 MB".
- MCP: tool events carry the server name/source (d.ts:6008), not pids. Stdio MCP servers are claude's children, so the OS walk already counts them.
- **`~/.claude/sessions/<pid>.json`** fields: `pid, sessionId, cwd, startedAt, procStart, version, kind, entrypoint, pidDomain, messagingSocketPath, name, nameSource, nameSince, status, statusUpdatedAt, updatedAt, peerProtocol, peerFeatures`. That gives the claude pid ↔ Claude session id map and a busy/idle status, but no resource data.
- **Conclusion:** OS-level measurement is the source of truth. Mods and hooks only add names for what is running, never numbers. This fits the "loose coupling" rule in AGENTS.md.

## 4. Recommended design

- **One sampler, extending `memory.rs`.** Rename the concept to "session resources" (add the term to CONTEXT.md first). Per pid, one `pidrusage` call gives footprint + user/sys time + start time. Keep the previous sample's `HashMap<(pid,start), cpu_ns>` and `Instant` in `AppState`.
- **Pure core** (`kriyon-core::memory`, or a new `resources` module): `fold(trees, readings, prev) -> ResourceSweep { per_session: {mb, cpu_pct}, total_mb, total_cpu_pct }`. The total is derived once, same invariant as `FootprintSweep`. Sum **bytes**, convert to MB at the end. Unit-test pid reuse, new pids, exited pids and the timebase conversion.
- **Attribution:** ppid tree ∪ same PTY `e_tdev` ∪ (ppid==1 ∧ env `KRIYON_SESSION=<id>`). A pid gets claimed once, in that priority order, so nothing is double-counted.
- **Shared processes:** charge them once, to the claiming session (shown as "includes N shared helpers"). Or bucket them into an "Other / shared" row that is counted in the total and not in any session. Never split proportionally (false precision). Most stdio MCP servers are per-claude children, so true sharing is rare (brokers like codex, HTTP MCPs, Docker).
- **Total in one place:** the tray panel + one "Resources" popover/settings row: per-session rows sorted by memory, CPU sparkline, grand total. Optionally a separate "Kriyon app" line (app pid + its XPC helpers, found by `responsible pid`/bundle path) so the total matches what Activity Monitor shows.
- **Interval:** keep the 6 s background cadence (memory changes slowly; Activity Monitor uses 5 s). When the resources view is open, sample CPU every 2 s (the existing tick). The CPU delta just uses whatever Δt passed. First reading appears after 2 samples; show "—" until then.
- **Cost:** about 1–5 ms of syscalls per sample plus the existing cached `ps`. Negligible.
- **Pitfalls:**
  - (a) Apple Silicon mach-tick units for CPU time.
  - (b) pid reuse: key by start time.
  - (c) zombies: `pidrusage` may fail or read 0. Treat as 0 and don't count them as live.
  - (d) orphans/daemons that outlive the session: still charged via tty/env until they exit. Surface them ("2 leftover processes") rather than silently dropping them.
  - (e) Sleeping sessions still have daemon + shell (~5 MB) and possibly leftover dev servers.
  - (f) CPU > 100% is normal (multi-core). Say "cores" or normalize.
  - (g) Never fail the sweep on an unreadable pid.
  - (h) `KERN_PROCARGS2` env reads are the expensive part. Cache them, and only read ppid==1 same-uid processes.
