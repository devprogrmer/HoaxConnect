import { useEffect, useState } from "react";

export default function DeviceReportingSettings() {
  const [permissions, setPermissions] = useState<HoaxReportingPermissions | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    window.hoax?.reporting?.getSettings().then((result) => {
      if (!active) return;
      if (result.ok) setPermissions(result.permissions);
      else setMessage(result.error.message);
    }).catch(() => { if (active) setMessage("Reporting settings are unavailable."); });
    return () => { active = false; };
  }, []);

  async function change(key: keyof HoaxReportingPermissions, enabled: boolean) {
    if (!permissions || !window.hoax?.reporting || busy) return;
    const previous = permissions;
    const next = { ...permissions, [key]: enabled };
    setPermissions(next);
    setBusy(true);
    try {
      const result = await window.hoax.reporting.setPermissions(next);
      if (!result.ok) throw new Error(result.error.message);
      setPermissions(result.permissions);
      setMessage("Saved. Changes reach the server when connected.");
    } catch (error) {
      setPermissions(previous);
      setMessage(error instanceof Error ? error.message : "Settings could not be saved.");
    }
    finally { setBusy(false); }
  }

  const options: Array<[keyof HoaxReportingPermissions, string, string]> = [
    ["hardware", "Share hardware details", "Send your PC model, CPU, RAM and a hashed hardware ID to HoaxConnect administrators."],
    ["network", "Share connection diagnostics", "Send network availability, request failures and response time to HoaxConnect."],
    ["applications", "Share open application names", "Send names of applications with visible windows. Window titles, file paths and browsing history are excluded."],
  ];
  return <section className="device-reporting-settings">
    <h2>Device reporting</h2>
    <p>Your signed-in app reports its presence and connection IP. Additional sharing is optional. Reports expire after 24 hours.</p>
    <fieldset disabled={!permissions || busy}>
      {options.map(([key, label, description]) => <label className="settingRow" key={key}>
        <span><strong>{label}</strong><span>{description}</span></span>
        <input type="checkbox" role="switch" checked={permissions?.[key] || false}
          onChange={(event) => { void change(key, event.target.checked); }} />
      </label>)}
    </fieldset>
    <p role="status">{message || (!window.hoax?.reporting ? "Available in the updated desktop app." : "")}</p>
  </section>;
}
