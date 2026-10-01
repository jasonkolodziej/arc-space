#!/usr/bin/env bash
# Run once ON ARC (login node) from the unpacked kit's remote/ directory:
#   bash setup-on-arc.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$HOME/.local/bin" "$HOME/.arc/logs" "$HOME/projects" "/work/$USER/.cache"
install -m 755 "$here/arc" "$HOME/.local/bin/arc"
mkdir -p "$HOME/.local/lib/arc" "$HOME/.arc/ckpt" "/work/$USER/logs" "/work/$USER/ckpt"
install -m 644 "$here/ckpt/arc_ckpt.py" "$here/ckpt/arc-ckpt.sh" "$here/ckpt/train.sbatch" "$HOME/.local/lib/arc/"
sed "s/__USER__/$USER/g" "$here/arc.code-workspace.template" > "$HOME/.arc/arc.code-workspace"
[ -d "/vault/research/$USER" ] || echo "WARN: /vault/research/$USER not found — fix the vault path in ~/.arc/arc.code-workspace"
command -v lfs >/dev/null || echo "WARN: 'lfs' not on PATH — quota views fall back to df"
echo "Installed: ~/.local/bin/arc, ~/.local/lib/arc/{arc_ckpt.py,arc-ckpt.sh,train.sbatch}, ~/.arc/arc.code-workspace"
echo "Next: verify compute-node SSH →  arc alloc compute1 00:30:00 ; ssh \$(arc node) hostname ; arc release"
