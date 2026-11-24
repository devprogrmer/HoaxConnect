---
name: windows-nsis-installer
description: "Review HoaxConnect Windows NSIS packaging when Electron distribution is in scope."
---

# Windows Nsis Installer

Inspect `package.json`, the product roadmap and `electron/updater.cjs` to confirm the actual Windows packaging target and supported update behavior. If NSIS is configured or explicitly requested, test signed clean install, upgrade, failed upgrade and uninstall on disposable Windows VMs. Verify expected user data retention, install scope, elevation behavior and helper compatibility. Keep release credentials out of installer content and local diagnostic logs.
