import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Gauge,
  ShieldCheck,
  Square,
  Zap,
} from "lucide-react";

import {
  useEffect,
  useState,
} from "react";

import "./ProcessTrafficPanel.css";

function mbps(
  value:
    number | undefined
) {
  const n =
    Number(value || 0);

  if (n >= 10) {
    return `${n.toFixed(1)} Mbps`;
  }

  if (n >= 1) {
    return `${n.toFixed(2)} Mbps`;
  }

  return `${Math.round(
    n * 1000
  )} Kbps`;
}

function bytes(
  value:
    number | undefined
) {
  let n =
    Number(value || 0);

  const units =
    [
      "B",
      "KB",
      "MB",
      "GB",
      "TB",
    ];

  let index = 0;

  while (
    n >= 1024 &&
    index <
      units.length - 1
  ) {
    n /= 1024;
    index++;
  }

  return `${n.toFixed(
    index >= 3
      ? 2
      : 1
  )} ${units[index]}`;
}

export default function ProcessTrafficPanel() {
  const [
    snapshot,
    setSnapshot,
  ] = useState<
    HoaxTrafficSnapshot | null
  >(null);

  const [
    loading,
    setLoading,
  ] = useState(true);

  const [
    actionPid,
    setActionPid,
  ] = useState<
    number | null
  >(null);

  const [
    result,
    setResult,
  ] = useState<
    HoaxTrafficEndResult | null
  >(null);

  const desktop =
    Boolean(
      window.hoax?.traffic
    );

  useEffect(() => {
    if (!desktop) {
      setLoading(false);
      return;
    }

    let alive =
      true;

    async function refresh() {
      try {
        const value =
          await window.hoax!
            .traffic
            .doctorSnapshot();

        if (alive) {
          setSnapshot(value);
        }
      } catch {
      } finally {
        if (alive) {
          setLoading(false);
        }
      }
    }

    refresh();

    const timer =
      window.setInterval(
        refresh,
        1500
      );

    return () => {
      alive = false;

      window.clearInterval(
        timer
      );
    };
  }, [desktop]);

  async function endAndMeasure(
    item:
      HoaxTrafficProcess
  ) {
    const ok =
      window.confirm(
        `End ${item.name}?\n\n` +
        `Current download: ${mbps(item.rxMbps)}\n` +
        `Current upload: ${mbps(item.txMbps)}\n\n` +
        `HoaxConnect will measure network quality before and after closing it.\n\n` +
        `Unsaved work or downloads in this program may be lost.`
      );

    if (!ok) {
      return;
    }

    setResult(null);
    setActionPid(
      item.pid
    );

    try {
      const value =
        await window.hoax!
          .traffic
          .endAndMeasure(
            item.pid
          );

      setResult(value);
    } catch (error) {
      window.alert(
        error instanceof Error
          ? error.message
          : String(error)
      );
    } finally {
      setActionPid(null);
    }
  }

  if (!desktop) {
    return (
      <section className="ptPanel">
        <div className="ptEmpty">
          Per-process traffic monitoring
          is available in the Windows
          desktop application.
        </div>
      </section>
    );
  }

  if (
    loading &&
    !snapshot
  ) {
    return (
      <section className="ptPanel">
        <div className="ptEmpty">
          Starting Windows traffic
          monitor...
        </div>
      </section>
    );
  }

  if (
    snapshot?.status ===
    "error"
  ) {
    return (
      <section className="ptPanel">
        <div className="ptError">
          <AlertTriangle
            size={17}
          />

          <div>
            <strong>
              Traffic engine unavailable
            </strong>

            <span>
              {snapshot.error}
            </span>
          </div>
        </div>
      </section>
    );
  }

  const health =
    snapshot?.health;

  return (
    <section className="ptPanel">
      <div className="ptHeader">
        <div>
          <span className="ptEyebrow">
            WINDOWS ETW
          </span>

          <h3>
            Live Process Traffic
          </h3>

          <p>
            Real TCP + UDP network
            activity grouped by Windows
            process.
          </p>
        </div>

        <div className="ptLive">
          <span />
          LIVE
        </div>
      </div>

      <div className="ptSummary">
        <div className="ptMetric">
          <ArrowDown
            size={15}
          />

          <span>
            TOTAL DOWNLOAD
          </span>

          <strong>
            {mbps(
              snapshot
                ?.totalRxMbps
            )}
          </strong>
        </div>

        <div className="ptMetric">
          <ArrowUp
            size={15}
          />

          <span>
            TOTAL UPLOAD
          </span>

          <strong>
            {mbps(
              snapshot
                ?.totalTxMbps
            )}
          </strong>
        </div>

        <div className="ptMetric">
          <Gauge
            size={15}
          />

          <span>
            PING
          </span>

          <strong>
            {health?.available
              ? `${health.avgPingMs} ms`
              : "--"}
          </strong>
        </div>

        <div className="ptMetric">
          <Activity
            size={15}
          />

          <span>
            JITTER / LOSS
          </span>

          <strong>
            {health?.available
              ? `${health.jitterMs} ms / ${health.packetLossPct}%`
              : "--"}
          </strong>
        </div>
      </div>

      {result && (
        <div
          className={
            result.improved
              ? "ptResult ptResultGood"
              : "ptResult"
          }
        >
          <ShieldCheck
            size={18}
          />

          <div>
            <strong>
              {result.processName} ended
            </strong>

            {result.before
              .available &&
            result.after
              .available ? (
              <span>
                Ping{" "}
                {result.before
                  .avgPingMs}
                {" → "}
                {result.after
                  .avgPingMs}
                {" ms"}

                {" · "}

                improvement{" "}
                {result
                  .pingImprovementMs !==
                null
                  ? `${result.pingImprovementMs} ms`
                  : "--"}
              </span>
            ) : (
              <span>
                Process was ended, but
                ICMP quality comparison
                was unavailable.
              </span>
            )}
          </div>
        </div>
      )}

      <div className="ptTitleRow">
        <strong>
          WHAT'S USING YOUR INTERNET?
        </strong>

        <span>
          RX / TX values refresh live
        </span>
      </div>

      <div className="ptProcesses">
        {snapshot?.processes
          ?.length ? (
          snapshot.processes.map(
            item => (
              <article
                key={item.pid}
                className="ptProcess"
              >
                <div className="ptProcessTop">
                  <div className="ptProcessIdentity">
                    <div className="ptProcessIcon">
                      {item.name
                        .slice(
                          0,
                          1
                        )
                        .toUpperCase()}
                    </div>

                    <div>
                      <strong>
                        {item.name}
                      </strong>

                      <span>
                        PID {item.pid}

                        {item.isGame
                          ? " · GAME"
                          : ""}
                      </span>
                    </div>
                  </div>

                  <div
                    className={
                      `ptImpact ptImpact-${item.impactLevel}`
                    }
                  >
                    {item.verdict}
                  </div>
                </div>

                <div className="ptRates">
                  <div>
                    <ArrowDown
                      size={13}
                    />

                    <span>
                      DOWNLOAD
                    </span>

                    <strong>
                      {mbps(
                        item.rxMbps
                      )}
                    </strong>
                  </div>

                  <div>
                    <ArrowUp
                      size={13}
                    />

                    <span>
                      UPLOAD
                    </span>

                    <strong>
                      {mbps(
                        item.txMbps
                      )}
                    </strong>
                  </div>

                  <div>
                    <Zap
                      size={13}
                    />

                    <span>
                      SHARE
                    </span>

                    <strong>
                      {item
                        .bandwidthSharePct
                        .toFixed(
                          1
                        )}
                      %
                    </strong>
                  </div>
                </div>

                <div className="ptProtocols">
                  <span>
                    TCP ↓{" "}
                    {mbps(
                      item
                        .tcpRxMbps
                    )}
                  </span>

                  <span>
                    TCP ↑{" "}
                    {mbps(
                      item
                        .tcpTxMbps
                    )}
                  </span>

                  <span>
                    UDP ↓{" "}
                    {mbps(
                      item
                        .udpRxMbps
                    )}
                  </span>

                  <span>
                    UDP ↑{" "}
                    {mbps(
                      item
                        .udpTxMbps
                    )}
                  </span>
                </div>

                <div className="ptTotals">
                  Session traffic:

                  <strong>
                    ↓{" "}
                    {bytes(
                      item.rxTotal
                    )}
                  </strong>

                  <strong>
                    ↑{" "}
                    {bytes(
                      item.txTotal
                    )}
                  </strong>
                </div>

                <div className="ptAssessment">
                  <div>
                    <span>
                      NETWORK IMPACT
                    </span>

                    <strong>
                      {item
                        .impactLevel
                        .toUpperCase()}
                    </strong>
                  </div>

                  <p>
                    {item.reason}
                  </p>
                </div>

                {item.canEnd && (
                  <button
                    className="ptEndButton"
                    disabled={
                      actionPid ===
                      item.pid
                    }
                    onClick={() =>
                      endAndMeasure(
                        item
                      )
                    }
                  >
                    <Square
                      size={12}
                    />

                    {actionPid ===
                    item.pid
                      ? "MEASURING..."
                      : "END & MEASURE IMPACT"}
                  </button>
                )}
              </article>
            )
          )
        ) : (
          <div className="ptEmpty">
            Waiting for network traffic...
          </div>
        )}
      </div>

      <div className="ptFootnote">
        Impact recommendations are based
        on current bandwidth share plus
        measured ping, jitter and packet
        loss. "Likely to help" is a
        diagnosis, not a guarantee.
        END & MEASURE performs an actual
        before/after test.
      </div>
    </section>
  );
}
