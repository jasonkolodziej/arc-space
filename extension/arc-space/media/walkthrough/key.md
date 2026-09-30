## SSH key

The Mac → compute-node hop authenticates to the node's sshd with a key. The key is added to `~/.ssh/authorized_keys` on Arc. `/home` is shared, so every node sees it.

A dedicated `~/.ssh/id_ed25519_arc` is recommended. Give it a passphrase: on macOS it goes into your keychain (`UseKeychain` / `AddKeysToAgent` are set in the managed config).
