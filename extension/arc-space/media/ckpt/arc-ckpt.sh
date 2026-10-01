# arc-ckpt.sh — source from a Slurm batch script to make walltime stops resumable.
#
#   source ~/.local/lib/arc/arc-ckpt.sh
#   rc=0; arc_ckpt_run python train.py || rc=$?   # forwards USR1/USR2/TERM, returns the trainer's exit code
#   arc_ckpt_finish "$rc"                          # 99 → requeue/resubmit; anything else → pass it through
#
# Why the wrapper is needed: with `#SBATCH --signal=B:USR1@600` Slurm signals the
# *batch shell*, and bash only runs a trap after the foreground command returns —
# i.e. after training is already dead. Running the trainer in the background and
# `wait`-ing lets the trap fire immediately and pass the signal on.
#
# Knobs (environment):
#   ARC_CKPT_RESUBMIT     requeue (default) | chain | none
#   ARC_CKPT_MAX_RESTARTS stop resubmitting after this many restarts (default 10)
#   ARC_CKPT_SCRIPT       script to resubmit in chain mode (default: the job's own Command)
#   ARC_CKPT_STATE_DIR    status/request files (default ~/.arc/ckpt)

ARC_CKPT_EXIT_RESUME=99
: "${ARC_CKPT_STATE_DIR:=$HOME/.arc/ckpt}"
mkdir -p "$ARC_CKPT_STATE_DIR"

_arc_ckpt_log() { printf '[arc-ckpt %(%H:%M:%S)T] %s\n' -1 "$*" >&2; }

_arc_ckpt_jobid() {
  if [ -n "${SLURM_ARRAY_JOB_ID:-}" ]; then echo "${SLURM_ARRAY_JOB_ID}_${SLURM_ARRAY_TASK_ID}"; else echo "${SLURM_JOB_ID:-local-$$}"; fi
}

# Restarts so far: requeue bumps SLURM_RESTART_COUNT, chain mode passes ARC_CKPT_ATTEMPT.
_arc_ckpt_attempt() {
  local a="${SLURM_RESTART_COUNT:-0}" b="${ARC_CKPT_ATTEMPT:-0}"
  echo $(( a > b ? a : b ))
}

# arc_ckpt_run CMD [ARGS...] — run the trainer, forward checkpoint signals, return its exit code.
arc_ckpt_run() {
  "$@" &
  local child=$!
  # shellcheck disable=SC2064  # bind $child now
  for sig in USR1 USR2 TERM; do
    trap "_arc_ckpt_log 'batch shell got SIG$sig → forwarding to $child'; kill -s $sig $child 2>/dev/null" "$sig"
  done
  _arc_ckpt_log "job $(_arc_ckpt_jobid) attempt $(_arc_ckpt_attempt): started pid $child on $(hostname)"
  # `wait` returns early (status >128) each time a trapped signal arrives; keep waiting.
  while kill -0 "$child" 2>/dev/null; do wait "$child" || true; done
  local rc=0
  wait "$child" || rc=$?
  trap - USR1 USR2 TERM
  return "$rc"
}

# arc_ckpt_finish RC — resubmit when the trainer exited with 99 ("checkpointed, resume me").
arc_ckpt_finish() {
  local rc="${1:-0}" mode="${ARC_CKPT_RESUBMIT:-requeue}" n max="${ARC_CKPT_MAX_RESTARTS:-10}"
  n=$(_arc_ckpt_attempt)
  if [ "$rc" -ne "$ARC_CKPT_EXIT_RESUME" ]; then
    _arc_ckpt_log "trainer exited $rc — not resubmitting"
    exit "$rc"
  fi
  local noresume="$ARC_CKPT_STATE_DIR/$(_arc_ckpt_jobid).noresume"
  if [ -e "$noresume" ]; then
    rm -f "$noresume"
    _arc_ckpt_log "checkpointed and stopped on request (--no-resume) — not resubmitting"
    exit 0
  fi
  if [ "$n" -ge "$max" ]; then
    _arc_ckpt_log "checkpointed, but restart limit reached ($n/$max) — resubmit by hand"
    exit 0
  fi
  case "$mode" in
    requeue)
      # Same job id, back to PENDING; SLURM_RESTART_COUNT increments. Needs `#SBATCH --requeue`.
      _arc_ckpt_log "checkpointed — requeueing $(_arc_ckpt_jobid) (restart $((n + 1))/$max)"
      scontrol requeue "$(_arc_ckpt_jobid)" && exit 0
      _arc_ckpt_log "requeue refused (site policy?) — falling back to chain"
      ;&
    chain)
      local script="${ARC_CKPT_SCRIPT:-$(scontrol show job "${SLURM_JOB_ID}" | tr ' ' '\n' | sed -n 's/^Command=//p')}"
      [ -f "$script" ] || { _arc_ckpt_log "cannot find script to resubmit ('$script'); set ARC_CKPT_SCRIPT"; exit "$rc"; }
      local id
      id=$(sbatch --parsable --dependency="afterany:${SLURM_JOB_ID}" \
             --export="ALL,ARC_CKPT_ATTEMPT=$((n + 1))" "$script") || { _arc_ckpt_log "sbatch failed"; exit "$rc"; }
      _arc_ckpt_log "checkpointed — submitted continuation ${id%%;*} (restart $((n + 1))/$max)"
      exit 0
      ;;
    *)
      _arc_ckpt_log "checkpointed — ARC_CKPT_RESUBMIT=$mode, leaving it to you"
      exit 0
      ;;
  esac
}

# For bash training loops (no Python): flags you can poll between iterations.
#   arc_ckpt_trap
#   for i in ...; do work; arc_ckpt_save_due && save; arc_ckpt_stopping && { save; exit 99; }; done
ARC_CKPT_SAVE=0 ARC_CKPT_STOP=0
arc_ckpt_trap() {
  trap 'ARC_CKPT_SAVE=1' USR2
  trap 'ARC_CKPT_STOP=1' USR1 TERM
}
arc_ckpt_stopping() {
  local f="$ARC_CKPT_STATE_DIR/$(_arc_ckpt_jobid).stop"
  [ -e "$f" ] && { rm -f "$f"; ARC_CKPT_STOP=1; }
  [ "$ARC_CKPT_STOP" = 1 ]
}
arc_ckpt_save_due() {
  local f="$ARC_CKPT_STATE_DIR/$(_arc_ckpt_jobid).save"
  [ -e "$f" ] && { rm -f "$f"; ARC_CKPT_SAVE=1; }
  if [ "$ARC_CKPT_SAVE" = 1 ] || [ "$ARC_CKPT_STOP" = 1 ]; then ARC_CKPT_SAVE=0; return 0; fi
  return 1
}
