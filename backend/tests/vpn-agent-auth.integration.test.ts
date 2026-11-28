import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { test } from "node:test";

const databaseUrl = process.env.HC_STAGE5_TEST_DATABASE_URL;

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function canonicalRequest(
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  body: unknown,
) {
  const digest = createHash("sha256").update(stableJson(body)).digest("hex");
  return `HC-VPN-AGENT-V1\n${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${digest}`;
}

test(
  "VPN node enrollment and signed heartbeats reject replay and invalid identities",
  { skip: !databaseUrl },
  async () => {
    const database = new URL(databaseUrl!);
    const databaseName = decodeURIComponent(database.pathname.slice(1));
    if (
      !["localhost", "127.0.0.1", "::1"].includes(database.hostname) ||
      !/(^|[-_])test($|[-_])/i.test(databaseName)
    ) {
      throw new Error(
        "Stage 5 integration tests require a loopback PostgreSQL database with 'test' in its name.",
      );
    }

    Object.assign(process.env, {
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      DATABASE_SSL: "false",
      LOG_LEVEL: "silent",
      JWT_ACCESS_SECRET: "a".repeat(128),
      JWT_ISSUER: "https://api.hoaxconnect.test",
      JWT_AUDIENCE: "hoaxconnect-desktop",
      REFRESH_TOKEN_PEPPER: "b".repeat(128),
      REFRESH_RECOVERY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    });

    await import("../src/migrate.js");
    const [{ buildApp }, { pool }, { createVpnNodeEnrollmentToken }] = await Promise.all([
      import("../src/app.js"),
      import("../src/db.js"),
      import("../src/vpn-node-bootstrap.js"),
    ]);
    const app = await buildApp();
    const nodeIds: string[] = [];
    let groupId: string | null = null;

    try {
      const node = await pool.query<{ id: string }>(
        `INSERT INTO vpn_nodes (
           name, country_code, region, hostname, public_endpoint, public_key,
           capacity_peers, tunnel_cidr, listen_port
         ) VALUES ($1, 'DE', 'test', $2, '198.51.100.20:51820', $3, 100,
                   '10.88.0.0/24', 51820)
         RETURNING id`,
        [`agent-${randomUUID()}`, `agent-${randomUUID()}.example.test`, `pending-${randomUUID()}`],
      );
      const nodeId = node.rows[0]!.id;
      nodeIds.push(nodeId);

      const enrollment = await createVpnNodeEnrollmentToken(nodeId, 10);
      const enrollmentToken = enrollment.token;
      const tokenHash = createHash("sha256").update(enrollmentToken).digest("hex");
      assert.ok(Date.parse(enrollment.expiresAt) > Date.now());

      const keys = generateKeyPairSync("ed25519");
      const publicKeySpki = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
      const enrolledResponse = await app.inject({
        method: "POST",
        url: "/api/v1/vpn-agent/enroll",
        payload: {
          node_id: nodeId,
          enrollment_token: enrollmentToken,
          public_key_spki: publicKeySpki,
        },
      });
      assert.equal(enrolledResponse.statusCode, 201, enrolledResponse.body);
      const enrolled = enrolledResponse.json().data as {
        node_id: string;
        credential_id: string;
        fingerprint_sha256: string;
      };
      assert.equal(enrolled.node_id, nodeId);
      assert.match(enrolled.credential_id, /^[0-9a-f-]{36}$/);
      assert.match(enrolled.fingerprint_sha256, /^[0-9a-f]{64}$/);
      assert.doesNotMatch(enrolledResponse.body, new RegExp(enrollmentToken));

      const storedToken = await pool.query(
        `SELECT token_hash, used_at FROM vpn_node_enrollment_tokens
         WHERE vpn_node_id = $1`,
        [nodeId],
      );
      assert.equal(storedToken.rows[0].token_hash, tokenHash);
      assert.notEqual(storedToken.rows[0].token_hash, enrollmentToken);
      assert.ok(storedToken.rows[0].used_at);

      const reused = await app.inject({
        method: "POST",
        url: "/api/v1/vpn-agent/enroll",
        payload: {
          node_id: nodeId,
          enrollment_token: enrollmentToken,
          public_key_spki: publicKeySpki,
        },
      });
      assert.equal(reused.statusCode, 401, reused.body);
      assert.equal(reused.json().error.code, "VPN_NODE_ENROLLMENT_INVALID");
      assert.doesNotMatch(reused.body, new RegExp(enrollmentToken));

      const heartbeat = {
        agent_version: "0.1.0",
        public_endpoint: "198.51.100.20:51820",
        public_key: `${"A".repeat(43)}=`,
        capacity_peers: 100,
        current_peers: 3,
        load_percent: 12.5,
      };
      const path = "/api/v1/vpn-agent/heartbeat";
      const signedHeaders = (options: {
        nonce?: string;
        timestamp?: number;
        nodeId?: string;
        privateKey?: typeof keys.privateKey;
      } = {}) => {
        const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
        const nonce = options.nonce ?? randomBytes(18).toString("base64url");
        const signature = sign(
          null,
          Buffer.from(canonicalRequest("POST", path, timestamp, nonce, heartbeat)),
          options.privateKey ?? keys.privateKey,
        ).toString("base64");
        return {
          "x-hc-node-id": options.nodeId ?? nodeId,
          "x-hc-credential-id": enrolled.credential_id,
          "x-hc-timestamp": timestamp,
          "x-hc-nonce": nonce,
          "x-hc-signature": signature,
        };
      };

      const acceptedHeaders = signedHeaders({ nonce: "accepted_nonce_1234567890" });
      const accepted = await app.inject({
        method: "POST", url: path, headers: acceptedHeaders, payload: heartbeat,
      });
      assert.equal(accepted.statusCode, 200, accepted.body);
      assert.equal(accepted.json().data.status, "online");
      const storedNode = await pool.query(
        `SELECT status::text, agent_version, load_percent::float,
                public_endpoint, public_key, capacity_peers, current_peers,
                last_seen_at
         FROM vpn_nodes WHERE id = $1`,
        [nodeId],
      );
      assert.equal(storedNode.rows[0].status, "online");
      assert.equal(storedNode.rows[0].agent_version, heartbeat.agent_version);
      assert.equal(storedNode.rows[0].load_percent, heartbeat.load_percent);
      assert.ok(storedNode.rows[0].last_seen_at);

      await pool.query("UPDATE vpn_nodes SET country_code = 'IR' WHERE id = $1", [nodeId]);
      const gateway = await pool.query<{ id: string }>(
        `INSERT INTO vpn_nodes (name, country_code, region, hostname, public_endpoint,
           public_key, capacity_peers, tunnel_cidr, listen_port)
         VALUES ($1, 'TR', 'test', $2, '198.51.100.30:51820',
           $3, 100, '10.89.0.0/24', 51820) RETURNING id`,
        [`gateway-${randomUUID()}`, `gateway-${randomUUID()}.example.test`,
          randomBytes(32).toString("base64")],
      );
      nodeIds.push(gateway.rows[0]!.id);
      const group = await pool.query<{ id: string }>(
        "INSERT INTO vpn_route_groups(name, gateway_node_id) VALUES ($1, $2) RETURNING id",
        [`link-${randomUUID()}`, gateway.rows[0]!.id],
      );
      groupId = group.rows[0]!.id;
      await pool.query(
        "INSERT INTO vpn_route_group_entries(group_id, entry_node_id, priority) VALUES ($1, $2, 1)",
        [groupId, nodeId],
      );
      const signedPost = async (route: string, payload: unknown) => {
        const timestamp = String(Math.floor(Date.now() / 1000));
        const nonce = randomBytes(18).toString("base64url");
        return app.inject({ method: "POST", url: route, payload, headers: {
          "x-hc-node-id": nodeId,
          "x-hc-credential-id": enrolled.credential_id,
          "x-hc-timestamp": timestamp,
          "x-hc-nonce": nonce,
          "x-hc-signature": sign(null,
            Buffer.from(canonicalRequest("POST", route, timestamp, nonce, payload)),
            keys.privateKey).toString("base64"),
        } });
      };
      const desired = await signedPost("/api/v1/vpn-agent/desired-state", {});
      assert.equal(desired.statusCode, 200, desired.body);
      assert.deepEqual(desired.json().data.route_group_drafts,
        [{ group_id: groupId, config_version: "1" }]);
      const routeKeyPayload = { group_id: groupId, config_version: "1",
        public_key: randomBytes(32).toString("base64") };
      const published = await signedPost("/api/v1/vpn-agent/route-group-key", routeKeyPayload);
      assert.equal(published.statusCode, 200, published.body);
      const saved = await pool.query(
        "SELECT public_key, config_version::text FROM vpn_route_group_node_keys WHERE group_id = $1 AND node_id = $2",
        [groupId, nodeId],
      );
      assert.equal(saved.rows[0].public_key, routeKeyPayload.public_key);
      const changedKey = await signedPost("/api/v1/vpn-agent/route-group-key",
        { ...routeKeyPayload, public_key: randomBytes(32).toString("base64") });
      assert.equal(changedKey.statusCode, 409, changedKey.body);
      await pool.query("UPDATE vpn_route_groups SET config_version = 2 WHERE id = $1", [groupId]);
      const staleVersion = await signedPost("/api/v1/vpn-agent/route-group-key", routeKeyPayload);
      assert.equal(staleVersion.statusCode, 409, staleVersion.body);
      const renewed = await signedPost("/api/v1/vpn-agent/route-group-key",
        { ...routeKeyPayload, config_version: "2" });
      assert.equal(renewed.statusCode, 200, renewed.body);
      await pool.query(`UPDATE vpn_nodes SET enabled = true, status = 'online',
        last_seen_at = now() WHERE id = ANY($1::uuid[])`, [[nodeId, gateway.rows[0]!.id]]);
      await pool.query(`UPDATE vpn_route_groups SET link_cidr = '10.253.73.0/24',
        link_port = 51830, phase = 'staging', staged_at = now()
        WHERE id = $1`, [groupId]);
      await pool.query(`INSERT INTO vpn_route_group_node_keys(group_id,node_id,config_version,public_key)
        VALUES ($1,$2,2,$3)`, [groupId, gateway.rows[0]!.id, randomBytes(32).toString("base64")]);
      const stagedDesired = await signedPost("/api/v1/vpn-agent/desired-state", {});
      assert.equal(stagedDesired.statusCode, 200, stagedDesired.body);
      const routeGroup = stagedDesired.json().data.route_groups[0];
      assert.equal(routeGroup.phase, "staging");
      assert.equal(routeGroup.role, "entry");
      assert.equal(routeGroup.link_address, "10.253.73.2/24");
      assert.equal(routeGroup.peers[0].client_cidr, "10.88.0.0/24");
      const report = await signedPost("/api/v1/vpn-agent/route-group-report", {
        group_id: groupId, config_version: "2", healthy: true, detail: "probe-ok" });
      assert.equal(report.statusCode, 200, report.body);
      const staleReport = await signedPost("/api/v1/vpn-agent/route-group-report", {
        group_id: groupId, config_version: "1", healthy: true, detail: "stale" });
      assert.equal(staleReport.statusCode, 409, staleReport.body);

      const replay = await app.inject({
        method: "POST", url: path, headers: acceptedHeaders, payload: heartbeat,
      });
      assert.equal(replay.statusCode, 409, replay.body);
      assert.equal(replay.json().error.code, "VPN_AGENT_REQUEST_REPLAYED");

      const wrongKeys = generateKeyPairSync("ed25519");
      const invalidSignature = await app.inject({
        method: "POST", url: path,
        headers: signedHeaders({ privateKey: wrongKeys.privateKey }), payload: heartbeat,
      });
      assert.equal(invalidSignature.statusCode, 401, invalidSignature.body);
      assert.equal(invalidSignature.json().error.code, "VPN_AGENT_AUTHENTICATION_FAILED");

      for (const timestamp of [
        Math.floor(Date.now() / 1000) - 301,
        Math.floor(Date.now() / 1000) + 301,
      ]) {
        const response = await app.inject({
          method: "POST", url: path,
          headers: signedHeaders({ timestamp }), payload: heartbeat,
        });
        assert.equal(response.statusCode, 401, response.body);
        assert.equal(response.json().error.code, "VPN_AGENT_REQUEST_EXPIRED");
      }

      const wrongNode = await app.inject({
        method: "POST", url: path,
        headers: signedHeaders({ nodeId: randomUUID() }), payload: heartbeat,
      });
      assert.equal(wrongNode.statusCode, 401, wrongNode.body);
      assert.equal(wrongNode.json().error.code, "VPN_AGENT_AUTHENTICATION_FAILED");

      await pool.query(
        `UPDATE vpn_node_credentials
         SET status = 'revoked', revoked_at = now(), revoke_reason = 'test'
         WHERE id = $1`,
        [enrolled.credential_id],
      );
      const revoked = await app.inject({
        method: "POST", url: path, headers: signedHeaders(), payload: heartbeat,
      });
      assert.equal(revoked.statusCode, 401, revoked.body);
      assert.equal(revoked.json().error.code, "VPN_AGENT_AUTHENTICATION_FAILED");
      assert.doesNotMatch(revoked.body, /signature|private|enrollment_token/i);
    } finally {
      if (groupId) await pool.query("DELETE FROM vpn_route_groups WHERE id = $1", [groupId]);
      if (nodeIds.length) {
        await pool.query("DELETE FROM vpn_nodes WHERE id = ANY($1::uuid[])", [nodeIds]);
      }
      await app.close();
      await pool.end();
    }
  },
);
