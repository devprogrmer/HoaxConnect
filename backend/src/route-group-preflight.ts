export type InventoryNode = {
  id: string;
  country_code: string;
  status: string;
  enabled: boolean;
  last_seen_at: Date | string | null;
  public_endpoint: string | null;
  public_key: string | null;
  tunnel_cidr: string | null;
  listen_port: number | null;
};
export type RouteInventory = {
  gateway_node_id: string;
  entry_node_ids: string[];
  nodes: InventoryNode[];
};

function cidrRange(cidr: string): [number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d|[12]\d|3[0-2])$/.exec(cidr);
  if (!match) return null;
  const octets = match.slice(1, 5).map(Number);
  if (octets.some((n) => n > 255)) return null;
  const ip = (((octets[0]! << 24) >>> 0) + (octets[1]! << 16) +
    (octets[2]! << 8) + octets[3]!) >>> 0;
  const mask = Number(match[5]) === 0 ? 0 : (0xffffffff << (32 - Number(match[5]))) >>> 0;
  return [(ip & mask) >>> 0, ((ip & mask) | (~mask >>> 0)) >>> 0];
}

export function inspectRouteInventory(input: RouteInventory, now = Date.now()) {
  const byId = new Map(input.nodes.map((node) => [node.id, node]));
  const ids = [input.gateway_node_id, ...input.entry_node_ids];
  const findings: Array<{ node_id: string; code: string }> = [];
  const ranges: Array<{ id: string; start: number; end: number }> = [];
  for (const id of ids) {
    const node = byId.get(id);
    if (!node) { findings.push({ node_id: id, code: "NODE_MISSING" }); continue; }
    const expected = id === input.gateway_node_id ? "TR" : "IR";
    if (node.country_code !== expected) findings.push({ node_id: id, code: "WRONG_COUNTRY" });
    if (!node.enabled || node.status !== "online" ||
        !node.last_seen_at || !Number.isFinite(new Date(node.last_seen_at).getTime()) ||
        now - new Date(node.last_seen_at).getTime() >= 90_000 ||
        now < new Date(node.last_seen_at).getTime() - 300_000) {
      findings.push({ node_id: id, code: "NODE_NOT_HEALTHY" });
    }
    if (!node.public_endpoint || !node.public_key || !node.listen_port) {
      findings.push({ node_id: id, code: "NODE_ENDPOINT_MISSING" });
    }
    const range = node.tunnel_cidr ? cidrRange(node.tunnel_cidr) : null;
    if (!range) findings.push({ node_id: id, code: "CLIENT_CIDR_MISSING" });
    else ranges.push({ id, start: range[0], end: range[1] });
  }
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      if (ranges[i]!.start <= ranges[j]!.end && ranges[j]!.start <= ranges[i]!.end) {
        findings.push({ node_id: ranges[j]!.id, code: "CLIENT_CIDR_OVERLAP" });
      }
    }
  }
  return {
    inventory_ready: ids.length > 1 && new Set(ids).size === ids.length && findings.length === 0,
    transport_ready: false,
    findings,
  };
}
