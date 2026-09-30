export {};

declare global {
  interface HoaxPingResult {
    target: string;
    sent: number;
    received: number;
    lost: number;
    packetLossPct: number;
    minMs: number | null;
    maxMs: number | null;
    averageMs: number | null;
    jitterMs: number;
    samples: number[];
    reachable: boolean;
  }

  interface HoaxDiagnosticResult {
    target: string;
    ping: HoaxPingResult;

    publicIp: string | null;
    publicIpError: string | null;

    dnsServers: string[];

    system: {
      platform: string;
      release: string;
      arch: string;
    };

    testedAt: string;
  }

  interface HoaxTCPResult {
    target: string;
    port: number;
    reachable: boolean;
    latencyMs: number;
    error: string | null;
  }

  interface HoaxTracerouteResult {
    target: string;
    raw: string;
    lines: string[];
  }

  interface HoaxGameCandidate {
    ip: string;
    port: number;
    protocol: "TCP" | "UDP";
    packets: number;
    source: string;
    score: number;
  }

  interface HoaxDetectedGame {
    id: string;
    name: string;

    processes: Array<{
      name: string;
      pid: number;
    }>;
  }

  interface HoaxGameScanResult {
    detected: boolean;
    reason: string;

    game: HoaxDetectedGame | null;

    server: null | {
      ip: string;
      port: number;

      protocol:
        | "TCP"
        | "UDP";

      source: string;

      confidence:
        | "high"
        | "medium"
        | "low"
        | "none";
    };

    candidates:
      HoaxGameCandidate[];

    network?: {
      tcpConnections: number;
      udpLocalPorts: number[];
    };

    packetCapture?: {
      attempted: boolean;
      ok: boolean;
      error: string | null;
    };

    measurement: null | {
      method:
        | "ICMP"
        | "TCP"
        | "endpoint-detection";

      latencyMs:
        number | null;

      jitterMs:
        number | null;

      packetLossPct:
        number | null;

      icmpReachable:
        boolean;
    };
  }

  type HoaxUpdateStatus =
    | "idle"
    | "checking"
    | "available"
    | "up-to-date"
    | "downloading"
    | "downloaded"
    | "error"
    | "dev";

  interface HoaxUpdateState {
    status: HoaxUpdateStatus;

    currentVersion: string;

    availableVersion:
      string | null;

    percent: number;

    bytesPerSecond: number;

    transferred: number;

    total: number;

    error: string | null;
  }

  interface HoaxInstalledApp {
    id: string;

    name: string;

    exeName: string;

    path: string;

    source: string;

    running: boolean;

    icon:
      | string
      | null;
  }

  type HoaxSplitMode =
    | "selected-only"
    | "all"
    | "exclude-selected";

  interface HoaxSplitApp {
    id: string;
    name: string;
    exeName: string;
    path: string;
    source: string;
  }

  interface HoaxSplitTunnelState {
    mode: HoaxSplitMode;

    selectedApps:
      HoaxSplitApp[];

    updatedAt:
      | string
      | null;
  }

  interface HoaxDoctorProcess {
    id: string;
    pid: number;

    name: string;
    exeName: string;
    path: string;

    tcpConnections: number;
    udpEndpoints: number;
    totalConnections: number;

    remoteEndpoints: string[];

    icon:
      | string
      | null;
  }

  interface HoaxDoctorActivity {
    adapter: {
      found: boolean;
      alias: string;
      description: string;
      interfaceIndex: number;
      interfaceGuid: string;
      ipv4: string;
      gateway: string;
      dnsServers: string[];
      staticNameServer: string;
      dhcpNameServer: string;
    };

    downloadBytesPerSecond: number;
    uploadBytesPerSecond: number;

    downloadMbps: number;
    uploadMbps: number;

    totalReceivedBytes: number;
    totalSentBytes: number;

    discardedPackets: number;

    processes:
      HoaxDoctorProcess[];

    measuredAt: string;
  }

  interface HoaxDNSResult {
    id: string;
    name: string;

    servers: string[];

    averageMs:
      | number
      | null;

    successfulQueries: number;

    failures: number;

    score: number;
  }

  interface HoaxDNSBenchmark {
    currentServers: string[];

    results:
      HoaxDNSResult[];

    recommended:
      | HoaxDNSResult
      | null;

    testedAt: string;
  }

  interface HoaxDNSState {
    adapter: {
      found: boolean;
      alias: string;
      interfaceIndex: number;
      dnsServers: string[];
    };

    canRestore: boolean;
  }


  interface HoaxDiagnosticsConsent {
    enabled: boolean;

    shareGameDetection: boolean;
    shareAppUsage: boolean;
    shareNetworkQuality: boolean;
    shareDomains: boolean;

    acceptedAt:
      | string
      | null;

    updatedAt:
      | string
      | null;
  }

  interface HoaxDiagnosticProcess {
    pid: number;
    name: string;
    path: string;
    connections: number;
  }

  interface HoaxDiagnosticEndpoint {
    pid: number;
    processName: string;
    protocol: string;
    remoteAddress: string;
    remotePort: number;
  }

  interface HoaxDiagnosticHostname {
    address: string;
    hostname: string;
  }

  interface HoaxDiagnosticsSnapshot {
    enabled: boolean;

    collectedAt: string;

    consent?:
      HoaxDiagnosticsConsent;

    processes:
      HoaxDiagnosticProcess[];

    endpoints:
      HoaxDiagnosticEndpoint[];

    hostnames:
      HoaxDiagnosticHostname[];
  }


  interface HoaxTrafficHealth {
    available: boolean;

    avgPingMs:
      | number
      | null;

    jitterMs:
      | number
      | null;

    packetLossPct:
      | number
      | null;

    checkedAt:
      | string
      | null;
  }

  interface HoaxTrafficProcess {
    pid: number;

    name: string;
    path: string;

    rxMbps: number;
    txMbps: number;

    tcpRxMbps: number;
    tcpTxMbps: number;

    udpRxMbps: number;
    udpTxMbps: number;

    rxTotal: number;
    txTotal: number;

    bandwidthSharePct: number;
    downloadSharePct: number;
    uploadSharePct: number;

    impactLevel:
      | "low"
      | "medium"
      | "high";

    verdict: string;
    reason: string;

    isGame: boolean;
    canEnd: boolean;
  }

  interface HoaxTrafficSnapshot {
    status: string;

    error?:
      | string
      | null;

    collectedAt:
      | string
      | null;

    health:
      HoaxTrafficHealth;

    totalRxMbps: number;
    totalTxMbps: number;

    processes:
      HoaxTrafficProcess[];
  }

  interface HoaxTrafficEndResult {
    success: boolean;

    pid: number;
    processName: string;

    before:
      HoaxTrafficHealth;

    after:
      HoaxTrafficHealth;

    pingImprovementMs:
      | number
      | null;

    jitterImprovementMs:
      | number
      | null;

    lossImprovementPct:
      | number
      | null;

    improved: boolean;
  }

  interface HoaxAuthResult {
    ok: true;
    state: {
      status: "authenticated" | "signed_out" | "restore_required";
      user: {
        id: string;
        email: string;
        phone: string | null;
        username: string;
        role: string;
        status: string;
        email_verified: boolean;
        phone_verified: boolean;
      } | null;
      device: {
        id: string;
        device_uid: string;
        name: string;
        platform: string;
        os_version: string;
        architecture: string;
        client_version: string;
        revoked: boolean;
        banned: boolean;
      } | null;
    };
    verificationRequired?: boolean;
  }

  interface HoaxAuthFailure {
    ok: false;
    error: {
      code: string;
      message: string;
    };
  }

  type HoaxAuthResponse = HoaxAuthResult | HoaxAuthFailure;

  interface HoaxAuthSignOutSuccess {
    ok: true;
    state: HoaxAuthResult["state"];
    remoteRevoked: boolean;
    warning?: {
      code: string;
      message: string;
    };
  }

  type HoaxAuthSignOutResponse =
    | HoaxAuthSignOutSuccess
    | HoaxAuthFailure;

  interface HoaxAPI {
    auth: {
      getState(): Promise<HoaxAuthResponse>;
      login(input: {
        identifier: string;
        password: string;
      }): Promise<HoaxAuthResponse>;
      register(input: {
        email: string;
        phone: string;
        username: string;
        password: string;
      }): Promise<HoaxAuthResponse>;
      restore(): Promise<HoaxAuthResponse>;
      logout(): Promise<HoaxAuthSignOutResponse>;
      logoutAll(): Promise<HoaxAuthSignOutResponse>;
    };
    isDesktop: boolean;

    platform: string;

    version: string;

    apps: {
      list():
        Promise<
          HoaxInstalledApp[]
        >;

      addManual():
        Promise<
          HoaxInstalledApp
          | null
        >;
    };

    splitTunnel: {
      get():
        Promise<
          HoaxSplitTunnelState
        >;

      save(
        state:
          HoaxSplitTunnelState
      ):
        Promise<
          HoaxSplitTunnelState
        >;
    };

    doctor: {
      activity():
        Promise<
          HoaxDoctorActivity
        >;

      health():
        Promise<
          HoaxDiagnosticResult
        >;

      dnsState():
        Promise<
          HoaxDNSState
        >;

      benchmarkDNS():
        Promise<
          HoaxDNSBenchmark
        >;

      applyDNS(
        servers: string[]
      ):
        Promise<
          HoaxDNSState
        >;

      restoreDNS():
        Promise<
          HoaxDNSState
        >;

      endProcess(
        pid: number
      ):
        Promise<{
          ok: boolean;
          pid: number;
          name: string;
        }>;
    };

    traffic: {
      doctorSnapshot():
        Promise<
          HoaxTrafficSnapshot
        >;

      endAndMeasure(
        pid: number
      ):
        Promise<
          HoaxTrafficEndResult
        >;
    };

    diagnostics: {
      getConsent():
        Promise<
          HoaxDiagnosticsConsent
        >;

      setConsent(
        value:
          HoaxDiagnosticsConsent
      ):
        Promise<
          HoaxDiagnosticsConsent
        >;

      snapshot():
        Promise<
          HoaxDiagnosticsSnapshot
        >;
    };

    network: {
      ping(
        target: string,
        count?: number
      ): Promise<HoaxPingResult>;

      diagnostic(
        target?: string
      ): Promise<HoaxDiagnosticResult>;

      publicIP():
        Promise<string>;

      tcpProbe(
        target: string,
        port: number
      ): Promise<HoaxTCPResult>;

      traceroute(
        target: string
      ): Promise<HoaxTracerouteResult>;
    };

    game: {
      scan():
        Promise<HoaxGameScanResult>;
    };

    updater: {
      getState():
        Promise<HoaxUpdateState>;

      check():
        Promise<HoaxUpdateState>;

      download():
        Promise<HoaxUpdateState>;

      install():
        Promise<{
          ok: boolean;
        }>;

      onStatus(
        callback: (
          state: HoaxUpdateState
        ) => void
      ): () => void;
    };
  }

  interface Window {
    hoax?: HoaxAPI;
  }
}
