const {
  contextBridge,
  ipcRenderer,
} = require("electron");

contextBridge.exposeInMainWorld(
  "hoax",
  {
    isDesktop: true,

    platform:
      process.platform,

    version:
      ipcRenderer.sendSync(
        "app:get-version"
      ),

    apps: {
      list() {
        return ipcRenderer.invoke(
          "apps:list"
        );
      },

      addManual() {
        return ipcRenderer.invoke(
          "apps:add-manual"
        );
      },
    },

    splitTunnel: {
      get() {
        return ipcRenderer.invoke(
          "split:get"
        );
      },

      save(state) {
        return ipcRenderer.invoke(
          "split:save",
          state
        );
      },
    },

    doctor: {
      activity() {
        return ipcRenderer.invoke(
          "doctor:activity"
        );
      },

      health() {
        return ipcRenderer.invoke(
          "doctor:health"
        );
      },

      dnsState() {
        return ipcRenderer.invoke(
          "doctor:dns-state"
        );
      },

      benchmarkDNS() {
        return ipcRenderer.invoke(
          "doctor:dns-benchmark"
        );
      },

      applyDNS(servers) {
        return ipcRenderer.invoke(
          "doctor:dns-apply",
          servers
        );
      },

      restoreDNS() {
        return ipcRenderer.invoke(
          "doctor:dns-restore"
        );
      },

      endProcess(pid) {
        return ipcRenderer.invoke(
          "doctor:end-process",
          pid
        );
      },
    },

    traffic: {
      doctorSnapshot() {
        return ipcRenderer.invoke(
          "traffic:doctor-snapshot"
        );
      },

      endAndMeasure(pid) {
        return ipcRenderer.invoke(
          "traffic:end-and-measure",
          pid
        );
      },
    },

    diagnostics: {
      getConsent() {
        return ipcRenderer.invoke(
          "diagnostics:get-consent"
        );
      },

      setConsent(value) {
        return ipcRenderer.invoke(
          "diagnostics:set-consent",
          value
        );
      },

      snapshot() {
        return ipcRenderer.invoke(
          "diagnostics:snapshot"
        );
      },
    },

    network: {
      ping(
        target,
        count = 6
      ) {
        return ipcRenderer.invoke(
          "network:ping",
          target,
          count
        );
      },

      diagnostic(
        target = "1.1.1.1"
      ) {
        return ipcRenderer.invoke(
          "network:diagnostic",
          target
        );
      },

      publicIP() {
        return ipcRenderer.invoke(
          "network:public-ip"
        );
      },

      tcpProbe(
        target,
        port
      ) {
        return ipcRenderer.invoke(
          "network:tcp",
          target,
          port
        );
      },

      traceroute(
        target
      ) {
        return ipcRenderer.invoke(
          "network:traceroute",
          target
        );
      },
    },

    game: {
      scan() {
        return ipcRenderer.invoke(
          "game:scan"
        );
      },
    },

    updater: {
      getState() {
        return ipcRenderer.invoke(
          "updater:get-state"
        );
      },

      check() {
        return ipcRenderer.invoke(
          "updater:check"
        );
      },

      download() {
        return ipcRenderer.invoke(
          "updater:download"
        );
      },

      install() {
        return ipcRenderer.invoke(
          "updater:install"
        );
      },

      onStatus(callback) {
        const listener = (
          _event,
          state
        ) => {
          callback(state);
        };

        ipcRenderer.on(
          "updater:status",
          listener
        );

        return () => {
          ipcRenderer.removeListener(
            "updater:status",
            listener
          );
        };
      },
    },
  }
);
