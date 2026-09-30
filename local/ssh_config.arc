# ~/.ssh/config  (append; replace abc123 with your myUTSA ID)
#
# Hop 1: login node. ControlMaster multiplexes every later connection
# (Remote-SSH, the arc-node proxy, scp/rsync) over ONE authenticated
# socket, so you answer a single DUO prompt per ControlPersist window.
Host arc
    HostName arc.utsa.edu
    Port 22
    User abc123
    ControlMaster auto
    ControlPath ~/.ssh/cm-%r@%h:%p
    ControlPersist 10h
    ServerAliveInterval 60
    ServerAliveCountMax 5
    ForwardAgent no

# Hop 2: whichever compute node your "vscode" holder job is running on.
# Resolved at connect time, so the alias always follows the current allocation.
# Host keys differ per node, so they are not pinned; the hop already runs
# inside the authenticated, DUO-verified login connection.
Host arc-node
    User abc123
    ProxyCommand ~/.ssh/arc-proxy.sh
    StrictHostKeyChecking no
    UserKnownHostsFile /dev/null
    LogLevel ERROR
    ServerAliveInterval 60
    ServerAliveCountMax 5
