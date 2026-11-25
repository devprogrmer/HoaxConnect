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
    { title: t("games.gameCatalog"), entries: gameCatalog },
    { title: t("games.appCatalog"), entries: appCatalog },
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
        t("games.saved")
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
          {t("games.desktopRequired")}
        </strong>

        <span>
          {t("games.desktopRequiredDescription")}
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
            {t("games.yourApps")}
          </h2>

          <p>
            {t("games.description")}
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
              {t("games.find")}
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

              {t("games.refresh")}
            </button>

            <button
              onClick={addManual}
            >
              <FolderOpen size={15} />

              {t("games.addExe")}
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
            placeholder={t("games.search")}
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
                    <span>{match ? (selected ? t("status.selected") : t("status.available")) :
                      installed.length > 1 ? t("games.chooseExecutable") : t("status.notInstalled")}</span>
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

            {t("games.scanning")}
          </div>
        ) : (
          <>
          <h3>{t("games.yourWindowsApps")}</h3>
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
                            {t("status.running")}
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
                  {t("games.noneFound")}
                </div>
              )}
          </div>
          </>
        )}

        <div className="splitFooter">
          <div>
            <strong>
              {t("games.appsSelected", { count: state.selectedApps.length })}
            </strong>

            <span>
              {state.selectedApps.length === 0
                ? t("games.selectAtLeastOne")
                : t("games.selectedOnly")}
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
              {connection === "connected" ? t("games.disconnect") :
                connection === "disconnecting" ? t("games.disconnecting") :
                saving || connection === "connecting" ? t("games.connecting") : t("games.connectSelected")}
            </button>
          </div>
        </div>
      </section>

    </div>
  );
}
