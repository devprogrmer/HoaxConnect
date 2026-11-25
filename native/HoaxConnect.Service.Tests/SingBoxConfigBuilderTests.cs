using System.Text.Json;
using HoaxConnect.Service.Core;
using HoaxConnect.Service.Platform.Windows;
using HoaxConnect.Service.Security;

namespace HoaxConnect.Service.Tests;

public sealed class SingBoxConfigBuilderTests
{
    [Fact]
    public void RoutesOnlySelectedProcessesAndProtectsDnsOnWindows()
    {
        var request = new ConnectRequest(
            "generation-1",
            [@"C:\Games\One.exe", @"C:\Games\Two.exe"],
            new TunnelAuthorization("198.51.100.20:51820", new string('B', 44), "10.88.0.2", ["1.1.1.1"], DateTimeOffset.UtcNow.AddMinutes(5)));

        using var config = JsonDocument.Parse(SingBoxConfigBuilder.Build(request, new TunnelIdentity("public", new string('A', 44))));
        var root = config.RootElement;
        var tun = root.GetProperty("inbounds")[0];
        Assert.Equal("tun", tun.GetProperty("type").GetString());
        Assert.True(tun.GetProperty("auto_route").GetBoolean());
        Assert.True(tun.GetProperty("strict_route").GetBoolean());
        Assert.Equal("hijack", tun.GetProperty("dns_mode").GetString());

        var dns = root.GetProperty("dns");
        Assert.Equal("vpn-dns-0", dns.GetProperty("final").GetString());
        var dnsServer = Assert.Single(dns.GetProperty("servers").EnumerateArray());
        Assert.Equal("udp", dnsServer.GetProperty("type").GetString());
        Assert.Equal("1.1.1.1", dnsServer.GetProperty("server").GetString());
        Assert.Equal("wg", dnsServer.GetProperty("detour").GetString());

        var endpoint = root.GetProperty("endpoints")[0];
        Assert.Equal("wireguard", endpoint.GetProperty("type").GetString());
        Assert.Equal("10.88.0.2/32", endpoint.GetProperty("address")[0].GetString());
        Assert.Equal("198.51.100.20", endpoint.GetProperty("peers")[0].GetProperty("address").GetString());
        Assert.Equal(51820, endpoint.GetProperty("peers")[0].GetProperty("port").GetInt32());

        var route = root.GetProperty("route");
        Assert.True(route.GetProperty("auto_detect_interface").GetBoolean());
        Assert.Equal("direct", route.GetProperty("final").GetString());
        var rules = route.GetProperty("rules").EnumerateArray().ToArray();
        Assert.Equal(2, rules.Length);
        var dnsRule = rules[0];
        Assert.Equal("hijack-dns", dnsRule.GetProperty("action").GetString());
        Assert.Equal(53, dnsRule.GetProperty("port").GetInt32());
        var selectedRule = rules[1];
        Assert.Equal("wg", selectedRule.GetProperty("outbound").GetString());
        Assert.Equal(2, selectedRule.GetProperty("process_path").GetArrayLength());
    }

    [Theory]
    [InlineData("bad endpoint")]
    [InlineData("example.test:not-a-port")]
    [InlineData("example.test:0")]
    public void RejectsInvalidEndpoints(string endpoint)
    {
        var request = new ConnectRequest("g", [@"C:\Games\Game.exe"],
            new TunnelAuthorization(endpoint, new string('B', 44), "10.88.0.2", ["1.1.1.1"], DateTimeOffset.UtcNow.AddMinutes(5)));
        Assert.Throws<InvalidDataException>(() => SingBoxConfigBuilder.Build(request, new TunnelIdentity("public", new string('A', 44))));
    }
}
