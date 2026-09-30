## Prepare Arc

- Creates `~/projects`, `~/.arc/logs`.
- Creates `/work/<id>/.cache/{pip,uv,huggingface,torch,conda-pkgs}` so caches don't eat the 100 GB home quota.
- Writes `~/.arc/arc.code-workspace` with home/work/vault folders and Lustre-friendly settings. **An existing file is never overwritten.** Use **Arc: Review Workspace Settings** inside it instead.
