#!/usr/bin/env bash
# Resumable training job for Arc. Copy next to your code, edit the marked lines, then
#   sbatch train.sbatch          (or 🚀 in VS Code)
#
#SBATCH -J train
#SBATCH -p gpu1v100                 # EDIT: partition
#SBATCH -N 1 -n 1 -c 40
#SBATCH --gres=gpu:1                # EDIT: drop for CPU partitions
#SBATCH -t 72:00:00
#SBATCH -o /work/%u/logs/%x-%j.log  # dir must exist before submit (setup-on-arc.sh makes it)
#SBATCH --open-mode=append          # a requeued run keeps the same id, so append to its log
#
# Ask Slurm for a warning 10 min before the walltime (B: = deliver to this batch shell,
# which forwards it to the trainer). Slurm checks once a minute, so it can be up to 60 s
# early. Rule of thumb: margin ≥ one training step + one checkpoint write + 60 s.
#SBATCH --signal=B:USR1@600
#
# Let the job resubmit itself under the same id after it checkpoints.
#SBATCH --requeue

set -euo pipefail
source "$HOME/.local/lib/arc/arc-ckpt.sh"
export PYTHONPATH="$HOME/.local/lib/arc${PYTHONPATH:+:$PYTHONPATH}"

# Checkpoints go to /work: not /home (100 GB quota), not node /scratch (gone with the job).
export CKPT_DIR="/work/$USER/ckpt/${SLURM_JOB_NAME}"   # EDIT: one directory per run
export ARC_CKPT_MARGIN=600          # fallback if --signal is missing (seconds)
export ARC_CKPT_EVERY=3600          # also checkpoint hourly (insurance against node loss)
export ARC_CKPT_RESUBMIT=requeue    # requeue | chain | none
export ARC_CKPT_MAX_RESTARTS=10

module load anaconda3 2>/dev/null || true   # EDIT: your environment
# conda activate myenv

echo "job $SLURM_JOB_ID restart ${SLURM_RESTART_COUNT:-0} on $(hostname) — ckpt dir $CKPT_DIR"

rc=0
arc_ckpt_run python train.py --ckpt-dir "$CKPT_DIR" || rc=$?   # EDIT: your trainer
arc_ckpt_finish "$rc"
