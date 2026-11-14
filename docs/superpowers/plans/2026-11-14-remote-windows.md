# Remote access on Windows, both ways

Step 6 of the remote plan ("Windows, both ways"): from a Mac, watch and drive sessions on a
Windows PC, and the reverse, and a phone with either. Same protocol and rules as Mac to Mac.

Sources:
- PR #48 (`feat/windows`, ADR 0055): Kriyon itself on Windows.
- PR #54 (`feat/windows-release`, ADR 0056, stacked on #48): Windows builds in the Release
  workflow, one update feed per platform.
- The plan's "Mac and Windows, both ways" section.
- `feat/remote-access` at 049cba8: what remote access needs from the OS today.

#48 is not changed by this plan.

## Where things stand

- **#48:** open, last pushed 7 Nov, and based on 0.15.0 (b37861e). It was hand-tested on
  Windows 11 (installer, sessions, tray, Files view, structured view) and passes its tests
  there.
- **`feat/remote-access`:** 179 commits past that base.
- **Overlap:** 43 files changed on both sides, including the daemon and its client:
  - `kriyon-ptyd/src/server.rs`: +1308 lines on remote, +29 on #48;
  - `src-tauri/src/daemon_client.rs`: +873 on remote;
  - `kriyon-ptyd/src/bridge.rs`: +173 on remote, +51 on #48;
  - `kriyon-ptyd/src/pty.rs`: +236 on #48.
- **Not on `dev` yet:** remote access, including the companion bridge's owner check (7b98a8c,
  13 Nov).

One correction to the plan's earlier table: #48 does not use named pipes. The session socket
stays a Unix-domain socket on Windows (`uds_windows`, Windows 10 1803+), so the daemon
protocol is unchanged. Remote access builds on that.

## What #48 already covers

From the plan's 13–18-week Windows estimate, #48 has done most of the base:

| Plan item | #48 | Left |
|---|---|---|
| Terminal process links | Unix sockets via `uds_windows` behind `kriyon_core::uds`; same frames, same stale-socket rule | Nothing for the daemon. The bridge caller check is not done (see below). |
| Stopping a whole process tree | A kill-on-close Job Object per session; it also gives the busy signal | Nothing |
| ConPTY quirks | The daemon answers ConPTY's opening cursor query; sessions run PowerShell | Remote-specific checks (below) |
| Hooks, shell setup, paths | PowerShell launch lines; `dunce` paths; hooks run with a real `python.exe` if there is one | Hooks without Python (a Rust port), as ADR 0055 says |
| App shell, installer, signing | NSIS installer, tray, no menu bar, per-build daemon copy so updates work while sessions run | Code signing. Releases are in #54, unsigned. |
| Windows CI | None (#48 has no workflow change) | All of it |

The vt100 screen snapshot and the `ScreenRows` seam the dialog watch reads are in the daemon
and platform-neutral, so they run on Windows as they are. What ConPTY sends them is a
different question (risks).

## What remote access adds on Windows

### Host: a Windows PC serving its sessions

1. **The computer's name.** `remote_cmd::host_name` calls `libc::gethostname`, which the
   `libc` crate doesn't provide on Windows, so this won't compile there. Use
   `GetComputerNameExW(ComputerNameDnsHostname)`.
2. **Where the device key and relay sign-in are kept.** Windows has no keychain store yet:
   `device_key::key_vault` returns `None`, so remote access refuses with "needs macOS or Linux".
   - Add a `SecretVault` over **Windows Credential Manager**: a generic credential per secret
     (`{identifier}.remote/{account}`), persisted `CRED_PERSIST_LOCAL_MACHINE`. It stays on this
     PC for this user and never roams with a roaming profile (`ENTERPRISE` would), matching the
     Mac's "never synced".
   - Credential Manager holds at most 2,560 bytes per credential. The device key (32 bytes) fits.
     The relay record (`Saved`: an access token, the on switch and the newest pass, as JSON)
     must be measured. If it can exceed the limit, keep it DPAPI-sealed
     (`CryptProtectData`, user scope) in the app's local data folder instead. That is Windows'
     own per-user encryption, never a plain file.
   - A store that fails is an error in plain words, as on Linux.
3. **The companion bridge's owner check.** The bridge keeps a companion post only from the
   session's proven owner: the poster's process, in the foreground of the session's terminal.
   The kernel gives the poster's pid on macOS (`LOCAL_PEERPID`) and Linux (`SO_PEERCRED` plus
   `/proc`).
   - On Windows it refuses every post (`NoCheckOnThisPlatform`). So a Windows host has no
     companion state, no Structured view and no readable view for any device.
   - #48 tested the structured view before this check existed. Rebased, it loses it.
   - Windows equivalent: the poster's pid from the AF_UNIX socket (`SIO_AF_UNIX_GETPEERPID`),
     then **the poster is in this session's Job Object** (`IsProcessInJob` with the daemon's job
     handle). Then #48's foreground rule: the shell's child runs in the foreground.
   - That needs the daemon to keep its job handle where the bridge can reach it. It stays
     fail-closed if any step fails.
4. **Firewall.** The first time the app binds its endpoint, Windows Defender Firewall asks
   whether to allow Kriyon on private and public networks.
   - If the person says no, or the network is "Public", direct links on the same network fail
     and every device falls back to a relay: our paid one, or none.
   - Remote access needs a line saying so, shown before the first prompt, and a check that says
     plainly when direct links are blocked (this mirrors macOS's Local Network prompt).
5. **Consent and settings copy.** The remote copy already says "this computer". #48 changes
   "this Mac" to "this PC" elsewhere; check the remote screens' copy the same way.
6. **Sleep.** A sleeping PC is unreachable; Modern Standby drops network links. Remote access
   should keep the PC awake while a device is connected, if `sleep_rt` (#48) can, and the copy
   should say a sleeping PC can't be reached.

### Device: a Windows PC watching another computer

Mostly shared code: the device runtime (iroh), the Other computers view (xterm in the
webview), the readable view, the relay sign-in (browser); a desktop device gets no phone alerts. It needs the same
vault (item 2) for its own device key, and a check on a real machine. No Windows-only design.

### The phone and a Windows host

Nothing Windows-specific on the phone. It pairs with a Windows host as with a Mac. What a
Windows host sends (sessions, standing, screens, readable entries) has to be right; that is
items 3 and 7.

7. **Screens and typing from a remote device through ConPTY.**
   - Snapshots and the dialog watch read ConPTY's output through vt100, as the desktop does.
   - What has to be checked on a real PC, from a Mac and from a phone:
     - full-screen repaints;
     - the pane-rule glyph the dialog watch looks for (`ScreenRows::starts_with`);
     - typed keys: Enter, arrows, Ctrl-C, paste, non-ASCII;
     - ConPTY's own sequences (for example win32-input-mode) reaching a remote xterm that
       never asked for them.
   - Fixes go in the daemon, not the devices.

## Done so far (branch `feat/remote-windows-prep`)

- **Step 2, the crates part:** `.github/workflows/windows.yml` runs clippy on kriyon-core,
  kriyon-remote, kriyon-remote-link, kriyon-relay-client and kriyon-push on Windows, and the
  four remote crates' tests. kriyon-core builds for Windows (PR #48's `private_fs`, taken as it
  is). Left for after #48: kriyon-ptyd, src-tauri and kriyon-core's own tests in that job.
- **Step 3:** `kriyon_core::host::computer_name` (`gethostname` on Unix,
  `GetComputerNameExW` on Windows); the app uses it everywhere it named this computer.
- **Step 4, the vault:** `kriyon_remote_link::keys::windows`.
  - A secret goes in Credential Manager while it fits (`CRED_PERSIST_LOCAL_MACHINE`).
  - A bigger one is DPAPI-sealed into `<app local data>/<account>.sealed`, with the app's and
    the secret's name as entropy.
  - `SizedVault` holds which store: it is platform-neutral and tested everywhere, and the stores
    are tested for real on Windows CI.
  - Measured: the relay record is 354 bytes of JSON plus its access token, which the contract
    leaves open. It outgrows a credential only past a token of about 2.2 KB, and the vault
    handles either.
  - Left for after #48: `device_key` choosing it on Windows (it needs the app's local data
    folder).



Sizes are for one person: S is 1–2 days, M is 3–5 days, L is 1–2 weeks.

| # | Work | Size | Needs a Windows PC? |
|---|---|---|---|
| 0 | Land #48 on `dev` first (rebase onto today's `dev`; it doesn't touch remote access), then #54 | M (rebase and re-test) | Yes: the hand test again after the rebase |
| 1 | Merge `feat/remote-access` into `dev` on top of #48: conflicts in the daemon, its client and the bridge; keep both sides | L | No, if step 2 lands with it |
| 2 | Windows CI job: build and test `kriyon-core`, `kriyon-ptyd`, `kriyon-remote`, `kriyon-remote-link`, `kriyon-relay-client` and the app on `windows-latest` (no secrets; Credential Manager works on the runner) | M | No |
| 3 | `host_name` on Windows | S | No (CI) |
| 4 | Credential Manager vault (plus DPAPI if the relay record is too big), with real tests in Windows CI | M | No (CI); yes to see the entry in Credential Manager |
| 5 | Bridge owner check on Windows (peer pid + job membership + foreground) and the daemon keeping its job handle for it; ptyd tests on Windows CI | M | Yes, a real companion session |
| 6 | Firewall: the line before the prompt, the "direct links blocked" check | S–M | Yes |
| 7 | ConPTY checks from a Mac and a phone; daemon fixes found there | M (unknown until tried) | Yes |
| 8 | Sleep while a device is connected; copy | S | Yes |
| 9 | Device tests: `device-tests/windows.md` (Mac → PC, PC → Mac, phone → PC, relay, faults) | S | It is the person's test |

About 5–8 weeks after #48 lands, most of it steps 1, 5 and 7. Step 2 should come first after
the merge: it is what lets the rest be done without a Windows PC at hand.

Still outside this plan:
- Windows code signing, a certificate the person buys. Until then SmartScreen warns, and the
  firewall rule is tied to the unsigned app's path.
- Hooks without Python.

## What the person needs to do on a Windows PC

- Re-run #48's hand test after its rebase (step 0).
- Pair it as a host, from a Mac and from a phone. Then pair it as a device, to a Mac. On the
  same network (with the firewall prompt), through Tailscale, and through our relay.
- Watch and type in a real Claude session from each, including a Claude question and the
  readable view (steps 5 and 7).
- Check Credential Manager shows Kriyon's entries and nothing else changed (step 4).
- Sleep, lock and network changes while connected (step 8).

## Risks

- **#48 is stale against the daemon.** The remote branch rewrote much of `server.rs` and
  `daemon_client.rs` since #48's base. Two orders are possible:
  - #48 first (step 0, then 1): its smaller diff rebases first, and remote access merges onto a
    tree that already builds on Windows.
  - Remote access first: #48's Windows changes then have to be redone inside the new daemon
    code.
  #48 first is the cheaper order.
- **No readable view on Windows hosts until step 5.** The owner check fails closed by design.
  Without step 5, Windows hosts have no companion state, Structured view or readable view, and
  this has to be said in the UI meanwhile.
- **`SIO_AF_UNIX_GETPEERPID`** must work on Windows 10 1803+ as on 11. If it doesn't, the
  check stays closed on that version. Prove it in Windows CI early.
- **Credential Manager's 2,560-byte limit** for the relay record (see item 2).
- **The firewall** can push every device onto a relay without anyone noticing, which costs the
  person a subscription or breaks remote access. The check in step 6 is the guard.
- **ConPTY rewrites output.** Snapshots and the dialog watch were tuned on macOS output. A
  question Claude asks may not be seen as a dialog on Windows (Needs you, the readable view's
  question), until checked in step 7.
- **Status without Python.** On a PC without Python, hook status is off. Needs you and alerts
  then rest on the companion (exact state) and the dialog watch. Check that a Windows host
  still marks a waiting session as Needs you without the hooks.
- **iroh on Windows.** Its network monitoring and port mapping have Windows code paths we
  haven't run. Step 2 compiles and tests them.
