const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  session,
} = require("electron");

const path = require("path");

const {
  pingHost,
  runDiagnostic,
  traceroute,
  tcpProbe,
  getPublicIP,
} = require("./network.cjs");

const {
  scanActiveGame,
} = require("./game-detect.cjs");

const {
  registerUpdater,
  attachUpdaterWindow,
} = require("./updater.cjs");

const {
  scanWindowsApps,
  appFromManualPath,
} = require("./app-scanner.cjs");

const {
  readState: readSplitState,
  writeState: writeSplitState,
} = require("./split-store.cjs");

const {
  getActivitySnapshot,
  getDNSState,
  benchmarkDNS,
  applyDNS,
  restoreDNS,
  endProcess,
} = require("./network-doctor.cjs");

app.setAppUserModelId(
  "com.hoaxconnect.app"
);

let mainWindow = null;

const hasSingleInstanceLock =
  app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
}

async function addIconsToApps(items) {
  const result = [];

  for (const item of items) {
    let icon = null;

    try {
      const nativeIcon =
        await app.getFileIcon(
          item.path,
          {
            size: "normal",
          }
        );

      if (
        nativeIcon &&
        !nativeIcon.isEmpty()
      ) {
        icon =
          nativeIcon.toDataURL();
      }
    } catch {}

    result.push({
      ...item,
      icon,
    });
  }

  return result;
}

const {
  getConsent,
  saveConsent,
  buildSnapshot,
} = require("./diagnostics.cjs");

const {
  getDoctorSnapshot,
  endProcessAndMeasure,
  stopTrafficHelper,
} = require("./traffic-helper.cjs");

function registerIPC() {
  ipcMain.on(
    "app:get-version",
    (event) => {
      event.returnValue =
        app.getVersion();
    }
  );

  ipcMain.handle(
    "traffic:doctor-snapshot",
    async () => {
      return await getDoctorSnapshot();
    }
  );

  ipcMain.handle(
    "traffic:end-and-measure",
    async (_event, pid) => {
      return await endProcessAndMeasure(pid);
    }
  );


  ipcMain.handle(
    "diagnostics:get-consent",
    async () => {
      return getConsent();
    }
  );

  ipcMain.handle(
    "diagnostics:set-consent",
    async (_event, value) => {
      return saveConsent(value);
    }
  );

  ipcMain.handle(
    "diagnostics:snapshot",
    async () => {
      return await buildSnapshot();
    }
  );


  ipcMain.handle(
    "doctor:activity",
    async () => {
      const snapshot =
        await getActivitySnapshot();

      const processes = [];

      for (const item of snapshot.processes) {
        let icon = null;

        if (item.path) {
          try {
            const nativeIcon =
              await app.getFileIcon(
                item.path,
                {
                  size: "normal",
                }
              );

            if (
              nativeIcon &&
              !nativeIcon.isEmpty()
            ) {
              icon =
                nativeIcon.toDataURL();
            }
          } catch {}
        }

        processes.push({
          ...item,
          icon,
        });
      }

      return {
        ...snapshot,
        processes,
      };
    }
  );

  ipcMain.handle(
    "doctor:health",
    async () => {
      return await runDiagnostic(
        "1.1.1.1"
      );
    }
  );

  ipcMain.handle(
    "doctor:dns-state",
    async () => {
      return await getDNSState();
    }
  );

  ipcMain.handle(
    "doctor:dns-benchmark",
    async () => {
      return await benchmarkDNS();
    }
  );

  ipcMain.handle(
    "doctor:dns-apply",
    async (_event, servers) => {
      return await applyDNS(
        servers
      );
    }
  );

  ipcMain.handle(
    "doctor:dns-restore",
    async () => {
      return await restoreDNS();
    }
  );

  ipcMain.handle(
    "doctor:end-process",
    async (_event, pid) => {
      return await endProcess(
        pid
      );
    }
  );


  ipcMain.handle(
    "apps:list",
    async () => {
      const apps =
        await scanWindowsApps();

      return await addIconsToApps(
        apps
      );
    }
  );

  ipcMain.handle(
    "apps:add-manual",
    async () => {
      const result =
        await dialog.showOpenDialog(
          mainWindow,
          {
            title:
              "Select application",

            properties: [
              "openFile",
            ],

            filters: [
              {
                name:
                  "Windows applications",

                extensions: [
                  "exe",
                ],
              },
            ],
          }
        );

      if (
        result.canceled ||
        !result.filePaths.length
      ) {
        return null;
      }

      const item =
        appFromManualPath(
          result.filePaths[0]
        );

      const [withIcon] =
        await addIconsToApps([
          item,
        ]);

      return withIcon;
    }
  );

  ipcMain.handle(
    "split:get",
    async () => {
      return readSplitState();
    }
  );

  ipcMain.handle(
    "split:save",
    async (
      _event,
      state
    ) => {
      return writeSplitState(
        state
      );
    }
  );

  ipcMain.handle(
    "network:ping",
    async (
      _event,
      target,
      count
    ) => {
      return await pingHost(
        target,
        count
      );
    }
  );

  ipcMain.handle(
    "network:diagnostic",
    async (
      _event,
      target
    ) => {
      return await runDiagnostic(
        target || "1.1.1.1"
      );
    }
  );

  ipcMain.handle(
    "network:public-ip",
    async () => {
      return await getPublicIP();
    }
  );

  ipcMain.handle(
    "network:tcp",
    async (
      _event,
      target,
      port
    ) => {
      return await tcpProbe(
        target,
        port
      );
    }
  );

  ipcMain.handle(
    "network:traceroute",
    async (
      _event,
      target
    ) => {
      return await traceroute(
        target
      );
    }
  );

  ipcMain.handle(
    "game:scan",
    async () => {
      const scan =
        await scanActiveGame();

      if (
        !scan.detected ||
        !scan.server
      ) {
        return {
          ...scan,
          measurement: null,
        };
      }

      let ping = null;
      let tcp = null;

      try {
        ping =
          await pingHost(
            scan.server.ip,
            6
          );
      } catch {}

      if (
        (
          !ping ||
          !ping.reachable
        ) &&
        scan.server.protocol ===
          "TCP"
      ) {
        try {
          tcp =
            await tcpProbe(
              scan.server.ip,
              scan.server.port
            );
        } catch {}
      }

      let method =
        "endpoint-detection";

      let latencyMs = null;

      if (
        ping?.reachable &&
        ping.averageMs !== null
      ) {
        method = "ICMP";

        latencyMs =
          ping.averageMs;
      } else if (
        tcp?.reachable
      ) {
        method = "TCP";

        latencyMs =
          tcp.latencyMs;
      }

      return {
        ...scan,

        measurement: {
          method,

          latencyMs,

          jitterMs:
            ping?.reachable
              ? ping.jitterMs
              : null,

          packetLossPct:
            ping?.reachable
              ? ping.packetLossPct
              : null,

          icmpReachable:
            Boolean(
              ping?.reachable
            ),
        },
      };
    }
  );
}

function createWindow() {
  mainWindow =
    new BrowserWindow({
      width: 1440,
      height: 900,

      minWidth: 1100,
      minHeight: 700,

      backgroundColor:
        "#07090d",

      title:
        "HoaxConnect",

      autoHideMenuBar:
        true,

      icon: path.join(
        __dirname,
        "..",
        "build",
        "icon.png"
      ),

      webPreferences: {
        preload: path.join(
          __dirname,
          "preload.cjs"
        ),

        contextIsolation:
          true,

        nodeIntegration:
          false,

        sandbox:
          true,
      },
    });

  mainWindow.webContents.on(
    "will-navigate",
    (event, url) => {
      const allowed =
        app.isPackaged
          ? url.startsWith(
              "file://"
            )
          : url.startsWith(
              "http://localhost:5173"
            );

      if (!allowed) {
        event.preventDefault();
      }
    }
  );

  if (app.isPackaged) {
    mainWindow.loadFile(
      path.join(
        __dirname,
        "..",
        "dist",
        "index.html"
      )
    );
  } else {
    mainWindow.loadURL(
      "http://localhost:5173"
    );
  }

  mainWindow
    .webContents
    .setWindowOpenHandler(
      () => ({
        action: "deny",
      })
    );

  mainWindow.on(
    "closed",
    () => {
      mainWindow = null;
    }
  );

  attachUpdaterWindow(
    mainWindow
  );
}

if (hasSingleInstanceLock) {
  app.on(
    "second-instance",
    () => {
      if (!mainWindow) {
        return;
      }

      if (
        mainWindow.isMinimized()
      ) {
        mainWindow.restore();
      }

      mainWindow.show();
      mainWindow.focus();
    }
  );
}

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) {
    return;
  }

  session.defaultSession
    .setPermissionRequestHandler(
      (
        _webContents,
        _permission,
        callback
      ) => {
        callback(false);
      }
    );

  registerIPC();

  registerUpdater();

  createWindow();
});

app.on(
  "activate",
  () => {
    if (
      BrowserWindow
        .getAllWindows()
        .length === 0
    ) {
      createWindow();
    }
  }
);

app.on(
  "window-all-closed",
  () => {
    if (
      process.platform !==
      "darwin"
    ) {
      app.quit();
    }
  }
);


app.on("before-quit", () => {
  try {
    stopTrafficHelper();
  } catch {}
});
