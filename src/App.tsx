import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  CircleUserRound,
  Clock3,
  CreditCard,
  Gamepad2,
  Gauge,
  Globe2,
  Lock,
  LogOut,
  Mail,
  Network,
  Power,
  Radio,
  RefreshCw,
  Server,
  Settings,
  Shield,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  UserPlus,
  Wifi,
  X,
  Zap,
} from "lucide-react";
import "./App.css";
import NetworkDoctor from "./NetworkDoctor";
import SplitTunnel from "./SplitTunnel";
import DeviceReportingSettings from "./DeviceReportingSettings";
import {
  nativeAvailable,
  nativeDiagnostic,
} from "./native";

type Page =
  | "dashboard"
  | "servers"
  | "game-test"
  | "network"
  | "network-doctor"
  | "split-tunnel"
  | "subscription"
  | "settings";

type ConnectionState = "idle" | "connecting" | "connected";

type ModalType = null | "forgot" | "register" | "buy";

type ServerInfo = {
  id: string;
  name: string;
  country: string;
  city: string;
  flag: string;
  countryCode: string;
  load: number;
  protocol: "WireGuard" | "AmneziaWG";
};

type ServerResult = {
  ping: number;
  jitter: number;
  packetLoss: number;
  testedAt: number;
  method?: "ICMP" | "TCP";
  tcpLatency?: number | null;
};

type Plan = {
  id: string;
  name: string;
  days: number;
  traffic: number;
  devices: number;
  price: string;
  recommended?: boolean;
};

type AppSettings = {
  autoConnect: boolean;
  killSwitch: boolean;
  dnsProtection: boolean;
  notifications: boolean;
  protocol: "Automatic" | "WireGuard" | "AmneziaWG";
};

const SERVERS: ServerInfo[] = [
  {
    id: "de-01",
    name: "Germany #01",
    country: "Germany",
    city: "Frankfurt",
    flag: "🇩🇪",
    countryCode: "de",
    load: 31,
    protocol: "WireGuard",
  },
  {
    id: "de-02",
    name: "Germany #02",
    country: "Germany",
    city: "Frankfurt",
    flag: "🇩🇪",
    countryCode: "de",
    load: 48,
    protocol: "AmneziaWG",
  },
  {
    id: "nl-01",
    name: "Netherlands #01",
    country: "Netherlands",
    city: "Amsterdam",
    flag: "🇳🇱",
    countryCode: "nl",
    load: 22,
    protocol: "WireGuard",
  },
  {
    id: "tr-01",
    name: "Türkiye #01",
    country: "Türkiye",
    city: "Istanbul",
    flag: "🇹🇷",
    countryCode: "tr",
    load: 17,
    protocol: "WireGuard",
  },
  {
    id: "fi-01",
    name: "Finland #01",
    country: "Finland",
    city: "Helsinki",
    flag: "🇫🇮",
    countryCode: "fi",
    load: 12,
    protocol: "AmneziaWG",
  },
  {
    id: "fr-01",
    name: "France #01",
    country: "France",
    city: "Paris",
    flag: "🇫🇷",
    countryCode: "fr",
    load: 39,
    protocol: "WireGuard",
  },
];

const PLANS: Plan[] = [
  {
    id: "starter",
    name: "Starter",
    days: 30,
    traffic: 50,
    devices: 1,
    price: "$2.99",
  },
  {
    id: "gamer-plus",
    name: "Gamer Plus",
    days: 30,
    traffic: 100,
    devices: 3,
    price: "$4.99",
    recommended: true,
  },
  {
    id: "pro",
    name: "Pro",
    days: 30,
    traffic: 300,
    devices: 5,
    price: "$7.99",
  },
];


function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function seed(value: string) {
  return value.split("").reduce((total, char) => total + char.charCodeAt(0), 0);
}

function makeResult(server: ServerInfo): ServerResult {
  const value = seed(server.id);

  return {
    ping: 32 + (value % 54) + Math.floor(server.load / 8),
    jitter: Number((1.2 + (value % 24) / 10).toFixed(1)),
    packetLoss: value % 7 === 0 ? 0.4 : 0,
    testedAt: Date.now(),
  };
}

function Modal({
  type,
  onClose,
  onToast,
}: {
  type: ModalType;
  onClose: () => void;
  onToast: (message: string) => void;
}) {
  if (!type) return null;

  const content = {
    forgot: {
      icon: <Mail size={27} />,
      title: "Reset password",
      text: "Enter your account email. Backend email delivery will be connected later.",
      button: "SEND RESET LINK",
    },
    register: {
      icon: <UserPlus size={27} />,
      title: "Create account",
      text: "Account registration flow is ready for API integration.",
      button: "CREATE ACCOUNT",
    },
    buy: {
      icon: <ShoppingBag size={27} />,
      title: "Buy subscription",
      text: "Choose a plan from the Subscription page.",
      button: "VIEW PLANS",
    },
  }[type];

  return (
    <div className="modalOverlay" onMouseDown={onClose}>
      <div className="modalCard" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modalClose" onClick={onClose}>
          <X size={18} />
        </button>

        <div className="modalIcon">{content.icon}</div>

        <h2>{content.title}</h2>
        <p>{content.text}</p>

        {(type === "forgot" || type === "register") && (
          <input
            className="modalInput"
            placeholder={type === "forgot" ? "email@example.com" : "Username"}
          />
        )}

        <button
          className="primaryAction"
          onClick={() => {
            onToast(
              type === "forgot"
                ? "Reset request button works."
                : type === "register"
                  ? "Registration button works."
                  : "Opening plans works."
            );
            onClose();
          }}
        >
          {content.button}
        </button>
      </div>
    </div>
  );
}

function Login({
  onLogin,
  onModal,
}: {
  onLogin: () => void;
  onModal: (modal: ModalType) => void;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [identifier, setIdentifier] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;

    setLoading(true);
    setError("");

    const submittedPassword = password;
    setPassword("");

    try {
      const auth = window.hoax?.auth;
      if (!auth) {
        setError("Authentication is available only in the HoaxConnect desktop app.");
        return;
      }

      const result =
        mode === "login"
          ? await auth.login({
              identifier: identifier.trim(),
              password: submittedPassword,
            })
          : await auth.register({
              email: email.trim(),
              phone: phone.trim(),
              username: username.trim(),
              password: submittedPassword,
            });

      if (!result.ok) {
        setError(result.error.message);
        return;
      }

      if (result.state.status !== "authenticated") {
        setError("Authentication could not be completed. Please try again.");
        return;
      }

      onLogin();
    } catch {
      setError("Authentication could not be completed. Please try again.");
    } finally {
      setPassword("");
      setLoading(false);
    }
  }

  function switchMode(next: "login" | "register") {
    setMode(next);
    setError("");
    setPassword("");
  }

  return (
    <main className="loginPage">
      <div className="ambient ambientOne" />
      <div className="ambient ambientTwo" />

      <section className="loginVisual">
        <div className="brand brandLarge">
          <div className="brandIcon">
            <Zap size={25} strokeWidth={2.5} />
          </div>
          <div>
            <strong>HOAXCONNECT</strong>
            <span>GAMING NETWORK</span>
          </div>
        </div>

        <div className="heroCopy">
          <div className="pill">
            <Sparkles size={15} />
            SMART GAMING ROUTES
          </div>
          <h1>
            Play faster.
            <br />
            Route smarter.
          </h1>
          <p>
            Smart routing, low-latency gaming nodes and one-click secure
            connections.
          </p>
        </div>

        <div className="loginStats">
          <div><Gauge /><span>LOW LATENCY</span></div>
          <div><Network /><span>SMART ROUTING</span></div>
          <div><ShieldCheck /><span>SECURE</span></div>
        </div>
      </section>

      <section className="loginPanel">
        <form className="loginCard" onSubmit={submit}>
          <div className="loginHeader">
            <span className="eyebrow">
              {mode === "login" ? "WELCOME BACK" : "NEW ACCOUNT"}
            </span>
            <h2>
              {mode === "login"
                ? "Sign in to HoaxConnect"
                : "Create your account"}
            </h2>
            <p>
              {mode === "login"
                ? "Sign in securely with your account and this device."
                : "Your phone number is not verified until phone verification is available."}
            </p>
          </div>

          {mode === "login" ? (
            <label className="inputGroup">
              <span>USERNAME OR EMAIL</span>
              <input
                autoComplete="username"
                value={identifier}
                onChange={(event) => setIdentifier(event.target.value)}
                required
                minLength={3}
                maxLength={320}
              />
            </label>
          ) : (
            <>
              <label className="inputGroup">
                <span>EMAIL</span>
                <input
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  maxLength={320}
                />
              </label>
              <label className="inputGroup">
                <span>PHONE NUMBER</span>
                <input
                  type="tel"
                  autoComplete="tel"
                  placeholder="+12025550123"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  required
                  pattern="\+[1-9][0-9]{7,14}"
                  title="Enter the number in international E.164 format."
                />
              </label>
              <label className="inputGroup">
                <span>USERNAME</span>
                <input
                  autoComplete="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  required
                  minLength={3}
                  maxLength={64}
                  pattern="[A-Za-z0-9_.\-]+"
                />
              </label>
            </>
          )}

          <label className="inputGroup">
            <span>PASSWORD</span>
            <input
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              minLength={mode === "login" ? 1 : 12}
              maxLength={128}
            />
          </label>

          {error && (
            <p className="authError" role="alert">
              {error}
            </p>
          )}

          {mode === "login" && (
            <div className="formOptions">
              <span />
              <button
                type="button"
                className="linkButton"
                onClick={() => onModal("forgot")}
                disabled={loading}
              >
                Forgot password?
              </button>
            </div>
          )}

          <button className="loginButton" disabled={loading}>
            {loading
              ? mode === "login" ? "SIGNING IN..." : "CREATING ACCOUNT..."
              : mode === "login" ? "SIGN IN" : "CREATE ACCOUNT"}
            {!loading && <ChevronRight size={19} />}
          </button>

          <p className="loginFooter">
            {mode === "login"
              ? "Don't have an account? "
              : "Already have an account? "}
            <button
              type="button"
              disabled={loading}
              onClick={() =>
                switchMode(mode === "login" ? "register" : "login")
              }
            >
              {mode === "login" ? "Create one" : "Sign in"}
            </button>
          </p>
        </form>
      </section>
    </main>
  );
}

export default function App() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [authChecking, setAuthChecking] = useState(
    Boolean(window.hoax?.auth)
  );
  const [page, setPage] = useState<Page>("dashboard");
  const [modal, setModal] = useState<ModalType>(null);
  const [toast, setToast] = useState("");
  const [logoutBusy, setLogoutBusy] = useState(false);

  async function performSignOut(allDevices: boolean) {
    if (logoutBusy) return;

    const auth = window.hoax?.auth;
    if (!auth) {
      setLoggedIn(false);
      setConnection("idle");
      notify("Logged out on this device.");
      return;
    }

    setLogoutBusy(true);
    try {
      const result = allDevices
        ? await auth.logoutAll()
        : await auth.logout();

      if (!result.ok) {
        notify(result.error.message);
        return;
      }

      setLoggedIn(false);
      setConnection("idle");

      if (result.remoteRevoked) {
        notify(
          allDevices
            ? "Signed out on all devices."
            : "Signed out on this device."
        );
      } else {
        notify(
          "Signed out here, but the Backend could not confirm session revocation."
        );
      }
    } catch {
      notify("Sign-out could not be completed. Please try again.");
    } finally {
      setLogoutBusy(false);
    }
  }

  useEffect(() => {
    const auth = window.hoax?.auth;
    if (!auth) return;
    const authApi = auth;

    let cancelled = false;

    async function restoreSession() {
      try {
        const current = await authApi.getState();
        if (!current.ok || cancelled) return;

        if (current.state.status === "restore_required") {
          const restored = await authApi.restore();
          if (
            restored.ok &&
            restored.state.status === "authenticated" &&
            !cancelled
          ) {
            setLoggedIn(true);
          }
        } else if (
          current.state.status === "authenticated" &&
          !cancelled
        ) {
          setLoggedIn(true);
        }
      } finally {
        if (!cancelled) setAuthChecking(false);
      }
    }

    void restoreSession().catch(() => {
      if (!cancelled) setAuthChecking(false);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const [selectedServerId, setSelectedServerId] = useState(SERVERS[0].id);
  const [results, setResults] = useState<Record<string, ServerResult>>({});
  const [testingServer, setTestingServer] = useState<string | null>(null);
  const [testingAll, setTestingAll] = useState(false);

  const [connection, setConnection] =
    useState<ConnectionState>("idle");

  const [download, setDownload] = useState(0);
  const [upload, setUpload] = useState(0);

  const [gameScanning, setGameScanning] = useState(false);

  const [gameScan, setGameScan] =
    useState<HoaxGameScanResult | null>(null);

  const [networkTesting, setNetworkTesting] = useState(false);
  const [networkProgress, setNetworkProgress] = useState(0);
  const [networkResult, setNetworkResult] = useState<null | {
    ping: number | null;
    jitter: number;
    packetLoss: number;

    publicIp: string | null;
    dnsServers: string[];
    target: string;
  }>(null);

  const [activePlan, setActivePlan] = useState(PLANS[1]);

  const [settings, setSettings] = useState<AppSettings>({
    autoConnect: false,
    killSwitch: true,
    dnsProtection: true,
    notifications: true,
    protocol: "Automatic",
  });

  const selectedServer = useMemo(
    () => SERVERS.find((server) => server.id === selectedServerId) ?? SERVERS[0],
    [selectedServerId]
  );

  const selectedResult = results[selectedServer.id];

  function notify(message: string) {
    setToast(message);
  }

  useEffect(() => {
    if (!toast) return;

    const timeout = window.setTimeout(() => setToast(""), 2400);

    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    if (connection !== "connected") return;

    const interval = window.setInterval(() => {
      setDownload((old) => Number((old + 0.013).toFixed(3)));
      setUpload((old) => Number((old + 0.003).toFixed(3)));
    }, 1000);

    return () => window.clearInterval(interval);
  }, [connection]);

  useEffect(() => {
    if (
      !loggedIn ||
      page !== "game-test" ||
      !window.hoax?.game
    ) {
      return;
    }

    let disposed = false;
    let busy = false;

    async function pollGame() {
      if (busy || disposed) {
        return;
      }

      busy = true;
      setGameScanning(true);

      try {
        const result =
          await window.hoax!.game.scan();

        if (!disposed) {
          setGameScan(result);
        }
      } catch {
        // Silent background polling.
      } finally {
        busy = false;

        if (!disposed) {
          setGameScanning(false);
        }
      }
    }

    pollGame();

    const timer =
      window.setInterval(
        pollGame,
        15000
      );

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [loggedIn, page]);

  async function testServer(server: ServerInfo) {
    setTestingServer(server.id);

    await sleep(650);

    const result = makeResult(server);

    setResults((old) => ({
      ...old,
      [server.id]: result,
    }));

    setTestingServer(null);

    return result;
  }

  async function testAllServers() {
    setTestingAll(true);

    const next: Record<string, ServerResult> = {};

    for (const server of SERVERS) {
      setTestingServer(server.id);
      await sleep(280);
      next[server.id] = makeResult(server);
    }

    setResults(next);
    setTestingServer(null);
    setTestingAll(false);
    notify("All server routes tested.");
  }

  async function autoSelect() {
    setTestingAll(true);

    const next: Record<string, ServerResult> = {};

    for (const server of SERVERS) {
      setTestingServer(server.id);
      await sleep(240);
      next[server.id] = makeResult(server);
    }

    setResults(next);

    const best = [...SERVERS].sort((a, b) => {
      const scoreA =
        next[a.id].ping +
        next[a.id].jitter * 3 +
        next[a.id].packetLoss * 20 +
        a.load * 0.15;

      const scoreB =
        next[b.id].ping +
        next[b.id].jitter * 3 +
        next[b.id].packetLoss * 20 +
        b.load * 0.15;

      return scoreA - scoreB;
    })[0];

    setSelectedServerId(best.id);
    setTestingServer(null);
    setTestingAll(false);

    notify(`Best route selected: ${best.name}`);
  }

  async function toggleConnection() {
    if (connection === "connected") {
      setConnection("idle");
      setDownload(0);
      setUpload(0);
      notify("Disconnected.");
      return;
    }

    if (connection === "connecting") return;

    setConnection("connecting");

    if (!results[selectedServer.id]) {
      await testServer(selectedServer);
    }

    await sleep(700);

    setConnection("connected");
    notify(`Connected to ${selectedServer.name}`);
  }

  async function scanGameNow(
    silent = false
  ) {
    if (!window.hoax?.game) {
      if (!silent) {
        notify(
          "Automatic Game Detection only works inside the HoaxConnect desktop app."
        );
      }

      return;
    }

    setGameScanning(true);

    try {
      const result =
        await window.hoax.game.scan();

      setGameScan(result);

      if (!silent) {
        if (!result.detected) {
          notify(
            "No supported running game was detected."
          );
        } else if (!result.server) {
          notify(
            `${result.game?.name || "Game"} detected. Join a match so HoaxConnect can identify the game server.`
          );
        } else {
          notify(
            `${result.game?.name || "Game"} server detected automatically.`
          );
        }
      }
    } catch (error) {
      if (!silent) {
        notify(
          error instanceof Error
            ? error.message
            : String(error)
        );
      }
    } finally {
      setGameScanning(false);
    }
  }

  async function runNetworkTest() {
    if (!nativeAvailable()) {
      notify(
        "Real Network Test only works inside the HoaxConnect desktop app."
      );
      return;
    }

    setNetworkTesting(true);
    setNetworkResult(null);
    setNetworkProgress(10);

    try {
      await sleep(150);
      setNetworkProgress(30);

      const result =
        await nativeDiagnostic(
          "1.1.1.1"
        );

      setNetworkProgress(85);

      await sleep(200);

      setNetworkResult({
        ping:
          result.ping.averageMs,

        jitter:
          result.ping.jitterMs,

        packetLoss:
          result.ping.packetLossPct,

        publicIp:
          result.publicIp,

        dnsServers:
          result.dnsServers,

        target:
          result.target,
      });

      setNetworkProgress(100);

      notify(
        "Real network diagnostics completed."
      );
    } catch (error) {
      notify(
        error instanceof Error
          ? error.message
          : String(error)
      );
    } finally {
      setNetworkTesting(false);
    }
  }

  function Sidebar() {
    const nav = [
      ["dashboard", "Dashboard", <Gauge size={19} />],
      ["servers", "Servers", <Server size={19} />],
      ["game-test", "Game Test", <Gamepad2 size={19} />],
      ["network", "Network Test", <Activity size={19} />],
      ["network-doctor", "Network Doctor", <Activity size={19} />],
      ["split-tunnel", "Split Tunnel", <Network size={19} />],
    ] as const;

    return (
      <aside className="sidebar">
        <div className="brand">
          <div className="brandIcon">
            <Zap size={21} strokeWidth={2.6} />
          </div>

          <div>
            <strong>HOAXCONNECT</strong>
            <span>GAMING NETWORK</span>
          </div>
        </div>

        <div className="sidebarLabel">MAIN</div>

        <nav>
          {nav.map(([id, label, icon]) => (
            <button
              key={id}
              className={page === id ? "navActive" : ""}
              onClick={() => setPage(id)}
            >
              {icon}
              {label}
            </button>
          ))}
        </nav>

        <div className="sidebarLabel sidebarSecond">ACCOUNT</div>

        <nav>
          <button
            className={page === "subscription" ? "navActive" : ""}
            onClick={() => setPage("subscription")}
          >
            <ShoppingBag size={19} />
            Subscription
          </button>

          <button
            className={page === "settings" ? "navActive" : ""}
            onClick={() => setPage("settings")}
          >
            <Settings size={19} />
            Settings
          </button>
        </nav>

        <div className="sidePlan">
          <div className="planTop">
            <span>{activePlan.name.toUpperCase()}</span>
            <Zap size={15} />
          </div>

          <strong>24 days left</strong>

          <div className="miniProgress">
            <span />
          </div>

          <small>37.4 GB of {activePlan.traffic} GB used</small>

          <button onClick={() => setPage("subscription")}>
            MANAGE PLAN
          </button>
        </div>

        <div className="profile">
          <div className="avatar">
            <CircleUserRound size={22} />
          </div>

          <div className="profileText">
            <strong>Demo Gamer</strong>
            <span>Online</span>
          </div>

          <button
            type="button"
            aria-label="Sign out on this device"
            title="Sign out on this device"
            disabled={logoutBusy}
            onClick={() => void performSignOut(false)}
          >
            <LogOut size={17} />
          </button>

          <button
            type="button"
            aria-label="Sign out on all devices"
            title="Sign out on all devices"
            disabled={logoutBusy}
            onClick={() => {
              if (
                window.confirm(
                  "Sign out on all devices? This will revoke every active session."
                )
              ) {
                void performSignOut(true);
              }
            }}
          >
            <LogOut size={17} />
          </button>
        </div>
      </aside>
    );
  }

  function PageHeader({
    eyebrow,
    title,
  }: {
    eyebrow: string;
    title: string;
  }) {
    return (
      <header className="topbar">
        <div>
          <span className="eyebrow">{eyebrow}</span>
          <h1>{title}</h1>
        </div>

        <div className="networkOnline">
          <span className="onlineDot" />
          HOAX NETWORK ONLINE
        </div>
      </header>
    );
  }

  function Dashboard() {
    return (
      <>
        <PageHeader eyebrow="CONTROL CENTER" title="Good afternoon." />

        <section className="heroGrid">
          <article className="connectPanel">
            <div className="connectionState">
              <span
                className={
                  connection === "connected" ? "greenDot" : "grayDot"
                }
              />

              {connection === "connected"
                ? "CONNECTION SECURED"
                : connection === "connecting"
                  ? "CONNECTING..."
                  : "READY TO CONNECT"}
            </div>

            <button
              className={`powerButton ${
                connection === "connected" ? "powerOn" : ""
              }`}
              onClick={toggleConnection}
            >
              <span className="powerHalo haloOne" />
              <span className="powerHalo haloTwo" />

              <div>
                {connection === "connecting" ? (
                  <RefreshCw className="spin" size={41} />
                ) : (
                  <Power size={41} strokeWidth={1.8} />
                )}
              </div>
            </button>

            <h2>
              {connection === "connected"
                ? "Connected"
                : connection === "connecting"
                  ? "Connecting..."
                  : "Not connected"}
            </h2>

            <p>
              {connection === "connected"
                ? `Protected through ${selectedServer.name}`
                : "Select a route and connect to HoaxConnect."}
            </p>

            <button
              className="smartButton"
              onClick={autoSelect}
              disabled={testingAll}
            >
              {testingAll ? (
                <RefreshCw className="spin" size={18} />
              ) : (
                <Sparkles size={18} />
              )}

              {testingAll
                ? "TESTING ROUTES..."
                : "AUTO SELECT BEST ROUTE"}
            </button>
          </article>

          <article className="routePanel">
            <div className="cardHeader">
              <div>
                <span className="eyebrow">CURRENT ROUTE</span>
                <h2>{selectedServer.name}</h2>
              </div>

              <span className="protocolBadge">
                {selectedServer.protocol}
              </span>
            </div>

            <div className="routeVisual">
              <div className="routePoint">
                <div className="routeIcon">
                  <CircleUserRound size={22} />
                </div>

                <span>YOU</span>
                <strong>My Device</strong>
              </div>

              <div className="routeConnector">
                <span />
                <span className="routePulse" />
              </div>

              <div className="routePoint routeCenter">
                <div className="routeIcon activeRoute">
                  <Zap size={22} />
                </div>

                <span>HOAXCONNECT</span>
                <strong>{selectedServer.city}</strong>
              </div>

              <div className="routeConnector">
                <span />
              </div>

              <div className="routePoint">
                <div className="routeIcon">
                  <Gamepad2 size={22} />
                </div>

                <span>DESTINATION</span>
                <strong>Gaming Network</strong>
              </div>
            </div>

            <div className="metrics">
              <div>
                <span>
                  <Radio size={15} />
                  PING
                </span>

                <strong>
                  {selectedResult?.ping ?? "--"} <small>ms</small>
                </strong>
              </div>

              <div>
                <span>
                  <Activity size={15} />
                  JITTER
                </span>

                <strong>
                  {selectedResult?.jitter ?? "--"} <small>ms</small>
                </strong>
              </div>

              <div>
                <span>
                  <Wifi size={15} />
                  PACKET LOSS
                </span>

                <strong>
                  {selectedResult?.packetLoss ?? "--"} <small>%</small>
                </strong>
              </div>
            </div>
          </article>
        </section>

        <section className="lowerGrid">
          <article className="serverCard">
            <div className="cardHeader">
              <div>
                <span className="eyebrow">SMART ROUTING</span>
                <h2>Recommended servers</h2>
              </div>

              <button
                className="textAction"
                onClick={() => setPage("servers")}
              >
                VIEW ALL
              </button>
            </div>

            <div className="serverTable">
              {SERVERS.slice(0, 4).map((server) => {
                const result = results[server.id];

                return (
                  <button
                    key={server.id}
                    className={`serverRow ${
                      selectedServer.id === server.id
                        ? "serverSelected"
                        : ""
                    }`}
                    onClick={() => {
                      setSelectedServerId(server.id);
                      notify(`${server.name} selected.`);
                    }}
                  >
                    <div className="serverIdentity">
                      <span
  className={`fi fi-${server.countryCode} flagIcon`}
  aria-label={server.country}
/>

                      <div>
                        <strong>{server.name}</strong>
                        <span>{server.city}</span>
                      </div>
                    </div>

                    <div className="serverMeta">
                      <span>LOAD</span>
                      <strong>{server.load}%</strong>
                    </div>

                    <div className="serverMeta pingMeta">
                      <span>PING</span>
                      <strong>
                        {testingServer === server.id
                          ? "..."
                          : result
                            ? `${result.ping} ms`
                            : "--"}
                      </strong>
                    </div>

                    <ChevronRight size={18} />
                  </button>
                );
              })}
            </div>
          </article>

          <article className="sideStats">
            <div className="cardHeader">
              <div>
                <span className="eyebrow">THIS SESSION</span>
                <h2>Traffic</h2>
              </div>

              <Clock3 size={20} />
            </div>

            <div className="trafficStat">
              <div className="trafficIcon download">
                <ArrowDown size={21} />
              </div>

              <div>
                <span>DOWNLOAD</span>
                <strong>{download.toFixed(3)} GB</strong>
              </div>
            </div>

            <div className="trafficStat">
              <div className="trafficIcon upload">
                <ArrowUp size={21} />
              </div>

              <div>
                <span>UPLOAD</span>
                <strong>{upload.toFixed(3)} GB</strong>
              </div>
            </div>

            <div className="ipBox">
              <div>
                <Globe2 size={17} />
                <span>PUBLIC IP</span>
              </div>

              <strong>
                {connection === "connected"
                  ? "VPN IP — backend pending"
                  : "Not connected"}
              </strong>
            </div>
          </article>
        </section>
      </>
    );
  }

  function ServersPage() {
    return (
      <>
        <PageHeader eyebrow="ROUTE MANAGER" title="Servers" />

        <div className="pageToolbar">
          <div>
            <strong>{SERVERS.length} available routes</strong>
            <span>UI Test Mode — real node API comes next.</span>
          </div>

          <button
            className="secondaryAction"
            onClick={testAllServers}
            disabled={testingAll}
          >
            <RefreshCw
              size={16}
              className={testingAll ? "spin" : ""}
            />
            TEST ALL
          </button>
        </div>

        <div className="fullServerList">
          {SERVERS.map((server) => {
            const result = results[server.id];

            return (
              <article
                className={`fullServerCard ${
                  selectedServer.id === server.id
                    ? "fullServerSelected"
                    : ""
                }`}
                key={server.id}
              >
                <button
                  className="fullServerMain"
                  onClick={() => setSelectedServerId(server.id)}
                >
                  <span
  className={`fi fi-${server.countryCode} serverBigFlag`}
  aria-label={server.country}
/>

                  <div>
                    <strong>{server.name}</strong>
                    <span>
                      {server.city}, {server.country}
                    </span>
                  </div>
                </button>

                <div className="serverData">
                  <span>PROTOCOL</span>
                  <strong>{server.protocol}</strong>
                </div>

                <div className="serverData">
                  <span>LOAD</span>
                  <strong>{server.load}%</strong>
                </div>

                <div className="serverData">
                  <span>PING</span>
                  <strong>
                    {testingServer === server.id
                      ? "Testing..."
                      : result
                        ? `${result.ping} ms`
                        : "--"}
                  </strong>
                </div>

                <button
                  className="testRouteButton"
                  onClick={() => testServer(server)}
                >
                  TEST
                </button>

                <button
                  className="routeSelectButton"
                  onClick={() => {
                    setSelectedServerId(server.id);
                    notify(`${server.name} selected.`);
                  }}
                >
                  {selectedServer.id === server.id ? (
                    <>
                      <Check size={15} />
                      SELECTED
                    </>
                  ) : (
                    "SELECT"
                  )}
                </button>
              </article>
            );
          })}
        </div>
      </>
    );
  }

  function GameTestPage() {
    const desktopAvailable =
      Boolean(window.hoax?.game);

    const detectedGame =
      gameScan?.game;

    const detectedServer =
      gameScan?.server;

    const measurement =
      gameScan?.measurement;

    return (
      <>
        <PageHeader
          eyebrow="AUTO GAME DETECTION"
          title="Game Test"
        />

        <div className="testLayout">
          <article className="genericCard">
            <span className="eyebrow">
              LIVE DETECTION
            </span>

            <h2>
              Automatic game scanner
            </h2>

            {!desktopAvailable ? (
              <div className="autoGameEmpty">
                <Gamepad2 size={48} />

                <strong>
                  Desktop app required
                </strong>

                <span>
                  Game process and server detection runs locally
                  inside HoaxConnect for Windows.
                </span>
              </div>
            ) : gameScanning && !gameScan ? (
              <div className="autoGameEmpty">
                <RefreshCw
                  className="spin"
                  size={48}
                />

                <strong>
                  Looking for a game...
                </strong>

                <span>
                  Scanning Windows processes and network flows.
                </span>
              </div>
            ) : !gameScan?.detected ? (
              <div className="autoGameEmpty">
                <Gamepad2 size={48} />

                <strong>
                  No supported game detected
                </strong>

                <span>
                  Open a supported game and HoaxConnect will
                  detect it automatically.
                </span>
              </div>
            ) : (
              <>
                <div className="detectedGameBox">
                  <div className="gameDetectedIcon">
                    <Gamepad2 size={26} />
                  </div>

                  <div>
                    <span>
                      GAME DETECTED
                    </span>

                    <strong>
                      {detectedGame?.name}
                    </strong>

                    <small>
                      {detectedGame?.processes
                        .map(
                          (processInfo) =>
                            `${processInfo.name} · PID ${processInfo.pid}`
                        )
                        .join(" / ")}
                    </small>
                  </div>
                </div>

                {!detectedServer ? (
                  <div className="waitingTrafficBox">
                    <Activity
                      className={
                        gameScanning
                          ? "spin"
                          : ""
                      }
                      size={21}
                    />

                    <div>
                      <strong>
                        Waiting for active match traffic
                      </strong>

                      <span>
                        Join a match. HoaxConnect will identify
                        the remote game server automatically.
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="detectedServerBox">
                    <div className="detectedServerHeader">
                      <div>
                        <span>
                          ACTIVE GAME SERVER
                        </span>

                        <strong>
                          {detectedServer.ip}
                        </strong>
                      </div>

                      <div className="serverProtocolPill">
                        {detectedServer.protocol}
                      </div>
                    </div>

                    <div className="detectedServerMeta">
                      <div>
                        <span>PORT</span>
                        <strong>
                          {detectedServer.port}
                        </strong>
                      </div>

                      <div>
                        <span>CONFIDENCE</span>
                        <strong>
                          {detectedServer.confidence.toUpperCase()}
                        </strong>
                      </div>

                      <div>
                        <span>SOURCE</span>
                        <strong>
                          {detectedServer.source}
                        </strong>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}

            <button
              className="primaryAction"
              onClick={() =>
                scanGameNow(false)
              }
              disabled={
                gameScanning ||
                !desktopAvailable
              }
            >
              <RefreshCw
                className={
                  gameScanning
                    ? "spin"
                    : ""
                }
                size={17}
              />

              {gameScanning
                ? "SCANNING..."
                : "SCAN NOW"}
            </button>

            <div className="nativeHint">
              No IP entry is required. HoaxConnect detects
              the game process and its active network server.
            </div>
          </article>

          <article className="genericCard resultCard">
            <span className="eyebrow">
              LIVE ROUTE
            </span>

            <h2>
              {detectedGame?.name ||
                "Game connection"}
            </h2>

            {!detectedServer ? (
              <div className="emptyTest">
                <Network size={44} />

                <strong>
                  No game server yet
                </strong>

                <span>
                  Launch a game and enter an online match.
                </span>
              </div>
            ) : (
              <>
                <div className="resultMetrics">
                  <div>
                    <span>
                      SERVER IP
                    </span>

                    <strong>
                      {detectedServer.ip}
                    </strong>
                  </div>

                  <div>
                    <span>
                      LATENCY
                    </span>

                    <strong>
                      {measurement?.latencyMs !== null &&
                      measurement?.latencyMs !== undefined
                        ? `${measurement.latencyMs} ms`
                        : "ICMP blocked"}
                    </strong>
                  </div>

                  <div>
                    <span>
                      JITTER
                    </span>

                    <strong>
                      {measurement?.jitterMs !== null &&
                      measurement?.jitterMs !== undefined
                        ? `${measurement.jitterMs} ms`
                        : "Unavailable"}
                    </strong>
                  </div>

                  <div>
                    <span>
                      PACKET LOSS
                    </span>

                    <strong>
                      {measurement?.packetLossPct !== null &&
                      measurement?.packetLossPct !== undefined
                        ? `${measurement.packetLossPct}%`
                        : "Unavailable"}
                    </strong>
                  </div>

                  <div className="qualityGood">
                    <ShieldCheck size={22} />

                    <div>
                      <span>
                        DETECTION METHOD
                      </span>

                      <strong>
                        {measurement?.method ||
                          detectedServer.source}
                      </strong>
                    </div>
                  </div>
                </div>

                {gameScan?.candidates?.length > 1 && (
                  <div className="candidateList">
                    <span className="candidateTitle">
                      OTHER ACTIVE GAME ENDPOINTS
                    </span>

                    {gameScan.candidates
                      .slice(1, 5)
                      .map(
                        (candidate) => (
                          <div
                            key={`${candidate.protocol}-${candidate.ip}-${candidate.port}`}
                            className="candidateRow"
                          >
                            <strong>
                              {candidate.ip}:{candidate.port}
                            </strong>

                            <span>
                              {candidate.protocol}
                            </span>
                          </div>
                        )
                      )}
                  </div>
                )}

                {gameScan?.packetCapture?.attempted &&
                  !gameScan.packetCapture.ok && (
                    <div className="captureWarning">
                      UDP packet inspection could not start:
                      {" "}
                      {gameScan.packetCapture.error ||
                        "Administrator access required."}
                    </div>
                  )}
              </>
            )}
          </article>
        </div>
      </>
    );
  }

  function NetworkPage() {
    return (
      <>
        <PageHeader eyebrow="CONNECTION HEALTH" title="Network Test" />

        <div className="testLayout">
          <article className="genericCard">
            <span className="eyebrow">FULL DIAGNOSTIC</span>
            <h2>Test your connection</h2>

            <p className="mutedParagraph">
              This test runs locally on the Windows device through
              the HoaxConnect native Electron network engine.
            </p>

            <div className="diagnosticItems">
              <div>
                <Radio />
                Ping
              </div>

              <div>
                <Activity />
                Jitter
              </div>

              <div>
                <Wifi />
                Packet loss
              </div>

              <div>
                <ArrowDown />
                Download
              </div>

              <div>
                <ArrowUp />
                Upload
              </div>

              <div>
                <Shield />
                DNS / Leak checks
              </div>
            </div>

            {networkTesting && (
              <div className="testProgress">
                <span style={{ width: `${networkProgress}%` }} />
              </div>
            )}

            <button
              className="primaryAction"
              onClick={runNetworkTest}
              disabled={networkTesting}
            >
              <Activity size={17} />
              {networkTesting
                ? `RUNNING ${networkProgress}%`
                : "RUN NETWORK TEST"}
            </button>
          </article>

          <article className="genericCard resultCard">
            <span className="eyebrow">NETWORK QUALITY</span>
            <h2>Diagnostics</h2>

            {!networkResult ? (
              <div className="emptyTest">
                <Activity size={44} />
                <strong>Waiting for test</strong>
                <span>Your results will appear here.</span>
              </div>
            ) : (
              <div className="networkResults">
                <div>
                  <span>PING</span>
                  <strong>
                    {networkResult.ping !== null
                      ? `${networkResult.ping} ms`
                      : "No reply"}
                  </strong>
                </div>

                <div>
                  <span>JITTER</span>
                  <strong>{networkResult.jitter} ms</strong>
                </div>

                <div>
                  <span>LOSS</span>
                  <strong>{networkResult.packetLoss}%</strong>
                </div>

                <div>
                  <span>PUBLIC IP</span>

                  <strong>
                    {networkResult.publicIp || "Unavailable"}
                  </strong>
                </div>

                <div>
                  <span>DNS SERVERS</span>

                  <strong>
                    {networkResult.dnsServers.length
                      ? networkResult.dnsServers.join(", ")
                      : "Unavailable"}
                  </strong>
                </div>

                <div>
                  <span>TEST TARGET</span>

                  <strong className="goodText">
                    {networkResult.target}
                  </strong>
                </div>
              </div>
            )}
          </article>
        </div>
      </>
    );
  }

  function SubscriptionPage() {
    return (
      <>
        <PageHeader eyebrow="ACCOUNT" title="Subscription" />

        <article className="subscriptionSummary">
          <div>
            <span className="eyebrow">ACTIVE PLAN</span>
            <h2>{activePlan.name}</h2>
            <p>24 days remaining</p>
          </div>

          <div className="subscriptionValue">
            <span>TRAFFIC</span>
            <strong>
              37.4 / {activePlan.traffic} GB
            </strong>
          </div>

          <div className="subscriptionValue">
            <span>DEVICES</span>
            <strong>1 / {activePlan.devices}</strong>
          </div>
        </article>

        <div className="planGrid">
          {PLANS.map((plan) => (
            <article
              key={plan.id}
              className={`planOption ${
                activePlan.id === plan.id ? "activePlanCard" : ""
              }`}
            >
              {plan.recommended && (
                <div className="recommendedBadge">RECOMMENDED</div>
              )}

              <h2>{plan.name}</h2>
              <div className="price">{plan.price}</div>
              <span>/ 30 days</span>

              <div className="planFeatures">
                <div>
                  <Check size={15} />
                  {plan.traffic} GB traffic
                </div>

                <div>
                  <Check size={15} />
                  {plan.devices} device
                  {plan.devices > 1 ? "s" : ""}
                </div>

                <div>
                  <Check size={15} />
                  Gaming optimized routes
                </div>
              </div>

              <button
                className={
                  activePlan.id === plan.id
                    ? "secondaryAction"
                    : "primaryAction"
                }
                onClick={() => {
                  setActivePlan(plan);
                  notify(`${plan.name} selected in test mode.`);
                }}
              >
                <CreditCard size={16} />

                {activePlan.id === plan.id
                  ? "CURRENT PLAN"
                  : "SELECT PLAN"}
              </button>
            </article>
          ))}
        </div>
      </>
    );
  }

  function SettingsPage() {
    function Toggle({
      label,
      description,
      value,
      onChange,
    }: {
      label: string;
      description: string;
      value: boolean;
      onChange: (next: boolean) => void;
    }) {
      return (
        <div className="settingRow">
          <div>
            <strong>{label}</strong>
            <span>{description}</span>
          </div>

          <button
            className={`toggle ${value ? "toggleOn" : ""}`}
            onClick={() => onChange(!value)}
          >
            <span />
          </button>
        </div>
      );
    }

    return (
      <>
        <PageHeader eyebrow="PREFERENCES" title="Settings" />
        <DeviceReportingSettings />

        <div className="settingsGrid">
          <article className="genericCard">
            <span className="eyebrow">CONNECTION</span>
            <h2>VPN behaviour</h2>

            <Toggle
              label="Auto Connect"
              description="Connect automatically when HoaxConnect starts."
              value={settings.autoConnect}
              onChange={(value) =>
                setSettings((old) => ({
                  ...old,
                  autoConnect: value,
                }))
              }
            />

            <Toggle
              label="Kill Switch"
              description="Block traffic if VPN connection unexpectedly drops."
              value={settings.killSwitch}
              onChange={(value) =>
                setSettings((old) => ({
                  ...old,
                  killSwitch: value,
                }))
              }
            />

            <Toggle
              label="DNS Protection"
              description="Use HoaxConnect protected DNS while connected."
              value={settings.dnsProtection}
              onChange={(value) =>
                setSettings((old) => ({
                  ...old,
                  dnsProtection: value,
                }))
              }
            />

            <Toggle
              label="Notifications"
              description="Show connection and network status notifications."
              value={settings.notifications}
              onChange={(value) =>
                setSettings((old) => ({
                  ...old,
                  notifications: value,
                }))
              }
            />
          </article>

          <article className="genericCard">
            <span className="eyebrow">PROTOCOL</span>
            <h2>Connection engine</h2>

            <div className="protocolChoices">
              {(["Automatic", "WireGuard", "AmneziaWG"] as const).map(
                (protocol) => (
                  <button
                    key={protocol}
                    className={
                      settings.protocol === protocol
                        ? "protocolChoiceActive"
                        : ""
                    }
                    onClick={() =>
                      setSettings((old) => ({
                        ...old,
                        protocol,
                      }))
                    }
                  >
                    <Lock size={18} />

                    <div>
                      <strong>{protocol}</strong>
                      <span>
                        {protocol === "Automatic"
                          ? "Let HoaxConnect choose the best engine."
                          : `Force ${protocol} when available.`}
                      </span>
                    </div>
                  </button>
                )
              )}
            </div>

            <button
              className="primaryAction"
              onClick={() => notify("Settings saved in UI Test Mode.")}
            >
              <Check size={17} />
              SAVE SETTINGS
            </button>
          </article>
        </div>
      </>
    );
  }

  function renderPage() {
    switch (page) {
      case "servers":
        return <ServersPage />;

      case "game-test":
        return <GameTestPage />;

      case "network":
        return <NetworkPage />;

      case "split-tunnel":
        return (
          <>
            <PageHeader
              eyebrow="APPLICATION ROUTING"
              title="Split Tunnel"
            />

            <SplitTunnel />
          </>
        );

      case "network-doctor":
        return (
          <>
            <PageHeader
              eyebrow="CONNECTION ANALYSIS"
              title="Network Doctor"
            />

            <NetworkDoctor />
          </>
        );

      case "subscription":
        return <SubscriptionPage />;

      case "settings":
        return <SettingsPage />;

      default:
        return <Dashboard />;
    }
  }

  if (authChecking) {
    return (
      <main className="loginPage">
        <section className="loginPanel">
          <p role="status">Restoring your secure session...</p>
        </section>
      </main>
    );
  }

  if (!loggedIn) {
    return (
      <>
        <Login onLogin={() => setLoggedIn(true)} onModal={setModal} />

        <Modal
          type={modal}
          onClose={() => setModal(null)}
          onToast={notify}
        />

        {toast && <div className="toast">{toast}</div>}
      </>
    );
  }

  return (
    <div className="app">
      <Sidebar />

      <main className="content">{renderPage()}</main>

      {toast && (
        <div className="toast">
          <Check size={16} />
          {toast}
        </div>
      )}
    </div>
  );
}
