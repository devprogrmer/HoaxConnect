import ProcessTrafficPanel from "./ProcessTrafficPanel";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Check,
  CircleAlert,
  Gauge,
  Globe2,
  Network,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Wifi,
} from "lucide-react";

import {
  useEffect,
  useMemo,
  useState,
} from "react";

import "./NetworkDoctor.css";

function formatBytesPerSecond(value: number) {
  if (value >= 1_000_000) {
    return `${(
      value /
      1_000_000
    ).toFixed(1)} MB/s`;
  }

  if (value >= 1000) {
    return `${(
      value / 1000
    ).toFixed(1)} KB/s`;
  }

  return `${value.toFixed(0)} B/s`;
}

export default function NetworkDoctor() {
  const [
    activity,
    setActivity,
  ] =
    useState<
      HoaxDoctorActivity | null
    >(null);

  const [
    health,
    setHealth,
  ] =
    useState<
      HoaxDiagnosticResult | null
    >(null);

  const [
    dnsBenchmark,
    setDnsBenchmark,
  ] =
    useState<
      HoaxDNSBenchmark | null
    >(null);

  const [
    dnsState,
    setDnsState,
  ] =
    useState<
      HoaxDNSState | null
    >(null);

  const [
    loading,
    setLoading,
  ] = useState(false);

  const [
    dnsLoading,
    setDnsLoading,
  ] = useState(false);

  const [
    search,
    setSearch,
  ] = useState("");

  const [
    error,
    setError,
  ] = useState("");

  const [
    pendingDNS,
    setPendingDNS,
  ] =
    useState<
      HoaxDNSResult | null
    >(null);

  const [
    confirmKill,
    setConfirmKill,
  ] =
    useState<
      HoaxDoctorProcess | null
    >(null);

  const desktop =
    Boolean(
      window.hoax?.doctor
    );

  async function refreshActivity() {
    if (!window.hoax?.doctor) {
      return;
    }

    try {
      const result =
        await window.hoax
          .doctor
          .activity();

      setActivity(result);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : String(error)
      );
    }
  }

  async function runHealth() {
    if (!window.hoax?.doctor) {
      return;
    }

    setLoading(true);
    setError("");

    try {
      const [
        healthResult,
        activityResult,
        currentDNS,
      ] =
        await Promise.all([
          window.hoax.doctor.health(),
          window.hoax.doctor.activity(),
          window.hoax.doctor.dnsState(),
        ]);

      setHealth(
        healthResult
      );

      setActivity(
        activityResult
      );

      setDnsState(
        currentDNS
      );
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
    if (!desktop) {
      return;
    }

    runHealth();

    const timer =
      window.setInterval(
        refreshActivity,
        6000
      );

    return () =>
      window.clearInterval(
        timer
      );
  }, []);

  async function runDNSBenchmark() {
    if (!window.hoax?.doctor) {
      return;
    }

    setDnsLoading(true);
    setError("");

    try {
      const result =
        await window.hoax
          .doctor
          .benchmarkDNS();

      setDnsBenchmark(
        result
      );

      setDnsState(
        await window.hoax
          .doctor
          .dnsState()
      );
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : String(error)
      );
    } finally {
      setDnsLoading(false);
    }
  }

  async function applyDNS(
    result: HoaxDNSResult
  ) {
    if (!window.hoax?.doctor) {
      return;
    }

    setDnsLoading(true);

    try {
      const state =
        await window.hoax
          .doctor
          .applyDNS(
            result.servers
          );

      setDnsState(state);
      setPendingDNS(null);

      await runDNSBenchmark();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : String(error)
      );
    } finally {
      setDnsLoading(false);
    }
  }

  async function restoreDNS() {
    if (!window.hoax?.doctor) {
      return;
    }

    setDnsLoading(true);

    try {
      const state =
        await window.hoax
          .doctor
          .restoreDNS();

      setDnsState(state);

      await runDNSBenchmark();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : String(error)
      );
    } finally {
      setDnsLoading(false);
    }
  }

  async function killProcess(
    item: HoaxDoctorProcess
  ) {
    if (!window.hoax?.doctor) {
      return;
    }

    try {
      await window.hoax
        .doctor
        .endProcess(
          item.pid
        );

      setConfirmKill(null);

      await refreshActivity();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : String(error)
      );
    }
  }

  async function addToSplitTunnel(
    processInfo: HoaxDoctorProcess
  ) {
    if (
      !window.hoax?.splitTunnel ||
      !processInfo.path
    ) {
      setError(
        "Split Tunnel is not available in this build."
      );

      return;
    }

    try {
      const current =
        await window.hoax
          .splitTunnel
          .get();

      if (
        current.selectedApps.some(
          (item) =>
            item.path
              .toLowerCase() ===
            processInfo.path
              .toLowerCase()
        )
      ) {
        return;
      }

      await window.hoax
        .splitTunnel
        .save({
          ...current,

          selectedApps: [
            ...current.selectedApps,

            {
              id:
                processInfo.id,

              name:
                processInfo.name,

              exeName:
                processInfo.exeName,

              path:
                processInfo.path,

              source:
                "network-doctor",
            },
          ],
        });
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : String(error)
      );
    }
  }

  const processes =
    useMemo(() => {
      const query =
        search
          .trim()
          .toLowerCase();

      const source =
        activity?.processes || [];

      if (!query) {
        return source;
      }

      return source.filter(
        (item) =>
          item.name
            .toLowerCase()
            .includes(query) ||
          item.path
            .toLowerCase()
            .includes(query)
      );
    }, [activity, search]);

  const recommendation =
    useMemo(() => {
      if (
        !health ||
        !activity
      ) {
        return null;
      }

      const ping =
        health.ping.averageMs;

      const jitter =
        health.ping.jitterMs;

      const loss =
        health.ping.packetLossPct;

      const top =
        activity.processes[0];

      if (loss >= 2) {
        return {
          level: "bad",
          title:
            "Packet loss detected",

          text:
            `Your current packet loss is ${loss}%. Check Wi-Fi quality, router load or the ISP path.`,
        };
      }

      if (
        ping !== null &&
        ping >= 80 &&
        activity.downloadMbps >= 5 &&
        top
      ) {
        return {
          level:
            "warning",

          title:
            "Latency is high while the connection is busy",

          text:
            `${top.name} currently has the highest number of active network connections. Pausing or closing background network activity may improve latency.`,
        };
      }

      if (jitter >= 15) {
        return {
          level:
            "warning",

          title:
            "Connection stability is inconsistent",

          text:
            `Jitter is currently ${jitter} ms. Background traffic, Wi-Fi interference or the ISP path may be contributing.`,
        };
      }

      return {
        level: "good",

        title:
          "Network looks healthy",

        text:
          "No major latency, jitter or packet-loss issue was detected in the current sample.",
      };
    }, [health, activity]);

  if (!desktop) {
    return (
      <div className="doctorUnavailable">
        <Activity size={44} />

        <strong>
          Desktop app required
        </strong>

        <span>
          Network Doctor runs locally on
          Windows.
        </span>
      </div>
    );
  }

  return (
    <div className="doctorPage">
      <section className="doctorOverview">
        <div className="doctorMetric">
          <ArrowDown />

          <span>
            DOWNLOAD NOW
          </span>

          <strong>
            {
              activity
                ?.downloadMbps
                .toFixed(2) ||
              "--"
            }{" "}
            Mbps
          </strong>

          <small>
            {activity
              ? formatBytesPerSecond(
                  activity
                    .downloadBytesPerSecond
                )
              : ""}
          </small>
        </div>

        <div className="doctorMetric">
          <ArrowUp />

          <span>
            UPLOAD NOW
          </span>

          <strong>
            {
              activity
                ?.uploadMbps
                .toFixed(2) ||
              "--"
            }{" "}
            Mbps
          </strong>

          <small>
            {activity
              ? formatBytesPerSecond(
                  activity
                    .uploadBytesPerSecond
                )
              : ""}
          </small>
        </div>

        <div className="doctorMetric">
          <Gauge />

          <span>PING</span>

          <strong>
            {health?.ping
              .averageMs !== null &&
            health?.ping
              .averageMs !==
              undefined
              ? `${health.ping.averageMs} ms`
              : "--"}
          </strong>

          <small>
            Jitter{" "}
            {health?.ping
              .jitterMs ??
              "--"}{" "}
            ms
          </small>
        </div>

        <div className="doctorMetric">
          <Wifi />

          <span>
            PACKET LOSS
          </span>

          <strong>
            {health?.ping
              .packetLossPct ??
              "--"}
            %
          </strong>

          <small>
            {
              activity?.adapter
                .alias || ""
            }
          </small>
        </div>
      </section>

      <div className="doctorToolbar">
        <div>
          <span className="eyebrow">
            NETWORK DOCTOR
          </span>

          <strong>
            Live connection health
          </strong>
        </div>

        <button
          onClick={runHealth}
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

          RUN DIAGNOSIS
        </button>
      </div>

      {error && (
        <div className="doctorError">
          <CircleAlert
            size={17}
          />

          {error}
        </div>
      )}

      {recommendation && (
        <section
          className={`doctorRecommendation ${recommendation.level}`}
        >
          <ShieldCheck
            size={21}
          />

          <div>
            <strong>
              {
                recommendation.title
              }
            </strong>

            <span>
              {
                recommendation.text
              }
            </span>
          </div>
        </section>
      )}

      <section className="doctorCard">
        <div className="doctorCardHeader">
          <div>
            <span className="eyebrow">
              WINDOWS PROCESSES
            </span>

            <h2>
              Network activity
            </h2>
          </div>

          <div className="doctorSearch">
            <Search size={15} />

            <input
              placeholder="Search process..."
              value={search}
              onChange={(
                event
              ) =>
                setSearch(
                  event.target
                    .value
                )
              }
            />
          </div>
        </div>

        <div className="doctorProcessHeader">
          <span>APPLICATION</span>
          <span>TCP</span>
          <span>UDP</span>
          <span>CONNECTIONS</span>
          <span>ACTIONS</span>
        </div>

        <div className="doctorProcesses">
          {processes.map(
            (item) => (
              <div
                className="doctorProcess"
                key={`${item.pid}-${item.id}`}
              >
                <div className="doctorProcessIdentity">
                  <div className="doctorProcessIcon">
                    {item.icon ? (
                      <img
                        src={
                          item.icon
                        }
                        alt=""
                      />
                    ) : (
                      <Network
                        size={19}
                      />
                    )}
                  </div>

                  <div>
                    <strong>
                      {item.name}
                    </strong>

                    <span>
                      PID {item.pid}
                    </span>

                    <small
                      title={
                        item.path
                      }
                    >
                      {item.path ||
                        "Path unavailable"}
                    </small>
                  </div>
                </div>

                <strong>
                  {
                    item
                      .tcpConnections
                  }
                </strong>

                <strong>
                  {
                    item
                      .udpEndpoints
                  }
                </strong>

                <strong className="doctorConnections">
                  {
                    item
                      .totalConnections
                  }
                </strong>

                <div className="doctorProcessActions">
                  {window.hoax
                    ?.splitTunnel &&
                    item.path && (
                      <button
                        onClick={() =>
                          addToSplitTunnel(
                            item
                          )
                        }
                      >
                        VPN
                      </button>
                    )}

                  {confirmKill
                    ?.pid ===
                  item.pid ? (
                    <>
                      <button
                        className="killConfirm"
                        onClick={() =>
                          killProcess(
                            item
                          )
                        }
                      >
                        YES
                      </button>

                      <button
                        onClick={() =>
                          setConfirmKill(
                            null
                          )
                        }
                      >
                        NO
                      </button>
                    </>
                  ) : (
                    <button
                      className="killButton"
                      onClick={() =>
                        setConfirmKill(
                          item
                        )
                      }
                    >
                      <Trash2
                        size={13}
                      />
                    </button>
                  )}
                </div>
              </div>
            )
          )}
        </div>

        <div className="doctorAccuracyNote">
          Exact per-process bandwidth accounting
          is intentionally not estimated in this
          build. Current process data represents
          real Windows TCP/UDP network activity.
        </div>
      </section>

      <section className="doctorCard">
        <div className="doctorCardHeader">
          <div>
            <span className="eyebrow">
              DNS DOCTOR
            </span>

            <h2>
              Resolver benchmark
            </h2>

            <p>
              Current DNS:{" "}
              {dnsState?.adapter
                ?.dnsServers
                ?.join(", ") ||
                activity?.adapter
                  ?.dnsServers
                  ?.join(", ") ||
                "Detecting..."}
            </p>
          </div>

          <button
            className="dnsTestButton"
            onClick={
              runDNSBenchmark
            }
            disabled={
              dnsLoading
            }
          >
            <RefreshCw
              size={15}
              className={
                dnsLoading
                  ? "spin"
                  : ""
              }
            />

            TEST DNS
          </button>
        </div>

        {dnsBenchmark && (
          <div className="dnsResults">
            {dnsBenchmark
              .results
              .sort(
                (a, b) =>
                  a.score -
                  b.score
              )
              .map(
                (result) => {
                  const best =
                    dnsBenchmark
                      .recommended
                      ?.id ===
                    result.id;

                  return (
                    <div
                      className={
                        best
                          ? "dnsResult dnsBest"
                          : "dnsResult"
                      }
                      key={
                        result.id
                      }
                    >
                      <div>
                        <strong>
                          {
                            result.name
                          }
                        </strong>

                        {best && (
                          <span className="recommendedDNS">
                            RECOMMENDED
                          </span>
                        )}

                        <small>
                          {result.servers.join(
                            " / "
                          )}
                        </small>
                      </div>

                      <div>
                        <span>
                          AVG RESOLVE
                        </span>

                        <strong>
                          {result.averageMs !==
                          null
                            ? `${result.averageMs} ms`
                            : "FAILED"}
                        </strong>
                      </div>

                      <div>
                        <span>
                          FAILURES
                        </span>

                        <strong>
                          {
                            result.failures
                          }
                        </strong>
                      </div>

                      {result.id !==
                        "current" && (
                        <button
                          onClick={() =>
                            setPendingDNS(
                              result
                            )
                          }
                        >
                          APPLY
                        </button>
                      )}
                    </div>
                  );
                }
              )}
          </div>
        )}

        {pendingDNS && (
          <div className="dnsConfirmation">
            <Globe2
              size={20}
            />

            <div>
              <strong>
                Apply{" "}
                {
                  pendingDNS.name
                }{" "}
                DNS?
              </strong>

              <span>
                HoaxConnect will change DNS on
                the active Windows network
                adapter and save the previous
                configuration for restore.
              </span>
            </div>

            <button
              className="dnsConfirmButton"
              onClick={() =>
                applyDNS(
                  pendingDNS
                )
              }
            >
              <Check size={14} />
              CONFIRM
            </button>

            <button
              onClick={() =>
                setPendingDNS(
                  null
                )
              }
            >
              CANCEL
            </button>
          </div>
        )}

        {dnsState?.canRestore && (
          <button
            className="restoreDNSButton"
            onClick={restoreDNS}
            disabled={dnsLoading}
          >
            RESTORE ORIGINAL DNS
          </button>
        )}
      </section>

      <ProcessTrafficPanel />
</div>
  );
}
