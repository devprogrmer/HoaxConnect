import {
  AppWindow,
  Check,
  FolderOpen,
  RefreshCw,
  Search,
} from "lucide-react";

import {
  useEffect,
  useMemo,
  useState,
} from "react";

import "./SplitTunnel.css";
import { appCatalog, gameArtwork, gameCatalog } from "./game-catalog";
import { useI18n } from "./i18n";

const DEFAULT_STATE:
  HoaxSplitTunnelState = {
    mode: "selected-only",
    selectedApps: [],
    updatedAt: null,
  };

export default function SplitTunnel({ connection, onConnect }: {
  connection: string;
  onConnect: () => Promise<void>;
}) {
  const { t } = useI18n();
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

  const catalogSections = [
    { title: "Game catalog", entries: gameCatalog },
    { title: "App catalog", entries: appCatalog },
  ].map(({ title, entries }) => ({
    title,
    entries: entries.filter(({ name, executables }) => {
      const query = search.trim().toLowerCase();
      return name.toLowerCase().includes(query) ||
        executables.some((executable) => executable.includes(query));
    }),
  }));

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
          .save({ ...state, mode: "selected-only" });

      setState(result);

      setSavedMessage(
        "App selection saved."
      );

      window.setTimeout(
        () =>
          setSavedMessage(""),
        2200
      );
      return true;
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
            {t("games.applicationRouting")}
          </span>

          <h2>
            Your apps
          </h2>

          <p>
            Tick the games or apps you want to connect, then choose Connect selected.
          </p>
        </div>

        <div className="splitSummary">
          <span>
            {t("games.selectedApps")}
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

      <section className="splitAppsCard">
        <div className="splitAppsHeader">
          <div>
            <span className="splitSectionTitle">
              {t("games.windowsApps")}
            </span>

            <strong>
              Find games and apps
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
            placeholder="Search games and apps…"
          />
        </div>

        {catalogSections.map(({ title, entries }) => entries.length > 0 && (
          <section key={title} className="splitCatalog" aria-label={title}>
            <h3>{title}</h3>
            <div className="splitAppList">
              {entries.map((game) => {
                const installed = apps.filter((app) =>
                  game.executables.some((exe) => exe === app.exeName.toLowerCase())
                );
                const match = installed.length === 1 ? installed[0] : undefined;
                const selected = match ? selectedIDs.has(match.id) : false;
                const artwork = game.steamId ? gameArtwork(game.steamId) : match?.icon;
                return (
                  <button
                    key={game.name}
                    type="button"
                    className={`splitApp splitCatalogGame${selected ? " splitAppSelected" : ""}`}
                    aria-pressed={selected}
                    disabled={!match}
                    onClick={() => { if (match) toggleApp(match); }}
                  >
                    <div className="splitCatalogArtwork">
                      <AppWindow size={24} aria-hidden="true" />
                      {artwork && <img src={artwork} alt="" loading="lazy"
                        style={game.steamId ? undefined : { objectFit: "contain" }}
                        referrerPolicy="no-referrer"
                        onError={(event) => { event.currentTarget.hidden = true; }} />}
                    </div>
                    <strong>{game.name}</strong>
                    <span>{match ? (selected ? "Selected" : "Available") :
                      installed.length > 1 ? "Choose an executable below" : "Not detected"}</span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}

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
          <>
          <h3>Your Windows apps</h3>
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
                    aria-pressed={selected}
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
          </>
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
              {state.selectedApps.length === 0
                ? "Select at least one game or app to connect."
                : "Only the selected apps use the tunnel."}
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
              onClick={async () => {
                if (connection === "connected" || await save()) await onConnect();
              }}
              disabled={saving || connection === "connecting" ||
                connection === "disconnecting" ||
                (connection !== "connected" && state.selectedApps.length === 0)}
            >
              {connection === "connected" ? "Disconnect" :
                connection === "disconnecting" ? "Disconnecting…" :
                saving || connection === "connecting" ? "Connecting…" : "Connect selected"}
            </button>
          </div>
        </div>
      </section>

    </div>
  );
}
