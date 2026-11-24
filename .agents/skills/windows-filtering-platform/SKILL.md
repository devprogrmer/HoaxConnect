---
name: windows-filtering-platform
description: "Assess whether a proposed HoaxConnect Windows filtering feature needs WFP and review its lifecycle in a Windows lab."
---

# Windows Filtering Platform

Start with `native/HoaxTraffic/Program.cs`, which observes kernel ETW events, and `docs/product/implementation-roadmap.md`. Confirm whether a WFP component or Windows service exists for the target branch before proposing integration. If requested, plan filter ownership, scoped application identity, privileges, transaction cleanup and fail-safe removal. Validate coexistence with Windows Firewall and VPN adapters in a disposable Windows VM using benign test traffic.
