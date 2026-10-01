import { useEffect, useState } from "react";

export interface ReportedDevice {
  id: string; name: string; device_uid: string; platform: string | null;
  os: string; os_version: string | null; architecture: string | null;
  client_version: string | null; key_fingerprint: string | null;
  last_seen_at: string | null; revoked_at: string | null; banned_at: string | null;
  presence: string; report_received_at: string | null; reported_ip: string | null;
  report_details_allowed: boolean;
  report_permissions: { hardware: boolean; network: boolean; applications: boolean } | null;
  hardware: { hwid_sha256: string | null; manufacturer: string | null; model: string | null; cpu: string | null; memory_bytes: number } | null;
  network: { interface_online: boolean; backend_rtt_ms: number | null; failed_heartbeats: number } | null;
  applications: string[] | null;
}

const date = (value: string | null) => value ? new Date(value).toLocaleString() : "Never";

export default function DeviceReports({ devices }: { devices: ReportedDevice[] }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, []);
  if (!devices.length) return null;
  return <section className="device-reports">
    <div className="section-title"><h2>Device activity</h2><span className="count-pill">{devices.length}</span></div>
    {devices.map((device) => {
      const fresh = Boolean(device.report_received_at && now - Date.parse(device.report_received_at) < 90_000);
      const online = device.presence === "online" && fresh;
      const state = online ? "App online" : device.presence === "closed" ? "App closed" :
        device.presence === "session_inactive" ? "Session inactive" : device.presence === "not_reported" ? "No app reports" : "No recent contact";
      const unavailable = (permission: "hardware" | "network" | "applications") => !device.report_details_allowed
        ? "Restricted to administrators" : !device.report_permissions?.[permission] ? "Not shared" : "Unavailable";
      return <details className="device-report" key={device.id} open={devices.length === 1}>
        <summary><strong>{device.name}</strong><span className={`status-badge ${online ? "status-active" : "status-pending"}`}>{state}</span></summary>
        <dl className="device-report-grid">
          <div><dt>Device installation ID</dt><dd><code>{device.device_uid}</code></dd></div>
          <div><dt>Connection IP</dt><dd>{!device.report_details_allowed ? "Restricted to administrators" : device.reported_ip || "No report received"}</dd></div>
          <div><dt>Last report received</dt><dd>{date(device.report_received_at)}</dd></div>
          <div><dt>System / app version</dt><dd>{[device.platform || device.os, device.os_version, device.architecture].filter(Boolean).join(" / ")}<small>HoaxConnect {device.client_version || "Unknown"}</small></dd></div>
          <div className="device-report-wide"><dt>Device signing-key fingerprint</dt><dd><code>{device.key_fingerprint || "Unavailable"}</code></dd></div>
          <div className="device-report-wide"><dt>Hardware ID (SHA-256, client-reported)</dt><dd><code>{device.hardware?.hwid_sha256 || (device.hardware ? "Hardware identifier unavailable" : unavailable("hardware"))}</code></dd></div>
          <div><dt>Computer model</dt><dd>{device.hardware ? [device.hardware.manufacturer, device.hardware.model].filter(Boolean).join(" / ") || "Unavailable" : unavailable("hardware")}</dd></div>
          <div><dt>CPU / RAM</dt><dd>{device.hardware ? `${device.hardware.cpu || "Unknown CPU"} / ${(device.hardware.memory_bytes / 1024 ** 3).toFixed(1)} GB` : unavailable("hardware")}</dd></div>
          <div><dt>Network availability (last reported)</dt><dd>{device.network ? device.network.interface_online ? "Network available" : "Network unavailable" : unavailable("network")}</dd></div>
          <div><dt>Backend response time</dt><dd>{device.network ? device.network.backend_rtt_ms === null ? "Not measured yet" : `${device.network.backend_rtt_ms} ms` : unavailable("network")}
            {device.network && <small>{device.network.failed_heartbeats} consecutive failed reports before this sample</small>}</dd></div>
          <div className="device-report-wide"><dt>Open applications (visible windows)</dt><dd>{!device.report_details_allowed ? unavailable("applications") : !device.report_permissions?.applications ? "Not shared" : !online ? "No current app report" : device.applications === null ? "Unavailable" : device.applications.length ? device.applications.join(", ") : "No visible applications reported"}</dd></div>
        </dl>
      </details>;
    })}
  </section>;
}
