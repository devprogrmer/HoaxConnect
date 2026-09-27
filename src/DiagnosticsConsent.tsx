import {
  Activity,
  AppWindow,
  Check,
  Globe2,
  ShieldCheck,
  X,
} from "lucide-react";

import {
  useEffect,
  useState,
} from "react";

import "./DiagnosticsConsent.css";

const DEFAULT:
  HoaxDiagnosticsConsent = {
    enabled: true,

    shareGameDetection: true,
    shareAppUsage: true,
    shareNetworkQuality: true,
    shareDomains: false,

    acceptedAt: null,
    updatedAt: null,
  };

export default function DiagnosticsConsentGate() {
  const [
    consent,
    setConsent,
  ] = useState<
    HoaxDiagnosticsConsent | null
  >(null);

  const [
    open,
    setOpen,
  ] = useState(false);

  const [
    loading,
    setLoading,
  ] = useState(true);

  const [
    saving,
    setSaving,
  ] = useState(false);

  const desktop =
    Boolean(
      window.hoax?.diagnostics
    );

  useEffect(() => {
    if (!desktop) {
      setLoading(false);
      return;
    }

    window.hoax!.diagnostics
      .getConsent()
      .then((value) => {
        setConsent(value);

        if (
          !value.acceptedAt &&
          !value.updatedAt
        ) {
          setConsent({
            ...DEFAULT,
          });

          setOpen(true);
        }
      })
      .finally(() => {
        setLoading(false);
      });
  }, [desktop]);

  async function save(
    value:
      HoaxDiagnosticsConsent
  ) {
    if (
      !window.hoax?.diagnostics
    ) {
      return;
    }

    setSaving(true);

    try {
      const result =
        await window.hoax
          .diagnostics
          .setConsent(value);

      setConsent(result);
      setOpen(false);
    } finally {
      setSaving(false);
    }
  }

  function toggle(
    key:
      | "shareGameDetection"
      | "shareAppUsage"
      | "shareNetworkQuality"
      | "shareDomains"
  ) {
    setConsent((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        [key]:
          !current[key],
      };
    });
  }

  if (
    loading ||
    !desktop ||
    !consent
  ) {
    return null;
  }

  return (
    <>
      {!open && (
        <button
          className="diagnosticsPrivacyButton"
          onClick={() =>
            setOpen(true)
          }
          title="Diagnostics privacy"
        >
          <ShieldCheck
            size={15}
          />

          PRIVACY
        </button>
      )}

      {open && (
        <div className="diagnosticsOverlay">
          <div className="diagnosticsModal">
            {consent.acceptedAt && (
              <button
                className="diagnosticsClose"
                onClick={() =>
                  setOpen(false)
                }
              >
                <X size={17} />
              </button>
            )}

            <div className="diagnosticsIcon">
              <ShieldCheck
                size={25}
              />
            </div>

            <span className="diagnosticsEyebrow">
              PRIVACY & DIAGNOSTICS
            </span>

            <h2>
              Network Diagnostics
            </h2>

            <p className="diagnosticsIntro">
              HoaxConnect can collect
              limited network diagnostics
              to troubleshoot connection,
              latency and routing issues.
              Passwords, messages,
              keystrokes, page contents
              and full HTTPS URLs are not
              collected.
            </p>

            <div className="diagnosticsOptions">
              <Option
                icon={
                  <Activity
                    size={17}
                  />
                }
                title="Network quality"
                description="Ping, jitter, packet loss and connection health."
                checked={
                  consent
                    .shareNetworkQuality
                }
                onClick={() =>
                  toggle(
                    "shareNetworkQuality"
                  )
                }
              />

              <Option
                icon={
                  <AppWindow
                    size={17}
                  />
                }
                title="Network applications"
                description="Applications with active network connections."
                checked={
                  consent
                    .shareAppUsage
                }
                onClick={() =>
                  toggle(
                    "shareAppUsage"
                  )
                }
              />

              <Option
                icon={
                  <Activity
                    size={17}
                  />
                }
                title="Game detection"
                description="Detected games and game-network diagnostics."
                checked={
                  consent
                    .shareGameDetection
                }
                onClick={() =>
                  toggle(
                    "shareGameDetection"
                  )
                }
              />

              <Option
                icon={
                  <Globe2
                    size={17}
                  />
                }
                title="Remote hostnames"
                description="Resolved network hostnames for troubleshooting. Full page URLs and content are not collected."
                checked={
                  consent
                    .shareDomains
                }
                onClick={() =>
                  toggle(
                    "shareDomains"
                  )
                }
              />
            </div>

            <div className="diagnosticsMaster">
              <div>
                <strong>
                  Diagnostics sharing
                </strong>

                <span>
                  You can disable it at
                  any time from this
                  privacy control.
                </span>
              </div>

              <button
                className={
                  consent.enabled
                    ? "diagSwitch diagSwitchOn"
                    : "diagSwitch"
                }
                onClick={() =>
                  setConsent({
                    ...consent,
                    enabled:
                      !consent.enabled,
                  })
                }
              >
                <span />
              </button>
            </div>

            <button
              className="diagnosticsAccept"
              disabled={saving}
              onClick={() =>
                save(consent)
              }
            >
              <Check size={16} />

              {saving
                ? "SAVING..."
                : consent.acceptedAt
                  ? "SAVE PRIVACY SETTINGS"
                  : "I AGREE & CONTINUE"}
            </button>

            {!consent.acceptedAt && (
              <button
                className="diagnosticsDecline"
                disabled={saving}
                onClick={() =>
                  save({
                    ...DEFAULT,

                    enabled: false,

                    shareGameDetection:
                      false,

                    shareAppUsage:
                      false,

                    shareNetworkQuality:
                      false,

                    shareDomains:
                      false,
                  })
                }
              >
                Continue without
                diagnostics
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function Option({
  icon,
  title,
  description,
  checked,
  onClick,
}: {
  icon:
    React.ReactNode;

  title: string;
  description: string;
  checked: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={
        checked
          ? "diagnosticsOption diagnosticsOptionActive"
          : "diagnosticsOption"
      }
      onClick={onClick}
    >
      <div className="diagnosticsOptionIcon">
        {icon}
      </div>

      <div className="diagnosticsOptionText">
        <strong>
          {title}
        </strong>

        <span>
          {description}
        </span>
      </div>

      <div
        className={
          checked
            ? "diagnosticsCheck diagnosticsCheckActive"
            : "diagnosticsCheck"
        }
      >
        {checked && (
          <Check size={14} />
        )}
      </div>
    </button>
  );
}
