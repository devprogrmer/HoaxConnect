# Security review status

Status: IN_PROGRESS. Use the existing WireGuard encryption and replay protection. Probe requests are authenticated with a separate dedicated key. Use private probe addresses and limit access to the staging network.

Open acceptance work: review session binding and deduplication, probe abuse and resource limits, WireGuard key rotation, Windows IPC and updater trust, dependency scan, and rollback and backup recovery. No formal audit has been completed.
