"""Minimal PyTorch loop wired to arc_ckpt. Copy the marked lines into your own trainer.

    python example_train.py --ckpt-dir /work/$USER/ckpt/demo --steps 100000
"""
import argparse

import torch

from arc_ckpt import Guard, latest_checkpoint, save_atomic

ap = argparse.ArgumentParser()
ap.add_argument("--ckpt-dir", required=True)
ap.add_argument("--steps", type=int, default=100_000)
args = ap.parse_args()

dev = "cuda" if torch.cuda.is_available() else "cpu"
model = torch.nn.Sequential(torch.nn.Linear(512, 512), torch.nn.ReLU(), torch.nn.Linear(512, 10)).to(dev)
opt = torch.optim.AdamW(model.parameters(), lr=1e-3)

guard = Guard()                                             # ← 1. install handlers

start = 0
if (ck := latest_checkpoint(args.ckpt_dir)) is not None:    # ← 2. resume if a checkpoint exists
    state = torch.load(ck, map_location=dev)
    model.load_state_dict(state["model"])
    opt.load_state_dict(state["opt"])
    torch.set_rng_state(state["rng"])
    start = state["step"] + 1
    print(f"resumed from {ck} at step {start}")


def save(step: int):
    state = {"model": model.state_dict(), "opt": opt.state_dict(), "rng": torch.get_rng_state(), "step": step}
    # zero-padded names so "newest" sorts last; keep=2 prunes older ones
    return save_atomic(lambda p: torch.save(state, p), f"{args.ckpt_dir}/step{step:09d}.pt", keep=2)


for step in range(start, args.steps):
    x = torch.randn(256, 512, device=dev)
    loss = model(x).logsumexp(-1).mean()
    opt.zero_grad()
    loss.backward()
    opt.step()
    if step % 1000 == 0:
        print(f"step {step} loss {loss.item():.4f}", flush=True)

    if guard.checkpoint_due:                                # ← 3. save when asked
        guard.saved(step=step, path=save(step))
    if guard.stopping:                                      # ← 4. leave; the wrapper resubmits
        guard.exit()

save(args.steps - 1)
guard.done()
