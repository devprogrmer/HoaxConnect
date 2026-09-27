import {
  Check,
  Download,
  RefreshCw,
  RotateCcw,
  X,
} from "lucide-react";

import {
  useEffect,
  useState,
} from "react";

import "./Updater.css";

const emptyState: HoaxUpdateState = {
  status: "idle",

  currentVersion: "—",

  availableVersion: null,

  percent: 0,

  bytesPerSecond: 0,

  transferred: 0,

  total: 0,

  error: null,
};

function useUpdater() {
  const [
    state,
    setState,
  ] = useState<HoaxUpdateState>(
    emptyState
  );

  useEffect(() => {
    const updater =
      window.hoax?.updater;

    if (!updater) {
      return;
    }

    updater
      .getState()
      .then(setState)
      .catch(() => {});

    return updater.onStatus(
      setState
    );
  }, []);

  return {
    state,

    available:
      Boolean(
        window.hoax?.updater
      ),

    check: async () => {
      await window.hoax
        ?.updater
        .check();
    },

    download: async () => {
      await window.hoax
        ?.updater
        .download();
    },

    install: async () => {
      await window.hoax
        ?.updater
        .install();
    },
  };
}

export function UpdatePrompt() {
  const {
    state,
    download,
    install,
  } = useUpdater();

  const [
    dismissed,
    setDismissed,
  ] = useState(false);

  useEffect(() => {
    if (
      state.status ===
      "checking"
    ) {
      setDismissed(false);
    }
  }, [state.status]);

  const visible =
    !dismissed &&
    (
      state.status ===
        "available" ||
      state.status ===
        "downloading" ||
      state.status ===
        "downloaded"
    );

  if (!visible) {
    return null;
  }

  return (
    <div className="hcUpdateOverlay">
      <div className="hcUpdateModal">
        {state.status !==
          "downloading" && (
          <button
            className="hcUpdateClose"
            onClick={() =>
              setDismissed(true)
            }
          >
            <X size={18} />
          </button>
        )}

        <div className="hcUpdateIcon">
          {state.status ===
          "downloaded" ? (
            <Check size={28} />
          ) : (
            <Download size={28} />
          )}
        </div>

        {state.status ===
          "available" && (
          <>
            <span className="hcUpdateEyebrow">
              HOAXCONNECT UPDATE
            </span>

            <h2>
              Version{" "}
              {state.availableVersion}{" "}
              is available
            </h2>

            <p>
              You're currently using
              version{" "}
              {state.currentVersion}.
            </p>

            <div className="hcUpdateActions">
              <button
                className="hcUpdatePrimary"
                onClick={download}
              >
                <Download
                  size={16}
                />
                UPDATE NOW
              </button>

              <button
                className="hcUpdateSecondary"
                onClick={() =>
                  setDismissed(true)
                }
              >
                LATER
              </button>
            </div>
          </>
        )}

        {state.status ===
          "downloading" && (
          <>
            <span className="hcUpdateEyebrow">
              DOWNLOADING UPDATE
            </span>

            <h2>
              HoaxConnect{" "}
              {state.availableVersion}
            </h2>

            <p>
              Downloading new
              version...
            </p>

            <div className="hcUpdateProgress">
              <span
                style={{
                  width:
                    `${Math.min(
                      100,
                      Math.max(
                        0,
                        state.percent
                      )
                    )}%`,
                }}
              />
            </div>

            <strong className="hcUpdatePercent">
              {state.percent.toFixed(
                0
              )}
              %
            </strong>
          </>
        )}

        {state.status ===
          "downloaded" && (
          <>
            <span className="hcUpdateEyebrow">
              UPDATE READY
            </span>

            <h2>
              Ready to install
            </h2>

            <p>
              HoaxConnect will restart
              and install version{" "}
              {state.availableVersion}.
            </p>

            <div className="hcUpdateActions">
              <button
                className="hcUpdatePrimary"
                onClick={install}
              >
                <RotateCcw
                  size={16}
                />
                RESTART & UPDATE
              </button>

              <button
                className="hcUpdateSecondary"
                onClick={() =>
                  setDismissed(true)
                }
              >
                LATER
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function UpdateDock() {
  const {
    state,
    available,
    check,
  } = useUpdater();

  if (!available) {
    return null;
  }

  return (
    <button
      className="hcUpdateDock"
      onClick={check}
      disabled={
        state.status ===
          "checking"
      }
      title="Check for updates"
    >
      <RefreshCw
        size={14}
        className={
          state.status ===
          "checking"
            ? "hcUpdateSpin"
            : ""
        }
      />

      <span>
        v{state.currentVersion}
      </span>

      {state.status ===
        "available" && (
        <strong>
          UPDATE{" "}
          {state.availableVersion}
        </strong>
      )}

      {state.status ===
        "up-to-date" && (
        <strong>
          UP TO DATE
        </strong>
      )}

      {state.status ===
        "error" && (
        <strong>
          UPDATE ERROR
        </strong>
      )}
    </button>
  );
}
