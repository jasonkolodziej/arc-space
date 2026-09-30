#!/bin/sh
# ~/.ssh/arc-proxy.sh  (chmod 700) — ProxyCommand for "Host arc-node".
# Finds the node running your holder job, then tunnels to its sshd through the
# multiplexed "arc" connection (no second DUO prompt, no netcat needed on Arc).
JOB_NAME="${ARC_HOLD_JOB:-vscode}"
node=$(ssh arc "squeue -u \$USER --name=$JOB_NAME --states=RUNNING --noheader --format=%N" 2>/dev/null \
        | head -n1 | tr -d '[:space:]')
if [ -z "$node" ]; then
  echo "arc-proxy: no RUNNING '$JOB_NAME' job. Allocate one first (Arc: Allocate Node, or 'arc alloc')." >&2
  exit 1
fi
case "$node" in
  *\[*) echo "arc-proxy: holder job spans multiple nodes ($node); use a 1-node job." >&2; exit 1 ;;
esac
exec ssh -W "${node}:22" arc
