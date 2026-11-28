# Windows Application Split Tunnel Design

## Intent

HoaxConnect for Windows is an application-based gaming tunnel. A user selects one or more games or applications, chooses Auto Location or a specific VPN node, and presses Connect. Only the selected executable paths and their descendant processes use HoaxConnect; other Windows traffic keeps using the user's normal internet connection.

## Goals

- Replace the simulated Connect button with authenticated VPN authorization and a privileged Windows tunnel service.
- Route selected executable paths and their descendants through WireGuard while preserving ordinary system traffic.
- Support Auto Location and explicit node selection through the same connection contract.
- Fail closed for selected applications when the protected path is unavailable, without blocking unselected applications.
- Restore routes, DNS policy, firewall policy and service state after disconnect, lease expiry, crash or reboot.
- Expose honest connection state, node, lease, errors and measured network quality to Electron.

## Non-goals

- Full-device VPN as the primary product mode.
- Android, iOS, router or console support in this stage.
- Multi-path packet duplication, multi-internet bonding, traffic shaping or FPS tuning in this stage.
- Shipping unsigned kernel components or copying proprietary ExitLag implementation details.

## Constraints

- Windows 10/11 x64 is the initial target.
- Electron remains unprivileged. A LocalSystem Windows service owns the TUN engine and all route/DNS changes.
- The service accepts commands only over an ACL-restricted local named pipe and validates every executable path.
- WireGuard private keys never enter the renderer or logs and are stored using Windows machine protection.
- Selected-only is the only connectable mode in this stage. Existing all/exclude-selected values remain readable but cannot start a tunnel.
- Production traffic must never use the current UI simulation or synthetic server measurements.

## Approaches

1. Electron runs elevated networking commands directly. Rejected because renderer/main-process compromise would gain broad networking privileges and cleanup would be unreliable.
2. A LocalSystem Windows service owns a pinned sing-box TUN engine with its WireGuard endpoint, while Electron uses a narrow named-pipe protocol. Selected because sing-box supports Windows process-path routing, strict DNS routing and WireGuard without requiring HoaxConnect to ship an unsigned kernel callout driver.
3. Full-device WireGuard plus route exceptions. Rejected because it cannot reliably enforce per-executable routing and contradicts the product model.
4. WireGuardNT plus ordinary user-mode WFP filters. Rejected for the first release: ordinary filters can allow or block an application, but connection redirection requires a signed WFP callout driver. HoaxConnect will not claim per-app routing from allow/block rules.

## Architecture

`src` renders the selected apps, location and connection state. `electron` requests VPN authorization from the existing authenticated Backend, talks to the local service, and never applies routes itself. `native/HoaxConnect.Service` owns key generation, the pinned sing-box child process, generated configuration, lease enforcement and recovery. sing-box captures traffic through its Windows TUN, sends matching `process_path` traffic to its WireGuard endpoint, and sends unmatched traffic directly through the detected physical interface. The existing Backend remains the authority for node assignment and session revocation.

The first deliverable is a service protocol and fail-closed orchestrator with a deterministic fake platform used by Linux CI. Windows-specific WireGuardNT/WFP adapters then implement that protocol and are verified in a Windows VM before installer publication.

## Connection Flow

1. Validate that at least one absolute `.exe` path is selected and mode is `selected-only`.
2. Ask the service for the device's WireGuard public key.
3. Electron calls `POST /api/v1/vpn/authorize` with the key and optional node preference.
4. Electron passes only the returned node endpoint, server key, assigned address, DNS and lease to the service.
5. The service generates a strict TUN configuration, starts the routing engine, verifies its health and only then reports connected.
6. The service renews before lease expiry. On renewal failure or expiry, selected traffic is blocked and the adapter is removed.
7. Disconnect revokes the Backend session first when possible, then always removes local policy.

## Safety and Recovery

- Service commands are idempotent and carry a connection generation ID.
- Startup removes orphaned owned policy before accepting a new connection.
- The engine configuration, process and TUN interface are instance-owned; cleanup removes only HoaxConnect-owned objects.
- A service crash leaves selected applications blocked until recovery cleanup completes; unselected traffic remains unaffected.
- The installer must roll back service and driver installation on failure.

## Acceptance

- Automated contract tests cover path validation, authorization errors, lease expiry, idempotent disconnect and crash recovery.
- Electron tests prove no simulated success remains.
- Windows integration proves a selected test process exits through the VPN node while an unselected process keeps the normal public IP. Capturing unmatched traffic locally is acceptable only when it is forwarded directly and the observed egress remains unchanged.
- Disconnect, service termination and reboot each restore the expected state without DNS or IPv6 leaks.

