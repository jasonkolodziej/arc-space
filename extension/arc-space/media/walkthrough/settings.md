## VS Code user settings

You'll see a checklist before anything is written. Unticked items keep your current value.

| Setting | Why |
|---|---|
| `remote.SSH.showLoginTerminal` | Shows the password/DUO prompt |
| `remote.SSH.remoteServerListenOnSocket` | Login nodes are shared; use a Unix socket, not a TCP port |
| `remote.SSH.remotePlatform` | Skips the "which OS?" prompt for `arc` / `arc-node` |
| `remote.SSH.defaultExtensions` | Python, Jupyter, ShellCheck on every Arc host |

Later template updates are merged three-way: values you changed or removed are never overwritten silently.
