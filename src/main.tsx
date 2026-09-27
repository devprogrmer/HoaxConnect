import {
  StrictMode,
} from "react";

import {
  createRoot,
} from "react-dom/client";

import "./index.css";
import "flag-icons/css/flag-icons.min.css";

import App from "./App.tsx"
import DiagnosticsConsentGate from "./DiagnosticsConsent";;

import {
  UpdateDock,
  UpdatePrompt,
} from "./Updater";

function showFatalError(
  title: string,
  error: unknown
) {
  const root =
    document.getElementById(
      "root"
    );

  if (!root) return;

  const message =
    error instanceof Error
      ? `${error.message}\n\n${error.stack || ""}`
      : String(error);

  root.innerHTML = `
    <div style="
      min-height:100vh;
      padding:40px;
      background:#090b0f;
      color:#fff;
      font-family:monospace;
    ">
      <h1 style="color:#ff5577">
        ${title}
      </h1>

      <pre style="
        white-space:pre-wrap;
        color:#ddd;
        background:#11151c;
        padding:20px;
        border-radius:10px;
        border:1px solid #2a303a;
      ">${message
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")}</pre>
    </div>
  `;
}

window.addEventListener(
  "error",
  (event) => {
    showFatalError(
      "HoaxConnect JavaScript Error",
      event.error ||
        event.message
    );
  }
);

window.addEventListener(
  "unhandledrejection",
  (event) => {
    showFatalError(
      "HoaxConnect Promise Error",
      event.reason
    );
  }
);

try {
  const root =
    document.getElementById(
      "root"
    );

  if (!root) {
    throw new Error(
      "HTML element #root was not found"
    );
  }

  createRoot(root).render(
    <StrictMode>
      <App />
      <DiagnosticsConsentGate />

      <UpdatePrompt />

      <UpdateDock />
    </StrictMode>
  );
} catch (error) {
  showFatalError(
    "HoaxConnect Render Error",
    error
  );
}
