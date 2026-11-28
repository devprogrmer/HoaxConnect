const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createVpnApi,
} = require("../vpn-api.cjs");

const CLIENT_KEY = `${"A".repeat(43)}=`;
const SERVER_KEY = `${"B".repeat(43)}=`;

test("VPN API authorizes a validated client key and location preference", async () => {
  const requests = [];
  const api = createVpnApi({
    requestAuthenticated: async (pathname, payload) => {
      requests.push({ pathname, payload });
      return {
        vpn_session_id: "0f865bb8-1022-4e46-bf03-fd826cc3a918",
        node: {
          id: "8bc490e1-e832-4cf4-9913-37bbcdf63b2c",
          endpoint: "198.51.100.20:51820",
          public_key: SERVER_KEY,
        },
        client: {
          assigned_ip: "10.88.0.2",
          dns_servers: ["1.1.1.1"],
        },
        lease_expires_at: "2030-01-01T00:05:00.000Z",
      };
    },
  });

  const result = await api.authorize({
    clientPublicKey: CLIENT_KEY,
    countryCode: "DE",
    region: "Frankfurt",
  });

  assert.equal(result.node.endpoint, "198.51.100.20:51820");
  assert.deepEqual(requests, [{
    pathname: "/api/v1/vpn/authorize",
    payload: {
      client_public_key: CLIENT_KEY,
      country_code: "DE",
      region: "Frankfurt",
    },
  }]);
});

test("VPN API rejects invalid keys and invalid Backend leases", async () => {
  const never = async () => assert.fail("request must not be sent");
  const api = createVpnApi({ requestAuthenticated: never });

  await assert.rejects(
    api.authorize({ clientPublicKey: "not-a-wireguard-key" }),
    /valid WireGuard public key/,
  );

  const invalid = createVpnApi({
    requestAuthenticated: async () => ({
      vpn_session_id: "session",
      node: { id: "node", endpoint: "bad", public_key: SERVER_KEY },
      client: { assigned_ip: "10.88.0.2", dns_servers: [] },
      lease_expires_at: "not-a-date",
    }),
  });

  await assert.rejects(
    invalid.authorize({ clientPublicKey: CLIENT_KEY }),
    /invalid VPN authorization/,
  );
});

test("VPN API disconnect uses the authenticated Backend route", async () => {
  const requests = [];
  const api = createVpnApi({
    requestAuthenticated: async (pathname, payload) => {
      requests.push({ pathname, payload });
      return { disconnected: true };
    },
  });

  assert.deepEqual(await api.disconnect(), { disconnected: true });
  assert.deepEqual(requests, [{
    pathname: "/api/v1/vpn/disconnect",
    payload: {},
  }]);
});

test("VPN API validates and requests two independent Iran entry paths", async () => {
  const requests = [];
  const api = createVpnApi({ requestAuthenticated: async (pathname, payload) => {
    requests.push({ pathname, payload });
    const path = (id, endpoint, address) => ({ vpn_session_id: `session-${id}`,
      node: { id, endpoint, public_key: SERVER_KEY },
      client: { assigned_ip: address, dns_servers: ["1.1.1.1"] },
      lease_expires_at: "2030-01-01T00:05:00.000Z" });
    return { connection_group_id: "group", paths: [
      path("iran-a", "198.51.100.20:51820", "10.88.0.2"),
      path("iran-b", "198.51.100.21:51820", "10.89.0.2")],
      lease_expires_at: "2030-01-01T00:05:00.000Z" };
  } });
  const result = await api.authorizeMulti({ clientPublicKey: CLIENT_KEY, pathCount: 2 });
  assert.equal(result.paths.length, 2);
  assert.deepEqual(requests, [{ pathname: "/api/v1/vpn/authorize-multi",
    payload: { client_public_key: CLIENT_KEY, path_count: 2 } }]);
});

test("VPN API lists validated live Backend nodes", async () => {
  const requests = [];
  const api = createVpnApi({
    requestAuthenticated: async (pathname, payload) => {
      requests.push({ pathname, payload });
      return { nodes: [{
        id: "8bc490e1-e832-4cf4-9913-37bbcdf63b2c",
        name: "Germany #01",
        country_code: "DE",
        region: "fra",
        city: "Frankfurt",
        capacity_peers: 100,
        current_peers: 25,
        load_percent: 25,
      }] };
    },
  });

  assert.equal((await api.nodes())[0].load_percent, 25);
  assert.deepEqual(requests, [{
    pathname: "/api/v1/vpn/nodes",
    payload: {},
  }]);
});

test("VPN API rejects malformed Backend node lists", async () => {
  const api = createVpnApi({
    requestAuthenticated: async () => ({ nodes: [{ id: "node", load_percent: 150 }] }),
  });
  await assert.rejects(api.nodes(), /invalid VPN node list/);
});

