# Arc (UTSA HPC) × VS Code Remote-SSH — Workspace Kit

Reference configuration for developing on UTSA **Arc** from VS Code: selecting and holding a compute node, seeing node availability, managing your Slurm jobs, and moving files between the three storage tiers.

Sources: [Arc User Guide](https://hpcsupport.utsa.edu/foswiki/bin/view/WebDocumentation/WebHome) · [Logging Into Arc](https://hpcsupport.utsa.edu/foswiki/bin/view/WebDocumentation/LoggingIntoARC) · [Managing Batch Jobs](https://hpcsupport.utsa.edu/foswiki/bin/view/WebDocumentation/MonitoringBatchJobs) · [VS Code Remote-SSH](https://code.visualstudio.com/docs/remote/ssh) (all retrieved 2026-09-30).

---

## 1. Storage tiers

| Tier | Path | Backed up | Limit / policy | Use for | Don't use for |
|---|---|---|---|---|---|
| **home** | `/home/abc123` | Yes | 100 GB hard quota | Source code, envs, builds, dotfiles, `~/.vscode-server` | Datasets, checkpoints, caches |
| **work** | `/work/abc123` | **No** | Files not accessed in 30 days are purge candidates | Job inputs/outputs, logs, datasets, checkpoints, package caches | Anything you can't regenerate |
| **vault** | `/vault/research/abc123` ¹ | Yes, replicated to UT Arlington | 1 TB (more via service request) | Long-term archive, finished results, raw data of record | Live job I/O |
| **node scratch** | `/scratch` on the node | No | ~1.5 TB per node | Fast staging during a job | Anything that must outlive the job ² |

¹ The guide writes the path as `vault/research/abc123` and says the storage lives under `/vault`; `setup-on-arc.sh` warns if the directory isn't there.
² Treat node-local scratch as job-lifetime; the guide doesn't state a cleanup policy.

Both `/home` (110 TB) and `/work` (1.1 PB) are Lustre. That is why the workspace excludes data directories from file watching and search.

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

## 3. Architecture

```
 Mac (VS Code UI)
   │  ssh arc  ──(DUO once; ControlMaster socket persists 10h)──►  login node  ── Window A: "arc"
   │                                                                  │   edit · sbatch · rsync · Arc views
   │  ssh arc-node ─ProxyCommand arc-proxy.sh──────────────────────────┤
   │        1) ssh arc "squeue --name=vscode --states=RUNNING -o %N"  │  (reuses socket, no DUO)
   │        2) ssh -W <node>:22 arc                                    ▼
   └──────────────────────────────────────────────────────────►  compute node (your holder job)
                                                                   Window B: "arc-node"
                                                                   Python/Jupyter/debug · heavy extensions
```

The **holder job** is `sbatch -J vscode --wrap "sleep infinity"`. It is not tied to a terminal, so closing VS Code or losing Wi-Fi doesn't drop the node, and walltime counts down from submission. Release the node when you're done (`Arc: Release VS Code Node`, or `arc release`).

**Where the extension runs:** `extensionKind: ["workspace"]` means it runs inside the VS Code server on Arc and calls `sinfo` / `squeue` / `scontrol` / `sacct` / `lfs` directly. The same views work in both windows.

---

## 4. Setup

### On your Mac
1. Append `local/ssh_config.arc` to `~/.ssh/config` and replace `abc123`.
2. Copy `local/arc-proxy.sh` to `~/.ssh/arc-proxy.sh` and run `chmod 700` on it.
3. Merge `local/vscode-user-settings.jsonc` into your **User** `settings.json`. `showLoginTerminal` is what lets you answer DUO.
4. Put your public key in Arc's `~/.ssh/authorized_keys`. `/home` is shared, so the compute nodes see the same file. DUO still applies at the login node.
5. Run `ssh arc` once in a terminal and approve DUO. This opens the master socket.

### On Arc (Remote-SSH window on `arc`)
```bash
scp -r remote arc:~/arc-kit-remote     # or drag into the Explorer
bash ~/arc-kit-remote/setup-on-arc.sh  # installs ~/.local/bin/arc and ~/.arc/arc.code-workspace
```
Then run **Extensions: Install from VSIX…** and choose `extension/arc-slurm/arc-slurm-0.1.0.vsix`. Remote-SSH installs it on the host. Finally, open `~/.arc/arc.code-workspace`.

### Recommended: two VS Code Profiles
- **Arc-Login:** Remote-SSH, the Arc extension, ShellCheck. Keep it light because it runs on a shared login node.
- **Arc-Node:** everything, including Python/Pylance, Jupyter, and debuggers.

---

## 5. ⚠️ Verify before relying on it

| Assumption | How to check | If it fails |
|---|---|---|
| You can SSH into a compute node you hold (typical `pam_slurm_adopt` setup) | `arc alloc compute1 00:30:00` → `ssh $(arc node) hostname` from the login node → from Mac: `ssh arc-node hostname` | Use Window A plus **Attach Shell to Job** (`srun --jobid --overlap --pty`) for execution, or ask RCSG whether compute-node SSH or VS Code tunnels are permitted |
| `srun --overlap` is supported (Slurm ≥ 20.11) | `srun --help \| grep overlap` | Drop `--overlap` in `arc shell` / the extension |
| GPU GRES name that `sinfo %G` reports is what `--gres` accepts | `sinfo -p gpu1v100 -o %G` | Set `arc.requestGpuGres: false` and add your own flags |
| `lfs quota` works for users | `lfs quota -h -u $USER /work` | Storage view falls back to `df` (filesystem-level only) |
| Lustre updates atime reliably enough for the purge scan | Compare `stat` atime after reading a file | Treat the scan as advisory |

---

## 6. What's where

| Need | Extension (activity bar → Arc HPC) | Task / CLI |
|---|---|---|
| See nodes available | **Partitions & Nodes**: idle/total per partition; expand for per-node state | `Arc: Idle nodes by partition` · `arc idle` · `arc partitions` |
| Select & hold a compute node | ▶ on a partition, or **Allocate Compute Node** (sorted by idle, walltime validated, GPU warning) | `Arc: Allocate VS Code node` · `arc alloc PART TIME` |
| Move VS Code onto the node | Status bar **"Arc node … ready"** → opens this workspace on `arc-node` in a new window | Remote-SSH: Connect to Host → `arc-node` |
| Quick interactive shell (doc-style) | **Interactive Shell (srun --pty)** | `arc interactive PART TIME` |
| My jobs | **My Jobs**: live every 30 s; header shows usage vs 10 jobs / 20 nodes | `Arc: My jobs` / `Watch my jobs` |
| Job control | Row actions: details, log, attach shell, efficiency (sacct), cancel, hold/release (pending), requeue (running), cancel all | `Arc: Job details / Follow job log / Cancel / Hold / Release / Requeue` |
| Submit | Editor title 🚀 on `.sbatch/.slurm`, or Explorer context | `Arc: Submit current batch script` |
| Notifications | Job started, job left queue (→ Efficiency / Log), <15 min walltime left on the node you're on | — |
| Storage | **Storage**: purpose, quota/usage, terminal here, add to workspace, purge scan (work) | `Arc: Storage usage` · `arc storage` · `arc purge 25` |
| Cross-tier moves | Explorer right-click: **Archive to Vault** (under /work), **Stage to /work** (under /home or /vault) | `arc archive PATH` · `arc stage PATH` |
