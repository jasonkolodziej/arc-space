#!/bin/bash
#
# Runs ON the job's compute node(s), inside the job's allocation (srun --overlap) or via
# ssh from the login node. Pure bash/awk over /proc and /sys: no Python, no modules.
# Emits one "ARCMON {json}" line per interval with RAW counters; rates are computed by
# the extension, so the node does almost no work.
#
# Arc nodes are exclusive per user, so node-level counters are the job's usage.
#
# args: $1 interval seconds (default 2), $2 max lifetime seconds (default 14400)
# Exits when its stdout closes (panel closed / ssh gone) or the lifetime ends.
#
iv=${1:-2}; life=${2:-14400}
end=$(( $(date +%s) + life ))
host=$(hostname -s)
me=$$
ncpu=$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc)
hz=$(getconf CLK_TCK 2>/dev/null || echo 100)
uid=$(id -u)
has_gpu=0; command -v nvidia-smi >/dev/null 2>&1 && has_gpu=1
has_lctl=0; command -v lctl >/dev/null 2>&1 && has_lctl=1

lustre() {
  { if [ $has_lctl = 1 ]; then lctl get_param 'llite.*.stats' 2>/dev/null
    else for f in /proc/fs/lustre/llite/*/stats /sys/kernel/debug/lustre/llite/*/stats; do
      [ -r "$f" ] && { d=$(dirname "$f"); echo "llite.$(basename "$d").stats="; cat "$f"; }; done
    fi; } | awk '
      /^llite\./ { split($0, a, "."); n = a[2]; sub(/-[0-9a-f]+$/, "", n); seen[n] = 1; next }
      $1 == "read_bytes"  { r[n] += $7 }
      $1 == "write_bytes" { w[n] += $7 }
      END { c = 0; for (k in seen) printf "%s[\"%s\",%.0f,%.0f]", (c++ ? "," : ""), k, r[k], w[k] }'
}

ib() {
  c=0
  for p in /sys/class/infiniband/*/ports/*; do
    [ -r "$p/counters/port_rcv_data" ] || continue
    rx=$(cat "$p/counters/port_rcv_data"); tx=$(cat "$p/counters/port_xmit_data")
    dev=$(basename "$(dirname "$(dirname "$p")")")
    [ $c -gt 0 ] && printf ','
    printf '["%s:%s",%s,%s]' "$dev" "$(basename "$p")" "$((rx * 4))" "$((tx * 4))"   # counters are 4-byte words
    c=$((c + 1))
  done
}

while [ "$(date +%s)" -lt "$end" ]; do
  read -r l1 l5 l15 _ < /proc/loadavg
  printf 'ARCMON {"v":2,"t":%s,"host":"%s","ncpu":%s,"hz":%s,"load":[%s,%s,%s],' "$(date +%s.%N)" "$host" "$ncpu" "$hz" "$l1" "$l5" "$l15"

  printf '"cpu":['
  awk 'BEGIN{c=0} /^cpu/ { printf "%s[\"%s\",%s,%s,%s,%s,%s,%s,%s,%s]", (c++?",":""), $1, $2, $3, $4, $5, $6+0, $7+0, $8+0, $9+0 }' /proc/stat
  printf '],"mem":{'
  awk 'BEGIN{c=0} /^(MemTotal|MemAvailable|SwapTotal|SwapFree|Cached|Buffers|Shmem):/ { sub(":", "", $1); printf "%s\"%s\":%s", (c++?",":""), $1, $2 }' /proc/meminfo
  printf '},"net":['
  awk 'BEGIN{c=0} NR > 2 { sub(/^ +/, ""); split($0, a, ":"); n = a[1]; split(a[2], f, " "); if (n != "lo") printf "%s[\"%s\",%s,%s]", (c++?",":""), n, f[1], f[9] }' /proc/net/dev
  printf '],"ib":['; ib
  printf '],"disk":['
  awk 'BEGIN{c=0} $3 ~ /^(sd[a-z]+|nvme[0-9]+n[0-9]+|vd[a-z]+|xvd[a-z]+)$/ { printf "%s[\"%s\",%.0f,%.0f]", (c++?",":""), $3, $6 * 512, $10 * 512 }' /proc/diskstats
  printf '],"lustre":['; lustre
  printf '],"gpu":['
  if [ $has_gpu = 1 ]; then
    nvidia-smi --query-gpu=index,name,utilization.gpu,utilization.memory,memory.used,memory.total,power.draw,power.limit,temperature.gpu \
      --format=csv,noheader,nounits 2>/dev/null | awk -F', *' 'BEGIN{c=0} { gsub(/["\\]/, "", $2); printf "%s[%d,\"%s\",%s,%s,%s,%s,%s,%s,%s]", (c++?",":""), $1, $2, $3+0, $4+0, $5+0, $6+0, $7+0, $8+0, $9+0 }'
  fi
  printf '],"procs":['
  # Every process you own, with cumulative CPU ticks (utime+stime) so the extension can
  # compute *current* CPU% (ps %CPU is a lifetime average). comm may contain spaces/parens,
  # so fields are taken after the last ") " in /proc/<pid>/stat.
  ps -u "$uid" -o pid=,ppid=,rss=,etimes=,nlwp=,comm= 2>/dev/null | awk -v me="$me" '
    BEGIN { c = 0 }
    $1 != me && $2 != me && c < 400 {
      f = "/proc/" $1 "/stat"; t = 0
      if ((getline l < f) > 0) { sub(/^.*\) /, "", l); split(l, a, " "); t = a[12] + a[13] }
      close(f)
      cmd = $6; for (i = 7; i <= NF; i++) cmd = cmd " " $i; gsub(/["\\]/, "", cmd)
      printf "%s[%s,%s,%s,%s,%s,\"%s\"]", (c++ ? "," : ""), $1, t, $3, $4, $5, cmd
    }'
  printf ']}\n' || exit 0
  sleep "$iv"
done
