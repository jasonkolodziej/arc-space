## Configure SSH

**What changes on your Mac**

- `~/.ssh/config` gets **one** marked block at the very top:
  ```
  # >>> arc-slurm >>>
  Include ~/.ssh/arc-slurm.conf
  # <<< arc-slurm <<<
  ```
  It goes first because ssh uses the first value it finds for each option. A backup is saved as `config.arc-backup` the first time.
- `~/.ssh/arc-slurm.conf` (managed, regenerated) defines two hosts:
  - **`arc`** — login node, `ControlMaster auto` + `ControlPersist 10h`: one DUO sign-in, reused by everything.
  - **`arc-node`** — whichever compute node runs your `vscode` holder job, reached through `arc`.
- `~/.ssh/arc-slurm-proxy.sh` resolves that node at connect time.

Put personal overrides in your own config, not the managed file.
