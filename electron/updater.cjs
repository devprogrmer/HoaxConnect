const {
  app,
  ipcMain,
} = require("electron");

const {
  autoUpdater,
} = require("electron-updater");

const fs = require("fs");
const path = require("path");

let mainWindow = null;
let registered = false;

let state = {
  status: "idle",

  currentVersion:
    app.getVersion(),

  availableVersion: null,

  percent: 0,

  bytesPerSecond: 0,
  transferred: 0,
  total: 0,

  error: null,
};

function updaterLog(level, ...parts) {
  try {
    const file = path.join(
      app.getPath("userData"),
      "updater.log"
    );

    if (
      fs.existsSync(file) &&
      fs.statSync(file).size >
        2 * 1024 * 1024
    ) {
      const previous =
        `${file}.1`;

      fs.rmSync(
        previous,
        {
          force: true,
        }
      );

      fs.renameSync(
        file,
        previous
      );
    }

    const message = parts
      .map((part) => {
        if (part instanceof Error) {
          return part.stack || part.message;
        }

        if (typeof part === "string") {
          return part;
        }

        try {
          return JSON.stringify(part);
        } catch {
          return String(part);
        }
      })
      .join(" ");

    fs.appendFileSync(
      file,
      `[${new Date().toISOString()}] [${level}] ${message}\n`,
      "utf8"
    );
  } catch {
    // Logging must never crash the updater.
  }
}

function cleanError(error) {
  if (!error) {
    return "Unknown updater error";
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function publishState(patch = {}) {
  state = {
    ...state,
    ...patch,

    currentVersion:
      app.getVersion(),
  };

  if (
    mainWindow &&
    !mainWindow.isDestroyed()
  ) {
    mainWindow.webContents.send(
      "updater:status",
      state
    );
  }

  return state;
}

function configureUpdater() {
  autoUpdater.logger = {
    info(...parts) {
      updaterLog(
        "UPDATER-INFO",
        ...parts
      );
    },

    warn(...parts) {
      updaterLog(
        "UPDATER-WARN",
        ...parts
      );
    },

    error(...parts) {
      updaterLog(
        "UPDATER-ERROR",
        ...parts
      );
    },

    debug(...parts) {
      updaterLog(
        "UPDATER-DEBUG",
        ...parts
      );
    },
  };

  autoUpdater.autoDownload = false;

  // Allow differential downloads. electron-updater
  // falls back to the full installer if blockmaps are unavailable.
  autoUpdater.disableDifferentialDownload = false;

  // User explicitly decides whether to install.
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on(
    "checking-for-update",
    () => {
      updaterLog("INFO", "checking-for-update");

      publishState({
        status: "checking",
        error: null,
      });
    }
  );

  autoUpdater.on(
    "update-available",
    (info) => {
      updaterLog("INFO", "update-available", info);

      publishState({
        status: "available",

        availableVersion:
          info.version,

        percent: 0,

        error: null,
      });
    }
  );

  autoUpdater.on(
    "update-not-available",
    (info) => {
      publishState({
        status: "up-to-date",

        availableVersion:
          info?.version ||
          app.getVersion(),

        percent: 0,

        error: null,
      });
    }
  );

  autoUpdater.on(
    "download-progress",
    (progress) => {
      updaterLog(
        "INFO",
        "download-progress",
        {
          percent: progress.percent,
          transferred: progress.transferred,
          total: progress.total,
          bytesPerSecond: progress.bytesPerSecond,
        }
      );

      publishState({
        status: "downloading",

        percent:
          Number(
            progress.percent || 0
          ),

        bytesPerSecond:
          progress.bytesPerSecond || 0,

        transferred:
          progress.transferred || 0,

        total:
          progress.total || 0,

        error: null,
      });
    }
  );

  autoUpdater.on(
    "update-downloaded",
    (info) => {
      updaterLog("INFO", "update-downloaded", info);

      publishState({
        status: "downloaded",

        availableVersion:
          info.version,

        percent: 100,

        error: null,
      });
    }
  );

  autoUpdater.on(
    "error",
    (error) => {
      updaterLog("ERROR", error);

      publishState({
        status: "error",

        error:
          cleanError(error),
      });
    }
  );
}

async function checkForUpdates() {
  if (!app.isPackaged) {
    return publishState({
      status: "dev",

      error:
        "Updater only runs inside an installed HoaxConnect build.",
    });
  }

  try {
    publishState({
      status: "checking",
      error: null,
    });

    await autoUpdater
      .checkForUpdates();

    return state;
  } catch (error) {
    return publishState({
      status: "error",

      error:
        cleanError(error),
    });
  }
}

async function downloadUpdate() {
  if (!app.isPackaged) {
    return publishState({
      status: "dev",
    });
  }

  try {
    publishState({
      status: "downloading",
      percent: 0,
      error: null,
    });

    await autoUpdater
      .downloadUpdate();

    return state;
  } catch (error) {
    return publishState({
      status: "error",

      error:
        cleanError(error),
    });
  }
}

function installUpdate() {
  if (
    state.status !==
    "downloaded"
  ) {
    const next =
      publishState({
        status: "error",

        error:
          "Update has not been downloaded yet.",
      });

    return {
      ok: false,
      state: next,
    };
  }

  /*
    Works with electron-updater 6.x.
    App exits, installer replaces current version,
    then HoaxConnect is reopened.
  */
  /*
    electron-updater 6.x:
    arg1 = silent install
    arg2 = force relaunch after update

    This keeps the NSIS installer UI hidden during updates.
  */
  autoUpdater.quitAndInstall(
    true,
    true
  );

  return {
    ok: true,
  };
}

function registerUpdater() {
  if (registered) {
    return;
  }

  registered = true;

  configureUpdater();

  ipcMain.handle(
    "updater:get-state",
    async () => state
  );

  ipcMain.handle(
    "updater:check",
    async () =>
      await checkForUpdates()
  );

  ipcMain.handle(
    "updater:download",
    async () =>
      await downloadUpdate()
  );

  ipcMain.handle(
    "updater:install",
    async () =>
      installUpdate()
  );
}

function attachUpdaterWindow(window) {
  mainWindow = window;

  publishState();

  if (!app.isPackaged) {
    return;
  }

  /*
    Give UI time to load,
    then silently check once.
  */
  setTimeout(() => {
    checkForUpdates()
      .catch(() => {});
  }, 5000);
}

module.exports = {
  registerUpdater,
  attachUpdaterWindow,
};
