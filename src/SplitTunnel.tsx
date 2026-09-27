import {
  AppWindow,
  Check,
  FolderOpen,
  RefreshCw,
  Search,
  Shield,
  Wifi,
  X,
} from "lucide-react";

import {
  useEffect,
  useMemo,
  useState,
} from "react";

import "./SplitTunnel.css";

const DEFAULT_STATE:
  HoaxSplitTunnelState = {
    mode: "selected-only",
    selectedApps: [],
    updatedAt: null,
  };

export default function SplitTunnel() {
  const [
    apps,
    setApps,
  ] = useState<
    HoaxInstalledApp[]
  >([]);

  const [
    state,
    setState,
  ] = useState<
    HoaxSplitTunnelState
  >(DEFAULT_STATE);

  const [
    search,
    setSearch,
  ] = useState("");

  const [
    loading,
    setLoading,
  ] = useState(false);

  const [
    saving,
    setSaving,
  ] = useState(false);

  const [
    error,
    setError,
  ] = useState("");

  const [
    savedMessage,
    setSavedMessage,
  ] = useState("");

  const desktop =
    Boolean(
      window.hoax?.apps &&
      window.hoax?.splitTunnel
    );

  async function loadEverything() {
    if (!desktop) {
      return;
    }

    setLoading(true);
    setError("");

    try {
      const [
        installed,
        stored,
      ] =
        await Promise.all([
          window.hoax!.apps.list(),

          window.hoax!.splitTunnel.get(),
        ]);

      setApps(installed);
      setState(stored);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : String(error)
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadEverything();
  }, []);

  const selectedIDs =
    useMemo(
      () =>
        new Set(
          state.selectedApps.map(
            (item) => item.id
          )
        ),
      [state.selectedApps]
    );

  const visibleApps =
    useMemo(() => {
      const query =
        search
          .trim()
          .toLowerCase();

      if (!query) {
        return apps;
      }

      return apps.filter(
        (item) =>
          item.name
            .toLowerCase()
            .includes(query) ||

          item.exeName
            .toLowerCase()
            .includes(query) ||

          item.path
            .toLowerCase()
            .includes(query)
      );
    }, [apps, search]);

  function toggleApp(
    app: HoaxInstalledApp
  ) {
    const selected =
      selectedIDs.has(app.id);

    if (selected) {
      setState((old) => ({
        ...old,

        selectedApps:
          old.selectedApps.filter(
            (item) =>
              item.id !== app.id
          ),
      }));

      return;
    }

    setState((old) => ({
      ...old,

      selectedApps: [
        ...old.selectedApps,

        {
          id: app.id,

          name: app.name,

          exeName:
            app.exeName,

          path: app.path,

          source:
            app.source,
        },
      ],
    }));
  }

  async function addManual() {
    if (!window.hoax?.apps) {
      return;
    }

    try {
      const item =
        await window.hoax.apps
          .addManual();

      if (!item) {
        return;
      }

      setApps((old) => {
        if (
          old.some(
            (app) =>
              app.id === item.id
          )
        ) {
          return old;
        }

        return [
          item,
          ...old,
        ];
      });

      if (
        !selectedIDs.has(
          item.id
        )
      ) {
        toggleApp(item);
      }
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : String(error)
      );
    }
  }

  async function save() {
    if (
      !window.hoax?.splitTunnel
    ) {
      return;
    }

    setSaving(true);
    setError("");

    try {
      const result =
        await window.hoax
          .splitTunnel
          .save(state);

      setState(result);

      setSavedMessage(
        "Split Tunnel settings saved."
      );

      window.setTimeout(
        () =>
          setSavedMessage(""),
        2200
      );
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : String(error)
      );
    } finally {
      setSaving(false);
    }
  }

  if (!desktop) {
    return (
      <div className="splitUnavailable">
        <AppWindow size={44} />

        <strong>
          Desktop app required
        </strong>

        <span>
          Installed application scanning
          is only available inside
          HoaxConnect for Windows.
        </span>
      </div>
    );
  }

  return (
    <div className="splitPage">
      <section className="splitHero">
        <div>
          <span className="eyebrow">
            APPLICATION ROUTING
          </span>

          <h2>
            Split Tunnel
          </h2>

          <p>
            Choose which Windows
            applications should use
            HoaxConnect.
          </p>
        </div>

        <div className="splitSummary">
          <span>
            SELECTED APPS
          </span>

          <strong>
            {
              state
                .selectedApps
                .length
            }
          </strong>
        </div>
      </section>

      <section className="splitModeCard">
        <span className="splitSectionTitle">
          ROUTING MODE
        </span>

        <div className="splitModes">
          <button
            className={
              state.mode ===
              "selected-only"
                ? "splitModeActive"
                : ""
            }
            onClick={() =>
              setState((old) => ({
                ...old,
                mode:
                  "selected-only",
              }))
            }
          >
            <div className="splitModeIcon">
              <Wifi size={20} />
            </div>

            <div>
              <strong>
                Selected Apps Only
              </strong>

              <span>
                Only selected apps will
                use HoaxConnect.
              </span>
            </div>

            {state.mode ===
              "selected-only" && (
              <Check size={18} />
            )}
          </button>

          <button
            className={
              state.mode === "all"
                ? "splitModeActive"
                : ""
            }
            onClick={() =>
              setState((old) => ({
                ...old,
                mode: "all",
              }))
            }
          >
            <div className="splitModeIcon">
              <Shield size={20} />
            </div>

            <div>
              <strong>
                All Traffic
              </strong>

              <span>
                Route the whole device
                through HoaxConnect.
              </span>
            </div>

            {state.mode ===
              "all" && (
              <Check size={18} />
            )}
          </button>

          <button
            className={
              state.mode ===
              "exclude-selected"
                ? "splitModeActive"
                : ""
            }
            onClick={() =>
              setState((old) => ({
                ...old,
                mode:
                  "exclude-selected",
              }))
            }
          >
            <div className="splitModeIcon">
              <X size={20} />
            </div>

            <div>
              <strong>
                All Except Selected
              </strong>

              <span>
                Selected apps stay on
                direct internet.
              </span>
            </div>

            {state.mode ===
              "exclude-selected" && (
              <Check size={18} />
            )}
          </button>
        </div>
      </section>

      <section className="splitAppsCard">
        <div className="splitAppsHeader">
          <div>
            <span className="splitSectionTitle">
              WINDOWS APPLICATIONS
            </span>

            <strong>
              Choose apps
            </strong>
          </div>

          <div className="splitActions">
            <button
              onClick={loadEverything}
              disabled={loading}
            >
              <RefreshCw
                size={15}
                className={
                  loading
                    ? "spin"
                    : ""
                }
              />

              REFRESH
            </button>

            <button
              onClick={addManual}
            >
              <FolderOpen size={15} />

              ADD EXE
            </button>
          </div>
        </div>

        <div className="splitSearch">
          <Search size={17} />

          <input
            value={search}
            onChange={(event) =>
              setSearch(
                event.target.value
              )
            }
            placeholder="Search installed applications..."
          />
        </div>

        {error && (
          <div className="splitError">
            {error}
          </div>
        )}

        {loading ? (
          <div className="splitLoading">
            <RefreshCw
              className="spin"
              size={28}
            />

            Scanning Windows
            applications...
          </div>
        ) : (
          <div className="splitAppList">
            {visibleApps.map(
              (app) => {
                const selected =
                  selectedIDs.has(
                    app.id
                  );

                return (
                  <button
                    key={app.id}
                    className={
                      selected
                        ? "splitApp splitAppSelected"
                        : "splitApp"
                    }
                    onClick={() =>
                      toggleApp(app)
                    }
                  >
                    <div className="splitAppIcon">
                      {app.icon ? (
                        <img
                          src={app.icon}
                          alt=""
                        />
                      ) : (
                        <AppWindow
                          size={22}
                        />
                      )}
                    </div>

                    <div className="splitAppInfo">
                      <div className="splitAppName">
                        <strong>
                          {app.name}
                        </strong>

                        {app.running && (
                          <span className="runningBadge">
                            RUNNING
                          </span>
                        )}
                      </div>

                      <span>
                        {app.exeName}
                      </span>

                      <small
                        title={app.path}
                      >
                        {app.path}
                      </small>
                    </div>

                    <div
                      className={
                        selected
                          ? "splitCheck splitCheckOn"
                          : "splitCheck"
                      }
                    >
                      {selected && (
                        <Check
                          size={15}
                        />
                      )}
                    </div>
                  </button>
                );
              }
            )}

            {!visibleApps.length &&
              !loading && (
                <div className="splitEmpty">
                  No applications found.
                </div>
              )}
          </div>
        )}

        <div className="splitFooter">
          <div>
            <strong>
              {
                state
                  .selectedApps
                  .length
              }{" "}
              apps selected
            </strong>

            <span>
              Settings are stored locally
              on this Windows device.
            </span>
          </div>

          <div className="splitFooterRight">
            {savedMessage && (
              <span className="savedMessage">
                <Check size={14} />
                {savedMessage}
              </span>
            )}

            <button
              className="splitSave"
              onClick={save}
              disabled={saving}
            >
              {saving
                ? "SAVING..."
                : "SAVE SETTINGS"}
            </button>
          </div>
        </div>
      </section>

      <div className="splitEngineNotice">
        <Shield size={16} />

        <div>
          <strong>
            Routing engine status:
            configuration ready
          </strong>

          <span>
            App discovery and selection
            are active. Per-process VPN
            enforcement will become active
            when the HoaxConnect VPN/WFP
            service is installed.
          </span>
        </div>
      </div>
    </div>
  );
}
