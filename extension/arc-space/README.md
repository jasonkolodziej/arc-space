
# Arc (UTSA HPC) × VS Code Remote-SSH — Kit v0.4.2

Reference configuration for developing on UTSA **Arc** from VS Code: selecting and holding a compute node, seeing node availability, managing your Slurm jobs, and moving files between the three storage tiers.

Sources: [Arc User Guide](https://hpcsupport.utsa.edu/foswiki/bin/view/WebDocumentation/WebHome) · [Logging Into Arc](https://hpcsupport.utsa.edu/foswiki/bin/view/WebDocumentation/LoggingIntoARC) · [Managing Batch Jobs](https://hpcsupport.utsa.edu/foswiki/bin/view/WebDocumentation/MonitoringBatchJobs) · [VS Code Remote-SSH](https://code.visualstudio.com/docs/remote/ssh) (all retrieved 2026-09-30).

## Arc HPC (UTSA) — Setup, Slurm & Storage (v0.3)

Runs on your Mac. It configures SSH and settings for UTSA Arc, then drives Slurm and storage over one DUO-authenticated, multiplexed SSH connection.

Build: `pnpm i && pnpm run compile && pnpm run package` → **Extensions: Install from VSIX…** in a *local* window.

---

## 1. Storage tiers

| Tier | Path | Backed up | Limit / policy | Use for | Don't use for |
|---|---|---|---|---|---|
| **home** | `/home/abc123` | Yes | 100 GB hard quota | Source code, envs, builds, dotfiles, `~/.vscode-server` | Datasets, checkpoints, caches |
| **work** | `/work/abc123` | **No** | Files not accessed in 30 days are purge candidates | Job inputs/outputs, logs, datasets, checkpoints, package caches | Anything you can't regenerate |
| **vault** | `/vault/research/<folder>` ¹ | Yes, replicated to UT Arlington | 1 TB (more via service request) | Long-term archive, finished results, raw data of record | Live job I/O. **Mounted on login nodes only** (not on compute nodes) |
| **node scratch** | `/scratch` on the node | No | ~1.5 TB per node | Fast staging during a job | Anything that must outlive the job ² |

¹ The guide writes the path as `vault/research/abc123` and says the storage lives under `/vault`; `setup-on-arc.sh` warns if the directory isn't there.
² Treat node-local scratch as job-lifetime; the guide doesn't state a cleanup policy.

Both `/home` (110 TB) and `/work` (1.1 PB) are Lustre. That is why the generated workspace keeps data directories out of file watching and search.

**Data flow this kit wires up:** code in *home* → stage inputs into *work* (`Arc: Stage to /work`) → jobs read/write *work* → archive keepers to *vault* (`Arc: Archive to Vault`) before the 30-day window. The `/work` purge scan flags files at 25 days. Archive what matters rather than bulk-touching files to reset access times.

---

## 2. Compute: partitions and rules that shape the design

| Partition | Nodes | Cores/node | Memory | GPUs | Max walltime |
|---|---|---|---|---|---|
| compute1 | 65 | 40 | 384 GB | — | 72 h |
| compute2 | 27 | 40 | 384 GB | — | 240 h |
| compute3 | 6 | 16 | 1 TB | — | 72 h |
| gpu1v100 | 22 | 40 | 384 GB | 1× V100-32GB | 72 h |
| gpu2v100 | 9 | 40 | 384 GB | 2× V100-32GB | 72 h |
| gpu4v100 | 2 | 40 | 384 GB | 4× V100-32GB | 72 h |
| gpu1a100 | 2 | 16 | 1 TB | 1× A100-40GB | 72 h |
| bigmem | 2 | 80 | 1.5 TB | — | 72 h |
| bigmem2 | 1 | 16 | 2.1 TB | — | 72 h |

Private partitions (softmatter, dgxa100, uavlab, uavlab2, trustlab) need authorization; they are hidden via `arc.hiddenPartitions`.

The Arc rules below drive the design.

- **Login nodes** are for editing, transferring data, and submitting jobs only, with no compute- or memory-heavy work. A VS Code server running Pylance, Jupyter kernels, or test runners counts as heavy work, so the kit gives you a second window on a compute node.
- **Nodes are exclusive per user.** Only `idle` nodes are allocatable to you, so the views count idle nodes, not `mix`. Your holder node is yours alone, so its CPUs are all yours.
- **Limits:** 10 active jobs and 20 nodes per user. The *My Jobs* header shows usage against these.
- **GPU idle policy:** a GPU job whose GPUs sit idle for more than 1 hour is terminated. Don't hold a GPU node just to edit code. Hold a CPU node for development, and submit GPU work as batch jobs (or allocate a GPU node only for an active GPU session). Both the extension and `arc alloc` warn you about this.
- **Access:** SSH to `arc.utsa.edu:22` with DUO two-factor. This is why ControlMaster is used: you answer one DUO prompt, and every other connection reuses it.

---

## 3. Architecture (v0.2)

```
 Mac ─ VS Code + Arc HPC extension (extensionKind "ui": runs HERE, in every window)
  │
  │  ssh -fN arc   ← one password + DUO; ControlMaster socket persists ~10 h
  │  ssh -o BatchMode=yes arc 'squeue …'   ← every view, command and task reuses it (never prompts)
  ▼
 login node  ── Remote-SSH window "arc": edit · submit · transfer
  │
  │  arc-node = ProxyCommand ~/.ssh/arc-slurm-proxy.sh
  │    1) ssh arc "squeue --name=vscode --states=RUNNING -o %N"   (same socket)
  │    2) ssh -W <node>:22 arc                                     (key auth to the node)
  ▼
 compute node (your holder job) ── Remote-SSH window "arc-node": run · debug · notebooks
```

**v0.1 → v0.2**

| | v0.1 | v0.2 |
|---|---|---|
| Where the extension runs | On Arc (`workspace`) | On your Mac (`ui`); reaches Arc over the multiplexed SSH socket |
| Setup | Manual (copy files, edit configs) | Guided walkthrough plus **Arc: Run Setup**; each step is idempotent |
| Your ssh config | Hand-edited | One marked `Include` at the top; everything else lives in a managed file |
| Settings | Written once in the template | Three-way merge with a review list; your edits and removals are respected |
| Tasks | Static JSON in the workspace file plus an `arc` shell script | `arc` task type contributed by the extension; the shell script and workspace tasks are removed |
| Unsupported cluster features | Documented caveats | Detected by **Verify**; the extension adapts (e.g. hides "Open on node") |

---

## 4. Setup: what's automated and what isn't

Install `extension/arc-slurm/arc-slurm-0.2.0.vsix` in a **local** VS Code window. This is **Extensions: Install from VSIX…**, and it also pulls in Remote-SSH. The walkthrough then opens; alternatively, run **Arc: Run Setup**.

| Step | What the extension does | Safeguards |
|---|---|---|
| 1. Configure SSH | Asks for your myUTSA ID. Puts a marked `Include ~/.ssh/arc-slurm.conf` at the **top** of your ssh config (or of `remote.SSH.configFile` if you set one). Writes the managed conf and proxy script. | Backup `config.arc-backup` on the first change. Re-running replaces the block and never duplicates it. Warns if your own `Host arc` / `arc-node` blocks exist. A trailing `Host *` keeps your global options global. |
| 2. User settings | Reviews and merges the Remote-SSH settings: DUO login terminal, `remoteServerListenOnSocket` for shared login nodes, `remotePlatform`, and default remote extensions. | Checklist before any write. Values you set differently are unticked conflicts. |
| 3. Sign in (DUO) | Opens a **local** terminal (even from a remote window) running `ssh -fN arc`, then waits for the socket. | The status bar shows *Arc: sign in* whenever the socket is gone. Calls fail fast and never hang. |
| 4. SSH key | Uses an existing key, or runs `ssh-keygen` in a local terminal (a passphrase goes into the macOS keychain). Appends the public key to Arc's `authorized_keys`. | Idempotent: an exact-line check means it is never appended twice. |
| 5. Prepare Arc | Creates `~/projects`, `~/.arc/logs`, and the `/work/<id>/.cache/*` directories. Writes `~/.arc/arc.code-workspace` **only if it doesn't exist**. | Omits the vault folder if the path is missing, and warns when `lfs` is absent. |
| 6. Verify | Runs a 1-core, 5-minute test job, then checks login→node SSH, **Mac→`arc-node`**, `srun --overlap`, `lfs quota`, the vault path, and GPU GRES. | The test job is always cancelled. Results are written to `arc.nodeSshAvailable` / `arc.srunOverlap`. |
| 7. Open workspace | Opens `~/.arc/arc.code-workspace` on `arc`. | — |

Still manual: registering for DUO (passphrase.utsa.edu), requesting your Arc account, and approving the DUO push. Windows clients aren't supported, because OpenSSH on Windows lacks ControlMaster.

---

## 5. Settings merge rules

Templates are versioned. Workspace settings record what was last applied in `arc.appliedTemplate`, which is stored in the workspace file, so the login and node windows share it. User settings keep their record in extension state.

| Situation | Result |
|---|---|
| Setting absent and never applied | Added (pre-ticked) |
| Setting absent but applied before | You removed it, so it is left alone |
| Your value equals what we applied, and the template changed | Updated (pre-ticked) |
| You changed the value | Conflict: unticked, your value is kept unless you tick it |
| Object settings (e.g. `files.watcherExclude`) | Merged key by key with the same rules. Keys you deleted stay deleted, and `false` values are respected. |
| Array settings | New items are appended. Items you removed are not re-added. |

Writes go through the VS Code settings API, so comments and unrelated settings are preserved. Nothing is ever applied silently. An outdated Arc workspace shows a one-time **Review** notification, and **Arc: Review Workspace Settings** runs it on demand.

---

## 6. Tasks (`"type": "arc"`)

**Run Task → arc** lists: partitions, idle nodes, my jobs, watch jobs, allocate, release, interactive shell, submit, submit & follow, follow latest log, storage, and purge scan. Submit tasks only appear in Arc windows, because the script must live on Arc. You can pin parameterized variants in `tasks.json` and bind keys to them:

```jsonc
{ "label": "Dev node (compute2, 8h)", "type": "arc", "action": "allocate", "partition": "compute2", "walltime": "08:00:00" },
{ "label": "Submit & follow", "type": "arc", "action": "submitAndFollow", "problemMatcher": "$arc-python-watch" },
{ "label": "Efficiency of 123456", "type": "arc", "action": "efficiency", "jobId": "123456" }
```

Streaming tasks run in a real terminal: directly in an Arc window, or via `ssh -t arc` from a local window. The rest run the extension's own logic, so they show the same pickers and warnings as the commands. `$arc-python-watch` turns traceback frames in job logs into clickable Problems entries in Arc windows.

---

## 7. Job monitor (v0.3)

Open it from the pulse icon on any job in **My Jobs**, the Jobs view toolbar, or **Arc: Open Job Monitor**. It is a btop-style panel in an editor tab. It works from local, login-node and compute-node windows.

**Live tab (running jobs)**

| Panel | Shows | Source |
|---|---|---|
| Efficiency strip | Average CPU busy vs allocated cores, peak memory vs node/request, walltime vs limit, GPU average utilization, Slurm CPU efficiency | Samples since the panel opened, plus sacct |
| cpu | History graph, current %, iowait, load, per-core meters | `/proc/stat` |
| mem | Used / cache / free / swap, your process count, threads and RSS | `/proc/meminfo`, `/proc/<pid>` |
| gpu | Per-GPU utilization, memory, power vs limit, temperature. Banner after 20 min of idle GPUs (Arc kills them at 1 h) | `nvidia-smi` |
| net | Receive/send per interface including InfiniBand, as a mirrored graph | `/proc/net/dev`, `/sys/class/infiniband` |
| io | Lustre read/write per filesystem (`/work`, `/home`) and local disk | `llite.*.stats`, `/proc/diskstats` |
| slurm | Walltime left and per-step sstat (avg CPU, max RSS, disk I/O), refreshed every 15 s | `sstat` |
| processes | Your processes by **current** CPU% (from `/proc` tick deltas, not ps's lifetime average), mem%, RSS, threads, age; sortable columns | `/proc/<pid>/stat` |

Arc nodes are exclusive per user, so node-level counters are the job's usage.

**History tab:** sacct over 1/7/30/90 days. For each job it shows CPU efficiency (TotalCPU ÷ elapsed × cores), memory efficiency (peak step MaxRSS ÷ ReqMem, including legacy per-CPU `Mc` requests), and walltime used vs requested, with plain-language right-sizing notes. Colours grade efficiency: red means wasted cores, memory near its limit, or a timeout. Click a row to open its report card.

**How live data is collected.** A small bash/awk sampler (`media/monitor/arcmon.sh`, no Python or modules) is sent over the existing SSH connection. It emits raw counters, and the extension computes the rates. The extension tries these routes in order:
1. `srun --jobid --overlap` inside the job. GPU jobs first try a step bound to the job's GPUs so `nvidia-smi` can see them.
2. SSH from the login node to the job's node(s).
3. Accounting only.

A watchdog moves to the next route if no sample arrives within 25 s (e.g. a step waiting for resources). The sampler exits when the panel closes, or after `arc.monitorMaxMinutes` (default 240). Multi-node jobs run one sampler per node, and you pick the host with chips in the header. The sampling interval is 1–10 s (`arc.monitorInterval`).

**Limits to know**
- Network is node-level. Slurm doesn't attribute interconnect traffic per job unless the site enables interconnect accounting, so "net" is the node's total, which is your job's on an exclusive node.
- IB counters are 32-bit on some HCAs. A wrap shows as one zero interval rather than a spike.
- If the job's GPUs are held without sharing, the GPU-bound step can't start. The monitor then falls back and says GPU metrics aren't visible from that route.

## 8. What's where

| Need | Where |
|---|---|
| Nodes available | **Partitions & Nodes** (idle/total, expand for per-node state) · task *Idle nodes by partition* |
| Select & hold a node | ▶ on a partition or **Allocate** (sorted by idle, walltime validated, GPU-idle warning) · task *allocate* |
| Move VS Code onto the node | Status bar **Arc node … ready** → opens the same workspace on `arc-node` |
| Monitor a job | Pulse icon on a job → **Arc Monitor** (live + history efficiency) |
| Jobs | **My Jobs**: live, with usage vs 10 jobs / 20 nodes. Actions: details, open/follow log, attach shell, sacct, cancel, hold/release, requeue, cancel all. Notifications on start/end and at <15 min left on your node. |
| Submit | 🚀 in the editor title for `.sbatch/.slurm` · Explorer context · tasks |
| Storage | **Storage**: purpose, quota/usage, terminal here, add to workspace, `/work` purge scan |
| Cross-tier moves | Explorer right-click in Arc windows: **Archive to Vault** (from /work), **Stage to /work** (from /home or /vault) |

### Troubleshooting the Mac → node hop (v0.3.1)

**Arc: Diagnose Node Connection** tests the hop link by link against your running `vscode` job, or starts a 10-minute test job if none is running. Each result states which link failed. Fixes are applied only after you confirm them:

| Result | Meaning | Fix |
|---|---|---|
| Proxy can't find the node | Signed out, or no running holder job | Sign in, or allocate a node |
| Forwarding blocked, relay works | Login node sets `AllowTcpForwarding no` | Switches `arc.proxyMode` to `relay` (a bash `/dev/tcp` relay on the login node) and rewrites the proxy |
| No path to node:22 | Neither forwarding nor relay works | Structural. Use the login window + Attach Shell / Job Monitor |
| Node accepts key, but needs passphrase | Key is not loaded in ssh-agent | Offers `ssh-add --apple-use-keychain`. "Open on node" stays enabled, since Remote-SSH prompts for the passphrase anyway |
| Key rejected / no key offered | Public key not in Arc's `authorized_keys` | Re-runs the key step |
| Node allows only hostbased auth | Arc permits node SSH only from inside the cluster | Structural. "Open on node" is disabled |

Only structural results disable "Open on node".

**Reading "Got bad result from install script".** First check the Remote-SSH output for the install script's first line, `<id>: running`.
- If that line **never appears** and the attempt ends within a second or two, the SSH connection itself failed; nothing ran on the node. Look at `~/.ssh/arc-slurm-proxy.log` and run **Arc: Diagnose Node Connection**.
- Only if the line **does** appear is it a server-install problem on the node, covered below.

v0.3.3 fixes a proxy bug that produced exactly the first case: the node lookup (`ssh arc squeue …`) read from stdin, which inside a ProxyCommand is the SSH handshake itself. The lookup now uses `ssh -n`. The managed SSH files are rewritten automatically when the extension version changes.

**Server install problems on the node.** This means SSH login succeeded but the VS Code server could not install or start on the node. **Arc: Check Node for VS Code Server** inspects the node through the cluster-internal SSH path (which works even if your Mac's key needs a passphrase). It checks:
- whether shell start-up files print output, which corrupts the install handshake (it points to the file and line)
- glibc ≥ 2.28
- `flock` support on Lustre
- outbound internet from the node
- free space

It then proposes, for your review:
- `remote.SSH.localServerDownload: "always"` when nodes are offline
- `remote.SSH.lockfilesInTmp` when `flock` is unsupported
- a separate `remote.SSH.serverInstallPath` for `arc-node`, so the login and node windows don't share `~/.vscode-server` on Lustre at the same time

**Vault location.** The vault may not be named after your ID. UTSA's training shows named folders under `/vault/research`. **Arc: Find Vault Folder** lists folders there that you own or can write to and saves your choice to `arc.storage`. If there are none, your vault may not be provisioned yet; request it through support.utsa.edu/myportal.

### Hidden connection terminals (v0.4.2)

Remote-SSH normally shows an "install" and an "SSH Tunnel" terminal per connection, each warning not to close it. With `remote.SSH.useLocalServer: true` and `remote.SSH.showLoginTerminal: false`, the connection runs in a hidden background helper instead.

DUO no longer needs a visible terminal because it is answered once in **Arc: Sign In**. A key passphrase, if needed, is asked for in an input box.

### One window (v0.4.0)

**Arc: Start Session** (the status bar's rocket) does everything in the current window:
1. Signs you in.
2. Reuses your `vscode` node job, waits for it if it's queued, or allocates one (your last partition and walltime are offered first).
3. Reopens this window on the node's workspace.

You don't need a separate login-node window. The extension runs on your Mac, so views, the job monitor, tasks and vault actions all work from the node window. Near the end of the walltime you're offered **Start a new session**, which reopens the same window on a fresh node, because `arc-node` always resolves to your current job. `arc.openNodeIn: "newWindow"` restores the old behaviour.

### Two workspaces (v0.3.4)

`/vault` is mounted on the login nodes but not on compute nodes (observed on c120), so Prepare Arc now writes two workspace files:

- `~/.arc/arc.code-workspace` for the **login** window: home, work and vault.
- `~/.arc/arc-node.code-workspace` for **compute-node** windows: home and work.

"Open on node" opens the node workspace and checks it exists first. If it's missing, it offers Prepare Arc or your home folder.

Vault actions (terminal in vault, **Archive to Vault**, **Stage to /work** from vault) always run on the login node through your Mac's master connection, even when started from a node window.

### Remaining caveats
- `files.watcherExclude` is documented to accept absolute paths. The `/vault/research/**` entry relies on that.
- Lustre may update atime lazily, so treat the purge scan as advisory. Archive what you need; don't bulk-touch files to reset the clock.
- If node SSH verification fails, the login window plus **Attach Shell to Job** is the supported path. Ask RCSG before trying workarounds.
