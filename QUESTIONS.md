# ARC Questions

## on HPC Cluster

- What exit codes are per job or per step passed when time limits are exceeded?
- Is there an official list of exit codes and their meanings for jobs and steps on the Arc HPC cluster?
- Are there `SIGNALS` that can be trapped or handled by jobs on the Arc HPC cluster, and what are their effects on job termination?
- How are `SIGNALS` propagated to multi-step or array jobs, and can individual steps handle them differently?

- Can the extension detect and report these exit codes automatically?
- How should we signal this information to both the user and the system, ensuring proper handling and visibility of job termination reasons? -- primarily for time limit exceeded scenarios on data training jobs

> Working answers (standard Slurm behaviour), the checks to run on Arc, and the open items for RCSG are in [remote/ckpt/README.md § 4](remote/ckpt/README.md#4-exit-codes-and-signals-what-we-know-and-what-still-needs-confirming).
