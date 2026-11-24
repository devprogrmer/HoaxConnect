using System.Net;
using System.Text.Json;
using HoaxConnect.Service.Core;
using HoaxConnect.Service.Security;

namespace HoaxConnect.Service.Platform.Windows;

public static class SingBoxConfigBuilder
{
    private static readonly JsonSerializerOptions Options = new() { WriteIndented = true };

    public static string Build(ConnectRequest request, TunnelIdentity identity)
    {
        var (host, port) = ParseEndpoint(request.Authorization.Endpoint);
        var assignedAddress = request.Authorization.AssignedAddress.Contains('/')
            ? request.Authorization.AssignedAddress
            : request.Authorization.AssignedAddress + (request.Authorization.AssignedAddress.Contains(':') ? "/128" : "/32");

        var config = new
        {
            log = new { level = "warn", timestamp = true },
            inbounds = new object[]
            {
                new
                {
                    type = "tun",
                    tag = "tun-in",
                    interface_name = "HoaxConnect",
                    address = new[] { "172.19.0.1/30", "fdfe:dcba:9876::1/126" },
                    mtu = 1400,
                    auto_route = true,
                    strict_route = false,
                    dns_mode = "disabled",
                }
            },
            endpoints = new object[]
            {
                new
                {
                    type = "wireguard",
                    tag = "wg",
                    system = false,
                    address = new[] { assignedAddress },
                    private_key = identity.PrivateKey,
                    peers = new object[]
                    {
                        new
                        {
                            address = host,
                            port,
                            public_key = request.Authorization.ServerPublicKey,
                            allowed_ips = new[] { "0.0.0.0/0", "::/0" },
                            persistent_keepalive_interval = 25,
                        }
                    }
                }
            },
            outbounds = new object[] { new { type = "direct", tag = "direct" } },
            route = new
            {
                auto_detect_interface = true,
                rules = new object[]
                {
                    new { process_path = request.ApplicationPaths, action = "route", outbound = "wg" },
                },
                final = "direct",
            },
        };
        return JsonSerializer.Serialize(config, Options);
    }

    private static (string Host, int Port) ParseEndpoint(string endpoint)
    {
        if (string.IsNullOrWhiteSpace(endpoint)) throw new InvalidDataException("Endpoint is required.");
        string host;
        string portText;
        if (endpoint.StartsWith('['))
        {
            var close = endpoint.IndexOf(']');
            if (close <= 1 || close + 2 >= endpoint.Length || endpoint[close + 1] != ':') throw new InvalidDataException("Endpoint is invalid.");
            host = endpoint[1..close];
            portText = endpoint[(close + 2)..];
        }
        else
        {
            var separator = endpoint.LastIndexOf(':');
            if (separator <= 0 || separator == endpoint.Length - 1) throw new InvalidDataException("Endpoint is invalid.");
            host = endpoint[..separator];
            portText = endpoint[(separator + 1)..];
            if (host.Contains(':')) throw new InvalidDataException("IPv6 endpoints must use brackets.");
        }
        if (!int.TryParse(portText, out var port) || port is < 1 or > 65535) throw new InvalidDataException("Endpoint port is invalid.");
        if (!IPAddress.TryParse(host, out _) && Uri.CheckHostName(host) == UriHostNameType.Unknown) throw new InvalidDataException("Endpoint host is invalid.");
        return (host, port);
    }
}
