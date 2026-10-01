"""arc_ckpt — tell a training loop when to checkpoint before Slurm stops it.

Standard library only. Install next to your code, or let setup-on-arc.sh copy it
to ~/.local/lib/arc and put that on PYTHONPATH.

Triggers this module understands (any of them sets the flags below):

  SIGUSR1   "save and exit so the job can resume"  — what `#SBATCH --signal=USR1@600`
            sends before the walltime, and what `arc ckpt stop JOBID` sends.
  SIGUSR2   "save now and keep training"           — `arc ckpt save JOBID`.
  SIGTERM   Slurm's final notice (timeout or scancel). Only KillWait seconds
            (often 30 s) remain before SIGKILL, so treat it as last-chance.
  deadline  No signal configured? The guard asks Slurm for the job's end time at
            start-up and raises `stopping` once fewer than `margin` seconds remain.
  files     ~/.arc/ckpt/<jobid>.save / .stop — same as USR2 / USR1, for tools that
            can write files but can't signal (the file is removed once seen). This is
            how VS Code reaches a trainer started by hand in a terminal on your node.

Minimal use:

    from arc_ckpt import Guard
    guard = Guard()                              # installs handlers, writes status
    start = load_checkpoint_if_any()
    for step in range(start, total):
        train_one_step()
        if guard.checkpoint_due:                 # stop requested, save requested, or periodic
            path = save_checkpoint(step)
            guard.saved(step=step, path=path)
        if guard.stopping:
            guard.exit()                         # exit 99 = "resume me", 0 = "don't"

Exit code contract (read by arc-ckpt.sh / train.sbatch):
    0   finished, or stopped on purpose (`arc ckpt stop --no-resume`)
    99  checkpointed and stopped early — please resubmit / requeue
"""
from __future__ import annotations

import getpass
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Optional

EXIT_RESUME = 99
_FINAL_GRACE = 25  # seconds we assume are left after SIGTERM


def _job_id() -> str:
    """The id squeue shows for this job: 123456, or 123456_7 for an array task."""
    array = os.environ.get("SLURM_ARRAY_JOB_ID")
    if array:
        return f"{array}_{os.environ.get('SLURM_ARRAY_TASK_ID', '')}"
    if os.environ.get("SLURM_JOB_ID"):
        return os.environ["SLURM_JOB_ID"]
    # A Remote-SSH terminal on your holder node has no Slurm variables; ask which of your
    # running jobs owns this node (nodes are exclusive per user on Arc, so it's unique).
    try:
        out = subprocess.run(["squeue", "-h", "-u", getpass.getuser(), "-t", "RUNNING",
                              "-w", socket.gethostname().split(".")[0], "-o", "%i"],
                             capture_output=True, text=True, timeout=20).stdout.split()
    except (OSError, subprocess.SubprocessError):
        out = []
    return out[0] if len(out) == 1 else f"local-{os.getpid()}"


def _slurm_end_time(job_id: str) -> Optional[float]:
    """Epoch seconds when Slurm will stop this job, or None if unknown."""
    env = os.environ.get("SLURM_JOB_END_TIME")  # set by Slurm >= 23.02
    if env and env.isdigit():
        return float(env)
    try:
        left = subprocess.run(["squeue", "-h", "-j", job_id, "-o", "%L"],
                              capture_output=True, text=True, timeout=20).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    secs = _parse_slurm_duration(left)
    return time.time() + secs if secs is not None else None


def _parse_slurm_duration(s: str) -> Optional[int]:
    """'1-02:03:04', '02:03:04', '03:04' -> seconds. 'UNLIMITED'/'' -> None."""
    s = s.strip()
    if not s or not s[0].isdigit():
        return None
    days = 0
    if "-" in s:
        d, s = s.split("-", 1)
        days = int(d)
    parts = [int(p) for p in s.split(":")]
    while len(parts) < 3:
        parts.insert(0, 0)
    h, m, sec = parts[-3:]
    return ((days * 24 + h) * 60 + m) * 60 + sec


class Guard:
    """Collects checkpoint/stop requests from signals, the walltime and request files.

    margin          seconds before the end time at which `stopping` turns on, as a
                    fallback when no --signal was configured (default 600, or
                    $ARC_CKPT_MARGIN).
    every           also make `checkpoint_due` true every N seconds (0 = off, or
                    $ARC_CKPT_EVERY). Cheap insurance against node failures.
    state_dir       where the status JSON lives (default ~/.arc/ckpt, or
                    $ARC_CKPT_STATE_DIR). The VS Code extension and `arc ckpt status`
                    read it.
    """

    def __init__(self, margin: Optional[float] = None, every: Optional[float] = None,
                 state_dir: Optional[str] = None, install: bool = True, verbose: bool = True):
        self.job_id = _job_id()
        self.margin = float(margin if margin is not None else os.environ.get("ARC_CKPT_MARGIN", 600))
        self.every = float(every if every is not None else os.environ.get("ARC_CKPT_EVERY", 0))
        self.verbose = verbose
        # Under DDP every rank has a guard; only rank 0 owns the status file.
        self.report = int(os.environ.get("RANK", os.environ.get("SLURM_PROCID", 0))) == 0
        self.restart_count = max(int(os.environ.get("SLURM_RESTART_COUNT", 0)), int(os.environ.get("ARC_CKPT_ATTEMPT", 0)))
        self.state_dir = Path(state_dir or os.environ.get("ARC_CKPT_STATE_DIR", Path.home() / ".arc" / "ckpt"))
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self._status_path = self.state_dir / f"{self.job_id}.json"
        self._lock = threading.Lock()
        self._pid = os.getpid()
        self._save_req = False
        self._stop_req = False
        self._final = False          # SIGTERM seen: KillWait clock is running
        self.reason = ""
        self.last_save: Optional[dict[str, Any]] = None
        self._last_save_t = time.time()
        self._last_file_check = 0.0
        self.interactive = "SLURM_JOB_ID" not in os.environ
        self.end_time = None if self.job_id.startswith("local-") else _slurm_end_time(self.job_id)
        if install:
            self.install()
        self._write("running")

    # ── triggers ────────────────────────────────────────────────────────────
    def install(self) -> None:
        """Install signal handlers (main thread only — Python's rule)."""
        for sig in (signal.SIGUSR1, signal.SIGUSR2, signal.SIGTERM):
            signal.signal(sig, self._on_signal)

    def _on_signal(self, signum: int, _frame: Any) -> None:
        if os.getpid() != self._pid:  # forked DataLoader workers inherit handlers; ignore there
            return
        # Handlers only flip flags; the training loop does the real work.
        if signum == signal.SIGUSR2:
            self._save_req, self.reason = True, self.reason or "SIGUSR2 (save requested)"
        elif signum == signal.SIGUSR1:
            self._stop_req, self.reason = True, "SIGUSR1 (walltime near / stop requested)"
        else:
            self._stop_req, self._final, self.reason = True, True, "SIGTERM (Slurm is stopping the job)"
        self._log(f"received {signal.Signals(signum).name}")

    def request_save(self, reason: str = "requested") -> None:
        self._save_req, self.reason = True, reason

    def request_stop(self, reason: str = "requested") -> None:
        self._stop_req, self.reason = True, reason

    def _poll_files(self) -> None:
        now = time.time()
        if now - self._last_file_check < 15:  # /home is Lustre: don't stat every step
            return
        self._last_file_check = now
        for name, act in (("save", self.request_save), ("stop", self.request_stop)):
            f = self.state_dir / f"{self.job_id}.{name}"
            if f.exists():
                f.unlink(missing_ok=True)
                act(f"{f.name} request file")
                self._log(f"found {f}")

    # ── what the loop asks ───────────────────────────────────────────────────
    @property
    def time_left(self) -> Optional[float]:
        return None if self.end_time is None else self.end_time - time.time()

    @property
    def stopping(self) -> bool:
        """True once the job should save and exit."""
        self._poll_files()
        if not self._stop_req and self.time_left is not None and self.time_left < self.margin:
            self._stop_req, self.reason = True, f"walltime: {int(self.time_left)} s left"
            self._log(self.reason)
        return self._stop_req

    @property
    def checkpoint_due(self) -> bool:
        """True when the loop should write a checkpoint now."""
        periodic = self.every > 0 and time.time() - self._last_save_t >= self.every
        return self.stopping or self._save_req or periodic

    @property
    def final(self) -> bool:
        """SIGTERM already arrived: save the smallest thing you can, fast."""
        return self._final

    # ── what the loop reports ─────────────────────────────────────────────────
    def saved(self, step: Any = None, path: Any = None, **extra: Any) -> None:
        """Call after a checkpoint is safely on disk."""
        self._save_req = False
        self._last_save_t = time.time()
        self.last_save = {"time": int(self._last_save_t), "step": step,
                          "path": str(path) if path is not None else None, **extra}
        self._write("stopping" if self._stop_req else "running")
        self._log(f"checkpoint saved (step={step}, path={path})")

    def exit(self, code: Optional[int] = None) -> None:
        """Leave the process: 99 asks the wrapper to resume, 0 if `--no-resume` was asked."""
        if code is None:
            noresume = self.state_dir / f"{self.job_id}.noresume"
            code = 0 if noresume.exists() else EXIT_RESUME
            noresume.unlink(missing_ok=True)
        self._write("exited-for-resume" if code == EXIT_RESUME else "stopped")
        self._log(f"exiting with {code} ({self.reason})")
        sys.stdout.flush()
        sys.exit(code)

    def done(self) -> None:
        """Mark a normal, complete finish."""
        self._write("finished")

    # ── plumbing ──────────────────────────────────────────────────────────────
    def _write(self, state: str) -> None:
        if not self.report:
            return
        data = {"job_id": self.job_id, "host": socket.gethostname(), "pid": self._pid,
                "state": state, "reason": self.reason, "updated": int(time.time()),
                "end_time": int(self.end_time) if self.end_time else None,
                "restart_count": self.restart_count, "last_save": self.last_save}
        tmp = self._status_path.with_suffix(f".json.{self._pid}.tmp")
        with self._lock:
            try:
                tmp.write_text(json.dumps(data, indent=1))
                os.replace(tmp, self._status_path)
            except OSError as e:  # status is advisory; never kill training over it
                self._log(f"could not write {self._status_path}: {e}")

    def _log(self, msg: str) -> None:
        if self.verbose:
            print(f"[arc-ckpt {time.strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


# ── framework adapters (imported lazily so the module stays dependency-free) ──

def hf_callback(guard: Guard):
    """Hugging Face `transformers.Trainer` callback.

        trainer = Trainer(..., callbacks=[hf_callback(guard)])
        trainer.train(resume_from_checkpoint=latest_or_none)
        if guard.stopping: guard.exit()
    """
    from transformers import TrainerCallback  # type: ignore

    class ArcCkptCallback(TrainerCallback):
        def on_step_end(self, args, state, control, **kw):
            if guard.checkpoint_due:
                control.should_save = True
            if guard.stopping:
                control.should_training_stop = True
            return control

        def on_save(self, args, state, control, **kw):
            guard.saved(step=state.global_step, path=f"{args.output_dir}/checkpoint-{state.global_step}")

    return ArcCkptCallback()


def save_atomic(save_fn, path: str | os.PathLike, keep: int = 2) -> Path:
    """Write via `save_fn(tmp_path)`, then rename, so a kill mid-write never leaves a
    corrupt "latest". Keeps the newest `keep` files matching the same stem prefix.

        save_atomic(lambda p: torch.save(state, p), f"{ckdir}/step{step:08d}.pt")
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".partial")
    save_fn(tmp)
    os.replace(tmp, path)
    latest = path.parent / "latest"
    try:
        latest.unlink(missing_ok=True)
        latest.symlink_to(path.name)
    except OSError:
        pass
    if keep > 0:
        olds = sorted(p for p in path.parent.glob(f"*{path.suffix}") if p.is_file() and not p.is_symlink())
        for old in olds[:-keep]:
            old.unlink(missing_ok=True)
    return path


def latest_checkpoint(ckdir: str | os.PathLike) -> Optional[Path]:
    """The checkpoint `save_atomic` last finished, or None on a fresh start."""
    link = Path(ckdir) / "latest"
    return link.resolve() if link.exists() else None


if __name__ == "__main__":  # `python arc_ckpt.py` — quick self-test without Slurm
    g = Guard(margin=0, every=0)
    print(f"status file: {g._status_path}; send `kill -USR2 {os.getpid()}` / `kill -USR1 {os.getpid()}`")
    step = 0
    while True:
        time.sleep(1)
        step += 1
        if g.checkpoint_due:
            g.saved(step=step, path=None)
        if g.stopping:
            g.exit()
