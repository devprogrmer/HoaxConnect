import {
  Activity,
  ArrowDownRight,
  ArrowLeft,
  ArrowUpRight,
  Bell,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  CreditCard,
  Gauge,
  Layers3,
  LogOut,
  Menu,
  Monitor,
  Network,
  Plus,
  RefreshCw,
  Search,
  Server,
  Shield,
  UserCog,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { adminApi, jsonBody } from "./api";

type Admin = {
  id: string;
  email: string;
  role: "superadmin" | "admin" | "support" | "read_only";
  mfa_enabled?: boolean;
  session_expires_at?: string;
};

type View =
  | "overview"
  | "alerts"
  | "traffic"
  | "users"
  | "user-detail"
  | "sessions"
  | "plans"
  | "subscriptions"
  | "nodes"
  | "payments"
  | "security"
  | "providers"
  | "admins";

type NavItem = { id: View | "audit"; label: string; icon: LucideIcon; access?: string };

type ResourceState<T> = {
  data: T | null;
  loading: boolean;
  error: string;
};

type ActionDialogState = {
  title: string;
  description: string;
  endpoint: string;
  payload: Record<string, unknown>;
  readOnly?: boolean;
};

const navGroups: Array<{ label: string; items: NavItem[] }> = [
  {
    label: "OPERATIONS",
    items: [
      { id: "overview", label: "Overview", icon: Gauge },
      { id: "alerts", label: "Alerts", icon: Bell, access: "dashboard.read" },
      { id: "traffic", label: "Traffic usage", icon: Activity, access: "telemetry.read" },
      { id: "users", label: "Users", icon: Users, access: "users.read" },
      { id: "sessions", label: "Sessions", icon: Monitor, access: "sessions.read" },
    ],
  },
  {
    label: "PRODUCT",
    items: [
      { id: "plans", label: "Plans", icon: Layers3, access: "plans.read" },
      { id: "subscriptions", label: "Subscriptions", icon: Activity, access: "subscriptions.read" },
      { id: "payments", label: "Payments", icon: CreditCard, access: "payments.read" },
    ],
  },
  {
    label: "NETWORK",
    items: [
      { id: "nodes", label: "VPN nodes", icon: Server, access: "nodes.read" },
    ],
  },
  {
    label: "SECURITY",
    items: [
      { id: "security", label: "Audit & access", icon: Shield, access: "audit.read" },
      { id: "providers", label: "Integrations", icon: Network, access: "providers.status.read" },
      { id: "admins", label: "Admin accounts", icon: UserCog, access: "admins.manage" },
    ],
  },
];

function hasRoleAccess(role: Admin["role"], access?: string): boolean {
  if (!access) return true;
  if (role === "superadmin") return true;
  if (access === "audit.sensitive.read") return false;
  const grants: Record<Admin["role"], string[]> = {
    superadmin: [],
    admin: [
      "dashboard.read",
      "users.read", "sessions.read", "plans.read", "subscriptions.read",
      "payments.read", "nodes.read", "audit.read", "providers.status.read",
      "telemetry.read",
    ],
    support: ["dashboard.read", "users.read", "sessions.read", "subscriptions.read", "payments.read"],
    read_only: [
      "dashboard.read",
      "users.read", "sessions.read", "plans.read", "subscriptions.read",
      "payments.read", "nodes.read",
    ],
  };
  return grants[role].includes(access);
}

function useResource<T>(path: string, refresh: number): ResourceState<T> {
  const [state, setState] = useState<ResourceState<T> & { path: string }>({
    data: null,
    loading: true,
    error: "",
    path: "",
  });

  useEffect(() => {
    let current = true;
    adminApi<T>(path)
      .then((data) => {
        if (current) setState({ data, loading: false, error: "", path });
      })
      .catch((error: unknown) => {
        if (current) {
          setState({
            data: null,
            loading: false,
            error: error instanceof Error ? error.message : "Request failed.",
            path,
          });
        }
      });
    return () => { current = false; };
  }, [path, refresh]);

  return state.path === path
    ? state
    : { data: null, loading: true, error: "" };
}

function formatDate(value?: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatBytes(value?: string | number | null): string {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** index)).toFixed(index > 2 ? 1 : 0)} ${units[index]}`;
}

function formatMoney(value?: string | number | null, currency = "IRR"): string {
  const amount = Number(value || 0);
  return `${new Intl.NumberFormat("en").format(amount)} ${currency}`;
}

function titleCase(value?: string | null): string {
  if (!value) return "Unknown";
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function StatusBadge({ value }: { value?: string | boolean | null }) {
  const label = typeof value === "boolean" ? (value ? "Enabled" : "Disabled") : titleCase(value);
  const normalized = String(value || "unknown").toLowerCase().replaceAll("_", "-");
  return <span className={`status-badge status-${normalized}`}>{label}</span>;
}

function PageHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action && <div className="page-heading-action">{action}</div>}
    </div>
  );
}

function LoadingLine() {
  return <div className="loading-line"><span /><span /><span /></div>;
}

function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="notice notice-error" role="alert">
      <span>{message}</span>
      {onRetry && <button className="icon-button" onClick={onRetry} title="Retry"><RefreshCw size={16} /></button>}
    </div>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="empty-state"><CircleHelp size={21} /><strong>{title}</strong><span>{detail}</span></div>;
}

function DataTable({
  headers,
  children,
}: {
  headers: string[];
  children: React.ReactNode;
}) {
  return (
    <div className="table-scroll">
      <table>
        <thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Login({ onLogin }: { onLogin: (admin: Admin) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const result = await adminApi<Admin>("/auth/login", {
        method: "POST",
        body: jsonBody({ email, password }),
      });
      setPassword("");
      onLogin(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Sign-in failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-shell">
      <div className="login-side">
        <div className="brand-lockup"><div className="brand-mark">H</div><div><strong>HOAXCONNECT</strong><small>OPERATIONS</small></div></div>
        <div className="login-side-copy">
          <span className="live-mark"><i /> PRIVATE CONTROL CENTER</span>
          <h1>Keep the network<br />accountable.</h1>
          <p>One place for account security, subscriptions and node operations.</p>
        </div>
        <div className="login-side-foot"><Shield size={16} /> Administrative access is monitored and audited.</div>
      </div>
      <main className="login-main">
        <form className="login-form" onSubmit={submit}>
          <div className="eyebrow">ADMINISTRATOR ACCESS</div>
          <h2>Sign in</h2>
          <p className="muted">Use your HoaxConnect Admin account.</p>
          <label className="field"><span>Email</span><input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required maxLength={320} /></label>
          <label className="field"><span>Password</span><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required maxLength={128} /></label>
          {error && <ErrorNotice message={error} />}
          <button className="primary-button login-submit" disabled={loading}>{loading ? "Signing in…" : "Sign in"}<ChevronRight size={18} /></button>
          <div className="login-note"><Shield size={15} /> Protected with a secure session</div>
        </form>
      </main>
    </div>
  );
}

function Metric({
  label,
  value,
  note,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  note?: string;
  icon: LucideIcon;
  tone: string;
}) {
  return (
    <div className={`metric metric-${tone}`}>
      <div className="metric-top"><span>{label}</span><Icon size={17} /></div>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}

function OverviewPage({ refresh, onNavigate }: { refresh: number; onNavigate: (view: View) => void }) {
  const stats = useResource<Record<string, string>>("/dashboard", refresh);
  const alerts = useResource<Array<Record<string, string>>>("/alerts", refresh);

  if (stats.loading && !stats.data) return <LoadingLine />;
  if (stats.error) return <ErrorNotice message={stats.error} />;
  const data = stats.data || {};
  const recent = (alerts.data || []).slice(0, 6);

  return (
    <>
      <PageHeading eyebrow="OPERATIONS / OVERVIEW" title="Network at a glance" description="Current counts from the production data model." action={<button className="secondary-button" onClick={() => onNavigate("users")}><Users size={16} /> Find a user</button>} />
      <div className="metric-grid">
        <Metric label="Accounts" value={Number(data.users || 0).toLocaleString()} note="Non-deleted accounts" icon={Users} tone="mint" />
        <Metric label="Active sessions" value={Number(data.active_sessions || 0).toLocaleString()} note="Unexpired user sessions" icon={Monitor} tone="cyan" />
        <Metric label="Active devices" value={Number(data.active_devices || 0).toLocaleString()} note="Not revoked" icon={Activity} tone="amber" />
        <Metric label="Subscriptions" value={Number(data.active_subscriptions || 0).toLocaleString()} note="Currently active" icon={CreditCard} tone="rose" />
        <Metric label="Enabled nodes" value={Number(data.enabled_nodes || 0).toLocaleString()} note="Agent status not yet connected" icon={Server} tone="violet" />
        <Metric label="Pending payments" value={Number(data.pending_payments || 0).toLocaleString()} note="No provider verification is performed here" icon={Clock3} tone="amber" />
        <Metric label="Traffic today" value={formatBytes(data.traffic_today_bytes)} note="Reported usage rows" icon={ArrowUpRight} tone="cyan" />
        <Metric label="Device holds" value={Number(data.rejected_devices_24h || 0).toLocaleString()} note="Rejected enrollments · 24h" icon={Shield} tone="rose" />
      </div>
      <div className="overview-grid">
        <section className="section-panel">
          <div className="section-title"><div><span className="eyebrow">ATTENTION</span><h2>Recent security events</h2></div><button className="text-button" onClick={() => onNavigate("alerts")}>All alerts <ChevronRight size={15} /></button></div>
          {alerts.loading && !alerts.data ? <LoadingLine /> : recent.length ? (
            <div className="event-list">{recent.map((event, index) => (
              <div className="event-row" key={`${event.id}-${index}`}>
                <span className={`event-icon ${event.category === "policy" ? "event-amber" : "event-red"}`}><Bell size={15} /></span>
                <div className="event-content"><strong>{event.summary || titleCase(event.event)}</strong><small>{titleCase(event.category)} · {event.user_id}</small></div>
                <time>{formatDate(event.created_at)}</time>
              </div>
            ))}</div>
          ) : <EmptyState title="No security events" detail="Recent device and policy events will appear here." />}
          {alerts.error && <ErrorNotice message={alerts.error} />}
        </section>
        <section className="section-panel node-summary">
          <div className="section-title"><div><span className="eyebrow">INFRASTRUCTURE</span><h2>VPN node reporting</h2></div><Server size={19} /></div>
          <div className="node-status-art"><div className="node-pulse"><Network size={24} /></div><div><strong>Agent not connected</strong><span>Online state will come from authenticated node health reports.</span></div></div>
          <button className="secondary-button full-width" onClick={() => onNavigate("nodes")}>Open node inventory <ArrowUpRight size={15} /></button>
        </section>
      </div>
    </>
  );
}

type UserRow = {
  id: string;
  email: string;
  username: string;
  status: string;
  phone?: string | null;
  phone_verified: boolean;
  created_at: string;
  last_login_at?: string | null;
  active_devices: string;
  active_sessions: string;
};

type UserList = { items: UserRow[]; page: number; page_size: number; total: number };

type TrafficItem = {
  id: string;
  user_id: string;
  email: string;
  username: string;
  account_status: string;
  device_id: string;
  device_name: string;
  device_os: string;
  node_id: string | null;
  node_name: string | null;
  period_date: string;
  period_start: string;
  period_end: string;
  rx_bytes: string;
  tx_bytes: string;
  total_bytes: string;
  source: string;
};

type TrafficReport = {
  items: TrafficItem[];
  page: number;
  page_size: number;
  total: string;
  rx_bytes: string;
  tx_bytes: string;
  total_bytes: string;
  range: { from: string; to: string };
  source: string;
};

type SecurityAlert = {
  id: string;
  user_id: string | null;
  category: string;
  event: string;
  summary: string;
  created_at: string;
};

function dateInputValue(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function defaultTrafficFilters() {
  const to = new Date();
  const from = new Date(to.getTime() - 6 * 24 * 60 * 60 * 1000);
  return { from: dateInputValue(from), to: dateInputValue(to), search: "" };
}

function TrafficPage({ refresh }: { refresh: number }) {
  const [filters, setFilters] = useState(defaultTrafficFilters);
  const [draft, setDraft] = useState(filters);
  const [page, setPage] = useState(1);
  const path = useMemo(() => {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: "50",
      from: filters.from,
      to: filters.to,
    });
    if (filters.search) params.set("search", filters.search);
    return `/traffic?${params.toString()}`;
  }, [filters, page]);
  const result = useResource<TrafficReport>(path, refresh);

  return <>
    <PageHeading eyebrow="OPERATIONS / ACCOUNTING" title="Traffic usage" description="Recorded accounting rows grouped by device and reporting period." />
    <div className="notice notice-warning"><Activity size={16} /> These are Backend accounting records, not verified live tunnel counters. Authoritative node reporting and quota enforcement are not active.</div>
    <form className="filter-bar traffic-filters" onSubmit={(event) => { event.preventDefault(); setFilters({ ...draft, search: draft.search.trim() }); setPage(1); }}>
      <label className="field compact-field"><span>From</span><input type="date" value={draft.from} onChange={(event) => setDraft({ ...draft, from: event.target.value })} required /></label>
      <label className="field compact-field"><span>To</span><input type="date" value={draft.to} onChange={(event) => setDraft({ ...draft, to: event.target.value })} required /></label>
      <label className="search-field"><Search size={17} /><input value={draft.search} onChange={(event) => setDraft({ ...draft, search: event.target.value })} placeholder="Email, username, device or node" maxLength={200} /></label>
      <button className="secondary-button"><Search size={15} /> Apply</button>
    </form>
    {result.data && <div className="metric-grid traffic-metrics">
      <Metric label="Reported total" value={formatBytes(result.data.total_bytes)} note={`${Number(result.data.total).toLocaleString()} accounting rows`} icon={Activity} tone="mint" />
      <Metric label="Received" value={formatBytes(result.data.rx_bytes)} note={`${result.data.range.from} to ${result.data.range.to}`} icon={ArrowDownRight} tone="cyan" />
      <Metric label="Sent" value={formatBytes(result.data.tx_bytes)} note="Across the selected period" icon={ArrowUpRight} tone="amber" />
    </div>}
    <section className="section-panel table-panel">{result.loading && !result.data ? <LoadingLine /> : result.error ? <ErrorNotice message={result.error} /> : result.data?.items.length ? <DataTable headers={["Period", "Account", "Device", "Node", "Received", "Sent", "Total", "Source"]}>{result.data.items.map((item) => <tr key={item.id}><td><strong>{item.period_date}</strong><small>{formatDate(item.period_start)} – {formatDate(item.period_end)}</small></td><td><strong>{item.username}</strong><small>{item.email}</small></td><td><strong>{item.device_name}</strong><small>{titleCase(item.device_os)}</small></td><td>{item.node_name || "Unassigned"}</td><td>{formatBytes(item.rx_bytes)}</td><td>{formatBytes(item.tx_bytes)}</td><td><strong>{formatBytes(item.total_bytes)}</strong></td><td><code>{item.source}</code></td></tr>)}</DataTable> : <EmptyState title="No usage records" detail="No accounting rows match this date range and search." />}</section>
    {result.data && <div className="table-footer"><span>Showing {Number(result.data.total) ? (page - 1) * result.data.page_size + 1 : 0}–{Math.min(page * result.data.page_size, Number(result.data.total))} of {Number(result.data.total).toLocaleString()} rows</span><div><button className="secondary-button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</button><button className="secondary-button" disabled={page * result.data.page_size >= Number(result.data.total)} onClick={() => setPage((value) => value + 1)}>Next</button></div></div>}
  </>;
}

function AlertsPage({ refresh }: { refresh: number }) {
  const result = useResource<SecurityAlert[]>("/alerts", refresh);
  return <>
    <PageHeading eyebrow="OPERATIONS / ATTENTION" title="Security alerts" description="Recent device-limit and account-policy events recorded by the Backend." />
    <section className="section-panel table-panel">{result.loading && !result.data ? <LoadingLine /> : result.error ? <ErrorNotice message={result.error} /> : result.data?.length ? <DataTable headers={["When", "Category", "Event", "Account", "Details"]}>{result.data.map((alert) => <tr key={alert.id}><td>{formatDate(alert.created_at)}</td><td><StatusBadge value={alert.category} /></td><td><strong>{titleCase(alert.event)}</strong></td><td><code>{alert.user_id || "System"}</code></td><td>{alert.summary}</td></tr>)}</DataTable> : <EmptyState title="No recent alerts" detail="New policy and device-limit events will appear here." />}</section>
  </>;
}

function UsersPage({ refresh, onSelect }: { refresh: number; onSelect: (userId: string) => void }) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const path = useMemo(() => {
    const params = new URLSearchParams({ page: "1", pageSize: "50" });
    if (query) params.set("search", query);
    if (statusFilter) params.set("status", statusFilter);
    return `/users?${params.toString()}`;
  }, [query, statusFilter]);
  const result = useResource<UserList>(path, refresh);

  function submitSearch(event: React.FormEvent) {
    event.preventDefault();
    setQuery(search.trim());
    setStatusFilter(status);
  }

  return (
    <>
      <PageHeading eyebrow="ACCOUNTS" title="Users" description="Search account status, devices and active sessions." />
      <form className="filter-bar" onSubmit={submitSearch}>
        <label className="search-field"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Email, username or phone" /></label>
        <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Filter by account status">
          <option value="">All statuses</option><option value="active">Active</option><option value="pending_verification">Pending verification</option><option value="suspended">Suspended</option><option value="banned">Banned</option>
        </select>
        <button className="secondary-button" type="submit"><Search size={15} /> Search</button>
        <span className="filter-count">{result.data?.total ?? 0} accounts</span>
      </form>
      <section className="section-panel table-panel">
        {result.loading && !result.data ? <LoadingLine /> : result.error ? <ErrorNotice message={result.error} /> : result.data?.items.length ? (
          <DataTable headers={["Account", "Status", "Phone", "Devices", "Sessions", "Last sign-in", ""]}>
            {result.data.items.map((user) => (
              <tr key={user.id} className="clickable-row" onClick={() => onSelect(user.id)}>
                <td><strong>{user.username}</strong><small>{user.email}</small></td>
                <td><StatusBadge value={user.status} /></td>
                <td>{user.phone || "—"}{user.phone && <small>{user.phone_verified ? "Verified" : "Unverified"}</small>}</td>
                <td>{user.active_devices}</td><td>{user.active_sessions}</td><td>{formatDate(user.last_login_at)}</td><td><ChevronRight size={16} /></td>
              </tr>
            ))}
          </DataTable>
        ) : <EmptyState title="No matching accounts" detail="Try another email, username or status." />}
      </section>
    </>
  );
}

type UserDetail = {
  user: UserRow & { role: string; email_verified_at?: string | null; phone_verified_at?: string | null; suspended_at?: string | null; suspension_reason?: string | null; banned_at?: string | null; ban_reason?: string | null };
  devices: Array<Record<string, string | null>>;
  sessions: Array<Record<string, string | null>>;
  subscriptions: Array<Record<string, string | null>>;
  payments: Array<Record<string, string | null>>;
  audit: Array<Record<string, string | null>>;
};

function UserDetailPage({
  userId,
  refresh,
  admin,
  onBack,
  onAction,
}: {
  userId: string;
  refresh: number;
  admin: Admin;
  onBack: () => void;
  onAction: (action: ActionDialogState) => void;
}) {
  const result = useResource<UserDetail>(`/users/${userId}`, refresh);
  const detail = result.data;
  const user = detail?.user;
  const canRevoke = admin.role !== "read_only";
  const canModerate = admin.role === "admin" || admin.role === "superadmin";

  if (result.loading && !result.data) return <LoadingLine />;
  if (result.error || !user || !detail) return <ErrorNotice message={result.error || "The account could not be loaded."} onRetry={() => onBack()} />;

  return (
    <>
      <button className="back-link" onClick={onBack}><ArrowLeft size={15} /> Users</button>
      <PageHeading eyebrow="ACCOUNT DETAIL" title={user.username} description={user.email} action={<StatusBadge value={user.status} />} />
      <section className="section-panel profile-panel">
        <div className="profile-meta"><span><small>Account ID</small><code>{user.id}</code></span><span><small>Created</small>{formatDate(user.created_at)}</span><span><small>Email verification</small><StatusBadge value={user.email_verified_at ? "verified" : "unverified"} /></span><span><small>Phone</small>{user.phone || "Not provided"}<small>{user.phone ? (user.phone_verified ? "Verified" : "Unverified") : ""}</small></span></div>
        <div className="action-row">
          {canModerate && user.status === "active" && <button className="secondary-button" onClick={() => onAction({ title: "Suspend account", description: "This blocks new authentication and revokes active sessions.", endpoint: `/users/${user.id}/status`, payload: { action: "suspend" } })}>Suspend</button>}
          {canModerate && user.status === "suspended" && <button className="secondary-button" onClick={() => onAction({ title: "Restore account", description: "Restore sign-in for this suspended account.", endpoint: `/users/${user.id}/status`, payload: { action: "unsuspend" } })}>Unsuspend</button>}
          {canModerate && ["active", "suspended"].includes(user.status) && <button className="danger-button" onClick={() => onAction({ title: "Ban account", description: "This blocks authentication and revokes active sessions and peers.", endpoint: `/users/${user.id}/status`, payload: { action: "ban" } })}>Ban account</button>}
          {canModerate && user.status === "banned" && <button className="secondary-button" onClick={() => onAction({ title: "Unban account", description: "Restore this account to active status.", endpoint: `/users/${user.id}/status`, payload: { action: "unban" } })}>Unban</button>}
          {canRevoke && <button className="secondary-button" onClick={() => onAction({ title: "Revoke all sessions", description: "Sign this account out everywhere and invalidate its active VPN peers.", endpoint: `/users/${user.id}/revoke-sessions`, payload: {} })}>Revoke all sessions</button>}
        </div>
      </section>
      <div className="detail-grid">
        <section className="section-panel">
          <div className="section-title"><div><span className="eyebrow">SECURITY</span><h2>Devices</h2></div><span className="count-pill">{detail.devices.length}</span></div>
          {detail.devices.length ? <DataTable headers={["Device", "Platform", "Last seen", "State", ""]}>{detail.devices.map((device) => <tr key={device.id}><td><strong>{device.name}</strong><small>{device.device_uid}</small></td><td>{device.platform || device.os || "—"}</td><td>{formatDate(device.last_seen_at)}</td><td><StatusBadge value={device.revoked_at ? "revoked" : device.banned_at ? "banned" : "active"} /></td><td>{canRevoke && !device.revoked_at && <button className="text-button" onClick={() => onAction({ title: "Revoke device", description: "This device will no longer authenticate.", endpoint: `/users/${user.id}/devices/${device.id}`, payload: { action: "revoke" } })}>Revoke</button>}</td></tr>)}</DataTable> : <EmptyState title="No devices" detail="Enrolled devices will appear here." />}
        </section>
        <section className="section-panel">
          <div className="section-title"><div><span className="eyebrow">ACCESS</span><h2>Sessions</h2></div><span className="count-pill">{detail.sessions.length}</span></div>
          {detail.sessions.length ? <DataTable headers={["Device", "State", "Last used", "Expires", ""]}>{detail.sessions.map((session) => <tr key={session.id}><td><strong>{session.device_name}</strong><small>{session.id}</small></td><td><StatusBadge value={session.status} /></td><td>{formatDate(session.last_used_at)}</td><td>{formatDate(session.expires_at)}</td><td>{canRevoke && session.status === "active" && <button className="text-button" onClick={() => onAction({ title: "Revoke session", description: "This session will be signed out immediately.", endpoint: `/users/${user.id}/sessions/${session.id}/revoke`, payload: {} })}>Revoke</button>}</td></tr>)}</DataTable> : <EmptyState title="No sessions" detail="Account sessions will appear here." />}
        </section>
        <section className="section-panel">
          <div className="section-title"><div><span className="eyebrow">ENTITLEMENT</span><h2>Subscriptions</h2></div><span className="count-pill">{detail.subscriptions.length}</span></div>
          {detail.subscriptions.length ? <DataTable headers={["Plan", "State", "Ends", "Usage"]}>{detail.subscriptions.map((sub) => <tr key={sub.id}><td><strong>{sub.plan_name}</strong><small>{sub.plan_code}</small></td><td><StatusBadge value={sub.status} /></td><td>{formatDate(sub.ends_at)}</td><td>{formatBytes(sub.used_bytes)} / {formatBytes(sub.traffic_quota_bytes)}</td></tr>)}</DataTable> : <EmptyState title="No subscriptions" detail="No subscription records exist for this account." />}
        </section>
        <section className="section-panel">
          <div className="section-title"><div><span className="eyebrow">BILLING</span><h2>Payments</h2></div><span className="count-pill">{detail.payments.length}</span></div>
          {detail.payments.length ? <DataTable headers={["Provider", "Amount", "State", "Date"]}>{detail.payments.map((payment) => <tr key={payment.id}><td>{payment.provider || "—"}</td><td>{formatMoney(payment.amount_minor, payment.currency || "IRR")}</td><td><StatusBadge value={payment.status} /></td><td>{formatDate(payment.created_at)}</td></tr>)}</DataTable> : <EmptyState title="No payment records" detail="Payments are never marked successful from the client." />}
        </section>
      </div>
    </>
  );
}

function ActionDialog({
  action,
  busy,
  onClose,
  onConfirm,
}: {
  action: ActionDialogState;
  busy: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="action-title" onSubmit={(event) => { event.preventDefault(); onConfirm(reason.trim()); }}>
        <div className="modal-head"><div><span className="eyebrow">CONFIRM OPERATION</span><h2 id="action-title">{action.title}</h2></div><button className="icon-button" type="button" title="Close" onClick={onClose}><X size={17} /></button></div>
        <p className="muted">{action.description}</p>
        {!action.readOnly && <label className="field"><span>Reason (required)</span><textarea value={reason} onChange={(event) => setReason(event.target.value)} minLength={8} maxLength={500} required rows={3} placeholder="Record the reason for this operation" /></label>}
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>{action.readOnly ? "Close" : "Cancel"}</button>{!action.readOnly && <button className="danger-button" disabled={busy || reason.trim().length < 8}>{busy ? "Working…" : "Confirm"}</button>}</div>
      </form>
    </div>
  );
}

type Plan = {
  id: string;
  code: string;
  name: string;
  duration_days: number;
  traffic_quota_bytes: string;
  device_limit: number;
  concurrent_session_limit: number;
  price_irr: string;
  enabled: boolean;
};

function PlanDialog({
  plan,
  busy,
  onClose,
  onSave,
}: {
  plan: Plan | null;
  busy: boolean;
  onClose: () => void;
  onSave: (value: Record<string, unknown>) => void;
}) {
  const [form, setForm] = useState({
    code: plan?.code || "",
    name: plan?.name || "",
    duration_days: String(plan?.duration_days || 30),
    traffic_quota_bytes: plan?.traffic_quota_bytes || "10737418240",
    device_limit: String(plan?.device_limit || 1),
    concurrent_session_limit: String(plan?.concurrent_session_limit || 1),
    price_irr: plan?.price_irr || "0",
    enabled: plan?.enabled ?? false,
    reason: "",
  });
  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((previous) => ({ ...previous, [key]: value }));
  }
  return (
    <div className="modal-backdrop"><form className="modal modal-wide" role="dialog" aria-modal="true" onSubmit={(event) => { event.preventDefault(); onSave({ ...form, duration_days: Number(form.duration_days), device_limit: Number(form.device_limit), concurrent_session_limit: Number(form.concurrent_session_limit) }); }}>
      <div className="modal-head"><div><span className="eyebrow">CATALOG</span><h2>{plan ? "Edit plan" : "Create plan"}</h2></div><button className="icon-button" type="button" title="Close" onClick={onClose}><X size={17} /></button></div>
      <div className="form-grid"><label className="field"><span>Code</span><input value={form.code} onChange={(e) => set("code", e.target.value)} required maxLength={64} pattern="[a-z0-9][a-z0-9_-]{1,63}" /></label><label className="field"><span>Name</span><input value={form.name} onChange={(e) => set("name", e.target.value)} required maxLength={120} /></label><label className="field"><span>Duration · days</span><input type="number" min="1" max="3650" value={form.duration_days} onChange={(e) => set("duration_days", e.target.value)} required /></label><label className="field"><span>Price · IRR</span><input inputMode="numeric" pattern="[0-9]+" value={form.price_irr} onChange={(e) => set("price_irr", e.target.value)} required /></label><label className="field"><span>Traffic quota · bytes</span><input inputMode="numeric" pattern="[0-9]+" value={form.traffic_quota_bytes} onChange={(e) => set("traffic_quota_bytes", e.target.value)} required /></label><label className="field"><span>Device limit</span><input type="number" min="1" max="100" value={form.device_limit} onChange={(e) => set("device_limit", e.target.value)} required /></label><label className="field"><span>Concurrent sessions</span><input type="number" min="1" max="100" value={form.concurrent_session_limit} onChange={(e) => set("concurrent_session_limit", e.target.value)} required /></label><label className="toggle-field"><span><strong>Available for assignment</strong><small>Does not grant a subscription by itself.</small></span><input type="checkbox" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} /></label></div>
      <label className="field"><span>Reason (required)</span><textarea value={form.reason} onChange={(e) => set("reason", e.target.value)} minLength={8} maxLength={500} required rows={2} /></label>
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy}>{busy ? "Saving…" : "Save plan"}</button></div>
    </form></div>
  );
}

function PlansPage({ refresh, admin, onAction, onRefresh }: { refresh: number; admin: Admin; onAction: (action: ActionDialogState) => void; onRefresh: (message: string) => void }) {
  const result = useResource<Plan[]>("/plans", refresh);
  const [editing, setEditing] = useState<Plan | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const canWrite = admin.role === "admin" || admin.role === "superadmin";

  async function save(value: Record<string, unknown>) {
    const planId = editing && "id" in editing ? editing.id : null;
    setBusy(true);
    try {
      await adminApi(planId ? `/plans/${planId}` : "/plans", { method: planId ? "PATCH" : "POST", body: jsonBody(value) });
      setEditing(undefined);
      onRefresh("Plan saved.");
    } catch (error) {
      onAction({ title: "Plan was not saved", description: error instanceof Error ? error.message : "Request failed.", endpoint: "", payload: {}, readOnly: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeading eyebrow="PRODUCT / CATALOG" title="Plans" description="Prices and limits stored by the Backend, in integer IRR and bytes." action={canWrite ? <button className="primary-button" onClick={() => setEditing(null)}><Plus size={16} /> New plan</button> : undefined} />
      <section className="section-panel table-panel">
        {result.loading && !result.data ? <LoadingLine /> : result.error ? <ErrorNotice message={result.error} /> : result.data?.length ? <DataTable headers={["Plan", "Duration", "Traffic", "Devices", "Sessions", "Price", "State", ""]}>{result.data.map((plan) => <tr key={plan.id}><td><strong>{plan.name}</strong><small>{plan.code}</small></td><td>{plan.duration_days} days</td><td>{formatBytes(plan.traffic_quota_bytes)}</td><td>{plan.device_limit}</td><td>{plan.concurrent_session_limit}</td><td>{formatMoney(plan.price_irr)}</td><td><StatusBadge value={plan.enabled} /></td><td>{canWrite && <button className="text-button" onClick={() => setEditing(plan)}>Edit</button>}</td></tr>)}</DataTable> : <EmptyState title="No plans configured" detail="Create a plan to make the catalog available to operators." />}
      </section>
      {editing !== undefined && <PlanDialog plan={editing} busy={busy} onClose={() => setEditing(undefined)} onSave={save} />}
    </>
  );
}

type Subscription = {
  id: string;
  user_id: string;
  email: string;
  username: string;
  plan_id: string;
  plan_code: string;
  plan_name: string;
  status: string;
  starts_at?: string | null;
  ends_at?: string | null;
  traffic_quota_bytes: string;
  used_bytes: string;
};

function SubscriptionDialog({
  subscription,
  busy,
  onClose,
  onSave,
}: {
  subscription: Subscription;
  busy: boolean;
  onClose: () => void;
  onSave: (payload: Record<string, unknown>) => void;
}) {
  const plans = useResource<Plan[]>("/plans", 0);
  const [action, setAction] = useState("extend_days");
  const [amount, setAmount] = useState("30");
  const [planId, setPlanId] = useState("");
  const [reason, setReason] = useState("");
  const selectedPlan = plans.data?.find((plan) => plan.id === planId);
  return (
    <div className="modal-backdrop"><form className="modal" role="dialog" aria-modal="true" onSubmit={(event) => { event.preventDefault(); const detail = action === "extend_days" ? { action, days: Number(amount) } : action === "add_traffic" ? { action, bytes: amount } : { action, plan_id: planId }; onSave({ ...detail, reason }); }}>
      <div className="modal-head"><div><span className="eyebrow">SUBSCRIPTION</span><h2>Adjust access</h2></div><button className="icon-button" type="button" title="Close" onClick={onClose}><X size={17} /></button></div>
      <p className="muted">{subscription.email} · {subscription.plan_name}</p>
      <label className="field"><span>Adjustment</span><select value={action} onChange={(event) => { setAction(event.target.value); setAmount(event.target.value === "extend_days" ? "30" : "1073741824"); }}><option value="extend_days">Extend duration</option><option value="add_traffic">Add traffic</option><option value="change_plan">Change plan</option></select></label>
      {action === "change_plan" ? <label className="field"><span>New plan</span><select value={planId} onChange={(event) => setPlanId(event.target.value)} required><option value="">Select a plan</option>{(plans.data || []).filter((plan) => plan.enabled).map((plan) => <option key={plan.id} value={plan.id}>{plan.name} · {formatMoney(plan.price_irr)}</option>)}</select>{selectedPlan && <small className="field-hint">Quota and device limits will follow {selectedPlan.name}.</small>}</label> : <label className="field"><span>{action === "extend_days" ? "Days to add" : "Bytes to add"}</span><input type="number" min="1" max={action === "extend_days" ? "3650" : undefined} value={amount} onChange={(event) => setAmount(event.target.value)} required /></label>}
      <label className="field"><span>Reason (required)</span><textarea value={reason} onChange={(event) => setReason(event.target.value)} minLength={8} maxLength={500} required rows={3} /></label>
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy || (action === "change_plan" && !planId)}>{busy ? "Saving…" : "Apply adjustment"}</button></div>
    </form></div>
  );
}

function SubscriptionsPage({ refresh, admin, onAction, onRefresh }: { refresh: number; admin: Admin; onAction: (action: ActionDialogState) => void; onRefresh: (message: string) => void }) {
  const result = useResource<{ items: Subscription[]; total: number }>("/subscriptions?page=1&pageSize=50", refresh);
  const [selected, setSelected] = useState<Subscription | null>(null);
  const [busy, setBusy] = useState(false);
  const canWrite = admin.role === "admin" || admin.role === "superadmin";
  async function save(payload: Record<string, unknown>) {
    if (!selected) return;
    setBusy(true);
    try {
      await adminApi(`/subscriptions/${selected.id}/adjust`, { method: "POST", body: jsonBody(payload) });
      setSelected(null);
      onRefresh("Subscription updated.");
    } catch (error) {
      onAction({ title: "Subscription was not updated", description: error instanceof Error ? error.message : "Request failed.", endpoint: "", payload: {}, readOnly: true });
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading eyebrow="PRODUCT / ACCESS" title="Subscriptions" description="Current entitlement and usage. Adjustments are recorded with an operator reason." />
      <section className="section-panel table-panel">
        {result.loading && !result.data ? <LoadingLine /> : result.error ? <ErrorNotice message={result.error} /> : result.data?.items.length ? <DataTable headers={["Account", "Plan", "State", "Ends", "Traffic used", ""]}>{result.data.items.map((subscription) => <tr key={subscription.id}><td><strong>{subscription.username}</strong><small>{subscription.email}</small></td><td>{subscription.plan_name}<small>{subscription.plan_code}</small></td><td><StatusBadge value={subscription.status} /></td><td>{formatDate(subscription.ends_at)}</td><td>{formatBytes(subscription.used_bytes)} / {formatBytes(subscription.traffic_quota_bytes)}</td><td>{canWrite && subscription.status === "active" && <button className="text-button" onClick={() => setSelected(subscription)}>Adjust</button>}</td></tr>)}</DataTable> : <EmptyState title="No subscriptions" detail="Subscription records will appear here when they exist." />}
      </section>
      {selected && <SubscriptionDialog subscription={selected} busy={busy} onClose={() => setSelected(null)} onSave={save} />}
    </>
  );
}

type NodeRecord = {
  id: string;
  name: string;
  country_code: string;
  region: string;
  city?: string | null;
  hostname: string;
  public_endpoint: string;
  status: string;
  capacity_peers: number;
  current_peers: number;
  enabled: boolean;
  last_seen_at?: string | null;
  reported_traffic_bytes: string;
};

function NodeDialog({
  node,
  busy,
  onClose,
  onSave,
}: {
  node: NodeRecord | null;
  busy: boolean;
  onClose: () => void;
  onSave: (value: Record<string, unknown>) => void;
}) {
  const [form, setForm] = useState({
    name: node?.name || "",
    country_code: node?.country_code || "",
    region: node?.region || "",
    city: node?.city || "",
    hostname: node?.hostname || "",
    public_endpoint: node?.public_endpoint || "",
    public_key: "",
    capacity_peers: String(node?.capacity_peers ?? 100),
    enabled: node?.enabled ?? false,
    status: node?.status || "offline",
    reason: "",
  });
  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }
  return (
    <div className="modal-backdrop"><form className="modal modal-wide" role="dialog" aria-modal="true" onSubmit={(event) => {
      event.preventDefault();
      const common = {
        name: form.name,
        country_code: form.country_code,
        region: form.region,
        city: form.city || null,
        hostname: form.hostname,
        public_endpoint: form.public_endpoint,
        capacity_peers: Number(form.capacity_peers),
        reason: form.reason,
      };
      onSave(node ? { ...common, enabled: form.enabled, status: form.status } : { ...common, public_key: form.public_key });
    }}>
      <div className="modal-head"><div><span className="eyebrow">INFRASTRUCTURE</span><h2>{node ? "Edit node inventory" : "Register VPN node"}</h2></div><button className="icon-button" type="button" title="Close" onClick={onClose}><X size={17} /></button></div>
      {!node && <div className="notice notice-warning">Registration only creates an offline inventory record. It does not install or connect a VPN agent.</div>}
      <div className="form-grid"><label className="field"><span>Display name</span><input value={form.name} onChange={(e) => set("name", e.target.value)} minLength={2} maxLength={120} required /></label><label className="field"><span>Country code</span><input value={form.country_code} onChange={(e) => set("country_code", e.target.value.toUpperCase())} pattern="[A-Za-z]{2}" maxLength={2} required /></label><label className="field"><span>Region</span><input value={form.region} onChange={(e) => set("region", e.target.value)} minLength={2} maxLength={120} required /></label><label className="field"><span>City</span><input value={form.city} onChange={(e) => set("city", e.target.value)} maxLength={120} /></label><label className="field"><span>Hostname</span><input value={form.hostname} onChange={(e) => set("hostname", e.target.value)} minLength={3} maxLength={255} required /></label><label className="field"><span>Public endpoint</span><input value={form.public_endpoint} onChange={(e) => set("public_endpoint", e.target.value)} minLength={3} maxLength={255} required /></label><label className="field"><span>Peer capacity</span><input type="number" min="0" max="1000000" value={form.capacity_peers} onChange={(e) => set("capacity_peers", e.target.value)} required /></label>{node ? <><label className="field"><span>Inventory state</span><select value={form.status} onChange={(e) => { set("status", e.target.value); if (e.target.value === "disabled") set("enabled", false); }}><option value="offline">Offline</option><option value="maintenance">Maintenance</option><option value="disabled">Disabled</option></select></label><label className="toggle-field"><span><strong>Enabled for assignment</strong><small>Agent health remains independent.</small></span><input type="checkbox" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} /></label></> : <label className="field field-span"><span>WireGuard public key</span><input value={form.public_key} onChange={(e) => set("public_key", e.target.value)} minLength={44} maxLength={44} required /></label>}</div>
      <label className="field"><span>Reason (required)</span><textarea value={form.reason} onChange={(e) => set("reason", e.target.value)} minLength={8} maxLength={500} required rows={2} /></label>
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy}>{busy ? "Saving…" : "Save node"}</button></div>
    </form></div>
  );
}

function NodesPage({ refresh, admin, onAction, onRefresh }: { refresh: number; admin: Admin; onAction: (action: ActionDialogState) => void; onRefresh: (message: string) => void }) {
  const result = useResource<{ items: NodeRecord[]; online_status_source: string }>("/nodes", refresh);
  const [editing, setEditing] = useState<NodeRecord | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const canWrite = admin.role === "admin" || admin.role === "superadmin";
  async function save(value: Record<string, unknown>) {
    setBusy(true);
    try {
      await adminApi(editing ? `/nodes/${editing.id}` : "/nodes", { method: editing ? "PATCH" : "POST", body: jsonBody(value) });
      setEditing(undefined);
      onRefresh("Node inventory saved.");
    } catch (error) {
      onAction({ title: "Node was not saved", description: error instanceof Error ? error.message : "Request failed.", endpoint: "", payload: {}, readOnly: true });
    } finally { setBusy(false); }
  }
  return <>
    <PageHeading eyebrow="NETWORK / INVENTORY" title="VPN nodes" description="Inventory and agent-reported status. The agent is not deployed by this panel." action={canWrite ? <button className="primary-button" onClick={() => setEditing(null)}><Plus size={16} /> Register node</button> : undefined} />
    <div className="notice notice-warning"><Network size={16} /> Node health is not connected to an authenticated agent yet. No node is represented as online by this console.</div>
    <section className="section-panel table-panel">{result.loading && !result.data ? <LoadingLine /> : result.error ? <ErrorNotice message={result.error} /> : result.data?.items.length ? <DataTable headers={["Node", "Location", "Endpoint", "State", "Peers", "Traffic", "Last report", ""]}>{result.data.items.map((node) => <tr key={node.id}><td><strong>{node.name}</strong><small>{node.hostname}</small></td><td>{node.country_code} · {node.region}{node.city ? ` · ${node.city}` : ""}</td><td><code>{node.public_endpoint}</code></td><td><StatusBadge value={node.status} /><small>{node.enabled ? "Assignment enabled" : "Assignment disabled"}</small></td><td>{node.current_peers} / {node.capacity_peers}</td><td>{formatBytes(node.reported_traffic_bytes)}</td><td>{formatDate(node.last_seen_at)}</td><td>{canWrite && <button className="text-button" onClick={() => setEditing(node)}>Edit</button>}</td></tr>)}</DataTable> : <EmptyState title="No VPN nodes" detail="Registering a node does not deploy an agent or make it available for connection." />}</section>
    {editing !== undefined && <NodeDialog node={editing} busy={busy} onClose={() => setEditing(undefined)} onSave={save} />}
  </>;
}

function SessionsPage({ refresh, onSelect }: { refresh: number; onSelect: (id: string) => void }) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const path = useMemo(() => `/sessions?page=1&pageSize=50${query ? `&search=${encodeURIComponent(query)}` : ""}`, [query]);
  const result = useResource<{ items: Array<Record<string, string | null>>; page: number; page_size: number }>(path, refresh);
  return <>
    <PageHeading eyebrow="OPERATIONS / ACCESS" title="User sessions" description="Review active and expired sessions; revoke a session from its account detail." />
    <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); setQuery(search.trim()); }}><label className="search-field"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Account email or device" /></label><button className="secondary-button"><Search size={15} /> Search</button></form>
    <section className="section-panel table-panel">{result.loading && !result.data ? <LoadingLine /> : result.error ? <ErrorNotice message={result.error} /> : result.data?.items.length ? <DataTable headers={["Account", "Device", "State", "Issued", "Last used", "Expires", ""]}>{result.data.items.map((session) => <tr key={session.id}><td><strong>{session.username}</strong><small>{session.email}</small></td><td>{session.device_name}<small>{session.device_id}</small></td><td><StatusBadge value={session.status} /></td><td>{formatDate(session.issued_at)}</td><td>{formatDate(session.last_used_at)}</td><td>{formatDate(session.expires_at)}</td><td><button className="text-button" onClick={() => onSelect(String(session.user_id))}>Account</button></td></tr>)}</DataTable> : <EmptyState title="No sessions found" detail="Try a different search or check back after users sign in." />}</section>
  </>;
}

function PaymentsPage({ refresh }: { refresh: number }) {
  const [status, setStatus] = useState("");
  const path = useMemo(() => `/payments?page=1&pageSize=50${status ? `&status=${status}` : ""}`, [status]);
  const result = useResource<{ items: Array<Record<string, string | null>>; total: number; provider_writes_enabled: boolean }>(path, refresh);
  return <>
    <PageHeading eyebrow="PRODUCT / BILLING" title="Payments" description="Backend payment records only. Provider verification and refunds are not connected." />
    <div className="filter-bar"><label className="field compact-field"><span>Payment state</span><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All states</option>{["pending", "authorized", "paid", "failed", "refunded", "cancelled"].map((value) => <option key={value} value={value}>{titleCase(value)}</option>)}</select></label><span className="muted">{result.data?.total ?? 0} records</span></div>
    <section className="section-panel table-panel">{result.loading && !result.data ? <LoadingLine /> : result.error ? <ErrorNotice message={result.error} /> : result.data?.items.length ? <DataTable headers={["Account", "Provider", "Amount", "State", "Created", "Paid", "Reference"]}>{result.data.items.map((item) => <tr key={item.id}><td><strong>{item.email}</strong><small>{item.user_id}</small></td><td>{item.provider || "—"}</td><td>{formatMoney(item.amount_irr, item.currency || "IRR")}</td><td><StatusBadge value={item.status} /></td><td>{formatDate(item.created_at)}</td><td>{formatDate(item.paid_at)}</td><td>{item.failure_code || "—"}</td></tr>)}</DataTable> : <EmptyState title="No payment records" detail="Nothing is reported as paid without a Backend record." />}</section>
  </>;
}

function SecurityPage({ refresh, admin }: { refresh: number; admin: Admin }) {
  const [tab, setTab] = useState<"audit" | "logins">("audit");
  const sensitive = admin.role === "superadmin";
  const path = tab === "logins" && sensitive ? "/security/logins?page=1&pageSize=50" : "/audit?page=1&pageSize=50";
  const result = useResource<{ items: Array<Record<string, string | null>>; page: number; page_size: number }>(path, refresh);
  return <>
    <PageHeading eyebrow="SECURITY / OVERSIGHT" title="Audit & access" description="Administrative changes include the actor, reason and request reference." />
    <div className="tab-strip" role="tablist"><button role="tab" aria-selected={tab === "audit"} className={tab === "audit" ? "selected" : ""} onClick={() => setTab("audit")}>Audit trail</button>{sensitive && <button role="tab" aria-selected={tab === "logins"} className={tab === "logins" ? "selected" : ""} onClick={() => setTab("logins")}>Admin sign-ins</button>}</div>
    <section className="section-panel table-panel">{result.loading && !result.data ? <LoadingLine /> : result.error ? <ErrorNotice message={result.error} /> : result.data?.items.length ? tab === "audit" ? <DataTable headers={["When", "Operator", "Role", "Action", "Target", "Reason", "Request"]}>{result.data.items.map((entry) => <tr key={entry.id}><td>{formatDate(entry.created_at)}</td><td>{entry.admin_email}</td><td><StatusBadge value={entry.admin_role} /></td><td><strong>{entry.action}</strong></td><td>{entry.resource_type}<small>{entry.resource_id}</small></td><td className="reason-cell">{entry.reason || "—"}</td><td><code>{entry.request_id}</code></td></tr>)}</DataTable> : <DataTable headers={["When", "Email", "Outcome", "Request"]}>{result.data.items.map((entry) => <tr key={entry.id}><td>{formatDate(entry.created_at)}</td><td>{entry.email_normalized}</td><td><StatusBadge value={entry.outcome} /></td><td><code>{entry.request_id}</code></td></tr>)}</DataTable> : <EmptyState title={tab === "audit" ? "No audit entries" : "No sign-in events"} detail="Recorded events will appear here." />}</section>
  </>;
}

type ProviderRecord = { provider: "sms.ir" | "zarinpal"; credentials_saved: boolean; masked_metadata: Record<string, string>; enabled: boolean; adapter_available: boolean; updated_at?: string | null };

function ProviderCredentialDialog({ provider, busy, onClose, onSave }: { provider: ProviderRecord["provider"]; busy: boolean; onClose: () => void; onSave: (credentials: Record<string, string>, reason: string) => void }) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  return <div className="modal-backdrop"><form className="modal" role="dialog" aria-modal="true" onSubmit={(event) => { event.preventDefault(); onSave({ [key]: value }, reason); }}><div className="modal-head"><div><span className="eyebrow">SECRET STORAGE</span><h2>Rotate {provider} credentials</h2></div><button className="icon-button" type="button" title="Close" onClick={onClose}><X size={17} /></button></div><div className="notice notice-warning">The adapter is unavailable. Credentials are encrypted for storage only; this does not enable delivery or payments.</div><label className="field"><span>Credential name</span><input value={key} onChange={(e) => setKey(e.target.value)} pattern="[A-Za-z][A-Za-z0-9_]{0,39}" required /></label><label className="field"><span>New secret</span><input type="password" value={value} onChange={(e) => setValue(e.target.value)} minLength={1} maxLength={2048} autoComplete="new-password" required /></label><label className="field"><span>Reason (required)</span><textarea value={reason} onChange={(e) => setReason(e.target.value)} minLength={8} maxLength={500} required rows={2} /></label><div className="modal-actions"><button className="secondary-button" type="button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy}>{busy ? "Encrypting…" : "Save encrypted secret"}</button></div></form></div>;
}

function ProvidersPage({ refresh, admin, onAction, onRefresh }: { refresh: number; admin: Admin; onAction: (action: ActionDialogState) => void; onRefresh: (message: string) => void }) {
  const result = useResource<ProviderRecord[]>("/providers", refresh);
  const [editing, setEditing] = useState<ProviderRecord["provider"] | null>(null);
  const [busy, setBusy] = useState(false);
  async function save(credentials: Record<string, string>, reason: string) {
    if (!editing) return;
    setBusy(true);
    try {
      await adminApi(`/providers/${encodeURIComponent(editing)}/credentials`, { method: "PUT", body: jsonBody({ credentials, reason }) });
      setEditing(null);
      onRefresh("Encrypted credential metadata saved. Provider remains inactive.");
    } catch (error) {
      onAction({ title: "Credentials were not saved", description: error instanceof Error ? error.message : "Request failed.", endpoint: "", payload: {}, readOnly: true });
    } finally { setBusy(false); }
  }
  return <>
    <PageHeading eyebrow="SECURITY / INTEGRATIONS" title="Integrations" description="Provider readiness is shown honestly. No external SMS or payment adapter is active." />
    <div className="notice notice-warning"><Shield size={16} /> Saving a secret stores it encrypted on the Backend. It does not turn on a provider integration.</div>
    <div className="provider-grid">{result.loading && !result.data ? <LoadingLine /> : result.error ? <ErrorNotice message={result.error} /> : (result.data || []).map((provider) => <section className="section-panel provider-panel" key={provider.provider}><div className="provider-head"><span className="provider-symbol">{provider.provider === "sms.ir" ? "SMS" : "Z"}</span><div><h2>{provider.provider}</h2><small>{provider.credentials_saved ? "Credential metadata stored" : "No credentials stored"}</small></div><StatusBadge value={provider.adapter_available ? "available" : "not connected"} /></div><div className="provider-meta"><span><small>Adapter</small>{provider.adapter_available ? "Available" : "Not implemented"}</span><span><small>Enabled</small>{provider.enabled ? "Yes" : "No"}</span><span><small>Last updated</small>{formatDate(provider.updated_at)}</span></div>{Object.entries(provider.masked_metadata).map(([name, mask]) => <div className="secret-row" key={name}><span>{name}</span><code>{mask}</code></div>)}{admin.role === "superadmin" && <button className="secondary-button" onClick={() => setEditing(provider.provider)}><Shield size={15} /> Rotate secret</button>}</section>)}</div>
    {editing && <ProviderCredentialDialog provider={editing} busy={busy} onClose={() => setEditing(null)} onSave={save} />}
  </>;
}

type AdminAccount = { id: string; email: string; role: Admin["role"]; status: "active" | "disabled"; mfa_enabled: boolean; last_login_at?: string | null; created_at: string; active_sessions: string };

function AdminCreateDialog({ busy, onClose, onSave }: { busy: boolean; onClose: () => void; onSave: (value: Record<string, unknown>) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Admin["role"]>("support");
  const [reason, setReason] = useState("");
  return <div className="modal-backdrop"><form className="modal" role="dialog" aria-modal="true" onSubmit={(event) => { event.preventDefault(); onSave({ email, password, role, reason }); }}><div className="modal-head"><div><span className="eyebrow">ACCESS CONTROL</span><h2>Add Admin account</h2></div><button className="icon-button" type="button" title="Close" onClick={onClose}><X size={17} /></button></div><label className="field"><span>Email</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={320} /></label><label className="field"><span>Temporary password</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={16} maxLength={128} autoComplete="new-password" required /><small className="field-hint">At least 16 characters. Share it through a secure channel and rotate it after first sign-in.</small></label><label className="field"><span>Role</span><select value={role} onChange={(e) => setRole(e.target.value as Admin["role"])}><option value="support">Support</option><option value="read_only">Read only</option><option value="admin">Admin</option><option value="superadmin">Superadmin</option></select></label><label className="field"><span>Reason (required)</span><textarea value={reason} onChange={(e) => setReason(e.target.value)} minLength={8} maxLength={500} required rows={2} /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy}>{busy ? "Creating…" : "Create Admin"}</button></div></form></div>;
}

function AdminsPage({ refresh, admin, onAction, onRefresh }: { refresh: number; admin: Admin; onAction: (action: ActionDialogState) => void; onRefresh: (message: string) => void }) {
  const result = useResource<AdminAccount[]>("/admins", refresh);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  async function create(value: Record<string, unknown>) {
    setBusy(true);
    try { await adminApi("/admins", { method: "POST", body: jsonBody(value) }); setCreating(false); onRefresh("Admin account created."); }
    catch (error) { onAction({ title: "Admin account was not created", description: error instanceof Error ? error.message : "Request failed.", endpoint: "", payload: {}, readOnly: true }); }
    finally { setBusy(false); }
  }
  function change(account: AdminAccount, key: "role" | "status", value: string) {
    onAction({ title: `Update ${account.email}`, description: `Change ${key} to ${titleCase(value)}. This operation is recorded in the audit trail.`, endpoint: `/admins/${account.id}`, payload: { [key]: value } });
  }
  const isSuperadmin = admin.role === "superadmin";
  return <>
    <PageHeading eyebrow="SECURITY / ACCESS CONTROL" title="Admin accounts" description="Separate operator identities and least-privilege roles." action={isSuperadmin ? <button className="primary-button" onClick={() => setCreating(true)}><Plus size={16} /> Add Admin</button> : undefined} />
    <div className="notice notice-info"><Shield size={16} /> Multi-factor authentication enrollment is not implemented yet. Use unique credentials and restrict access to this panel.</div>
    <section className="section-panel table-panel">{result.loading && !result.data ? <LoadingLine /> : result.error ? <ErrorNotice message={result.error} /> : result.data?.length ? <DataTable headers={["Administrator", "Role", "State", "MFA", "Last sign-in", "Sessions", ""]}>{result.data.map((account) => <tr key={account.id}><td><strong>{account.email}</strong><small>Created {formatDate(account.created_at)}</small></td><td><StatusBadge value={account.role} /></td><td><StatusBadge value={account.status} /></td><td><StatusBadge value={account.mfa_enabled ? "enabled" : "not enrolled"} /></td><td>{formatDate(account.last_login_at)}</td><td>{account.active_sessions}</td><td>{isSuperadmin && account.id !== admin.id && <div className="row-actions"><select aria-label={`Role for ${account.email}`} value={account.role} onChange={(e) => change(account, "role", e.target.value)}><option value="superadmin">Superadmin</option><option value="admin">Admin</option><option value="support">Support</option><option value="read_only">Read only</option></select><select aria-label={`Status for ${account.email}`} value={account.status} onChange={(e) => change(account, "status", e.target.value)}><option value="active">Active</option><option value="disabled">Disabled</option></select><button className="text-button" onClick={() => onAction({ title: "Revoke Admin sessions", description: `Sign out ${account.email} on all devices.`, endpoint: `/admins/${account.id}/revoke-sessions`, payload: {} })}>Revoke sessions</button></div>}</td></tr>)}</DataTable> : <EmptyState title="No Admin accounts" detail="Create the first operator after running the one-time server bootstrap." />}</section>
    {creating && <AdminCreateDialog busy={busy} onClose={() => setCreating(false)} onSave={create} />}
  </>;
}

function App() {
  const [admin, setAdmin] = useState<Admin | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [view, setView] = useState<View>("overview");
  const [selectedUser, setSelectedUser] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [action, setAction] = useState<ActionDialogState | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [mobileNav, setMobileNav] = useState(false);

  useEffect(() => {
    let current = true;
    adminApi<Admin>("/auth/me").then((value) => { if (current) setAdmin(value); }).catch(() => undefined).finally(() => { if (current) setCheckingSession(false); });
    return () => { current = false; };
  }, []);

  useEffect(() => {
    const expire = () => setAdmin(null);
    window.addEventListener("hc-admin-session-expired", expire);
    return () => window.removeEventListener("hc-admin-session-expired", expire);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  function refreshPage(message?: string) {
    setRefresh((value) => value + 1);
    if (message) setToast(message);
  }

  async function confirmAction(reason: string) {
    if (!action || action.readOnly) { setAction(null); return; }
    setBusy(true);
    try {
      const payload = { ...action.payload, reason };
      const method = action.endpoint.endsWith("/revoke-sessions") && action.payload.readonly ? "POST" : action.endpoint.includes("/admins/") && ("role" in action.payload || "status" in action.payload) ? "PATCH" : "POST";
      await adminApi(action.endpoint, { method, body: jsonBody(payload) });
      setAction(null);
      refreshPage("Change saved and added to the audit trail.");
      if (view === "user-detail") setView("user-detail");
    } catch (error) {
      setAction({ title: "Operation was not completed", description: error instanceof Error ? error.message : "Request failed.", endpoint: "", payload: {}, readOnly: true });
    } finally { setBusy(false); }
  }

  async function signOut() {
    try { await adminApi("/auth/logout", { method: "POST", body: "{}" }); }
    finally { setAdmin(null); setView("overview"); setSelectedUser(""); }
  }

  if (checkingSession) return <div className="session-check"><LoadingLine /><span>Checking secure Admin session</span></div>;
  if (!admin) return <Login onLogin={setAdmin} />;
  const visibleGroups = navGroups.map((group) => ({ ...group, items: group.items.filter((item) => hasRoleAccess(admin.role, item.access)) })).filter((group) => group.items.length > 0);
  const currentItem = navGroups.flatMap((group) => group.items).find((item) => item.id === view);
  const titles: Record<View, string> = { overview: "Overview", alerts: "Alerts", traffic: "Traffic usage", users: "Users", "user-detail": "Account detail", sessions: "Sessions", plans: "Plans", subscriptions: "Subscriptions", nodes: "VPN nodes", payments: "Payments", security: "Audit & access", providers: "Integrations", admins: "Admin accounts" };
  function navigate(next: View) { setView(next); setMobileNav(false); }

  return <div className={`admin-shell ${mobileNav ? "nav-open" : ""}`}>
    <aside className="sidebar">
      <div className="brand-lockup"><div className="brand-mark">H</div><div><strong>HOAXCONNECT</strong><small>OPERATIONS</small></div></div>
      <div className="workspace-tag"><span className="workspace-dot" /> ADMIN CONSOLE</div>
      <nav aria-label="Admin navigation">{visibleGroups.map((group) => <div className="nav-group" key={group.label}><span className="nav-label">{group.label}</span>{group.items.map((item) => { const Icon = item.icon; const selected = view === item.id || (view === "user-detail" && item.id === "users"); return <button className={`nav-item ${selected ? "active" : ""}`} key={item.id} onClick={() => navigate(item.id as View)}><Icon size={17} /><span>{item.label}</span>{selected && <span className="nav-current" />}</button>; })}</div>)}</nav>
      <div className="sidebar-bottom"><div className="sidebar-security"><Shield size={16} /><span><strong>Protected session</strong><small>Changes are audited</small></span></div><button className="nav-item signout-button" onClick={() => void signOut()}><LogOut size={17} /><span>Sign out</span></button></div>
    </aside>
    {mobileNav && <button className="nav-scrim" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}
    <main className="main-area">
      <header className="topbar"><button className="icon-button mobile-menu" title="Open navigation" onClick={() => setMobileNav((value) => !value)}><Menu size={19} /></button><div className="breadcrumbs"><span>HoaxConnect</span><ChevronRight size={14} /><strong>{view === "user-detail" ? "Users" : currentItem?.label || titles[view]}</strong>{view === "user-detail" && <><ChevronRight size={14} /><strong>Account</strong></>}</div><div className="topbar-right"><button className="icon-button" title="Refresh current view" onClick={() => refreshPage()}><RefreshCw size={16} /></button><div className="admin-identity"><span className="avatar">{admin.email.slice(0, 1).toUpperCase()}</span><span><strong>{admin.email}</strong><small>{titleCase(admin.role)}</small></span><ChevronDown size={14} /></div></div></header>
      <div className="content-area">
        {view === "overview" && <OverviewPage refresh={refresh} onNavigate={navigate} />}
        {view === "alerts" && <AlertsPage refresh={refresh} />}
        {view === "traffic" && <TrafficPage refresh={refresh} />}
        {view === "users" && <UsersPage refresh={refresh} onSelect={(id) => { setSelectedUser(id); navigate("user-detail"); }} />}
        {view === "user-detail" && <UserDetailPage userId={selectedUser} refresh={refresh} admin={admin} onBack={() => navigate("users")} onAction={setAction} />}
        {view === "sessions" && <SessionsPage refresh={refresh} onSelect={(id) => { setSelectedUser(id); navigate("user-detail"); }} />}
        {view === "plans" && <PlansPage refresh={refresh} admin={admin} onAction={setAction} onRefresh={refreshPage} />}
        {view === "subscriptions" && <SubscriptionsPage refresh={refresh} admin={admin} onAction={setAction} onRefresh={refreshPage} />}
        {view === "nodes" && <NodesPage refresh={refresh} admin={admin} onAction={setAction} onRefresh={refreshPage} />}
        {view === "payments" && <PaymentsPage refresh={refresh} />}
        {view === "security" && <SecurityPage refresh={refresh} admin={admin} />}
        {view === "providers" && <ProvidersPage refresh={refresh} admin={admin} onAction={setAction} onRefresh={refreshPage} />}
        {view === "admins" && <AdminsPage refresh={refresh} admin={admin} onAction={setAction} onRefresh={refreshPage} />}
      </div>
      <footer className="app-footer"><span>HoaxConnect Admin</span><span>Signed in as {admin.email}</span></footer>
    </main>
    {action && <ActionDialog action={action} busy={busy} onClose={() => setAction(null)} onConfirm={(reason) => void confirmAction(reason)} />}
    {toast && <div className="toast" role="status"><Check size={16} />{toast}<button className="icon-button" title="Dismiss" onClick={() => setToast("")}><X size={15} /></button></div>}
  </div>;
}

export default App;
