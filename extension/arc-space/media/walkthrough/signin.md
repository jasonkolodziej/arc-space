## Sign in (DUO)

A **local** terminal runs `ssh -fN arc`. Enter your password and approve DUO.

That opens a background master connection that lasts about 10 hours. Views, tasks, Remote-SSH windows and the compute-node hop all reuse it with no more prompts. **Arc: Sign Out** closes it.

When it expires, the status bar shows **Arc: sign in**.
