## Verify

Submits a 1-core, 5-minute test job and checks:

- login → node SSH, and **Mac → `arc-node`** (what Remote-SSH uses)
- `srun --overlap` (attach a shell to a running job)
- `lfs quota`, the vault path, and the GPU GRES string `sinfo` reports

The test job is always cancelled. Results configure the extension: if node SSH is blocked, "Open on node" is disabled and you work through **Attach Shell to Job** instead.
