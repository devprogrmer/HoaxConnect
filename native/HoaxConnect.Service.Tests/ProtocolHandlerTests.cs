using System.Text.Json;
using HoaxConnect.Service.Core;
using HoaxConnect.Service.Protocol;
using HoaxConnect.Service.Security;

namespace HoaxConnect.Service.Tests;

public sealed class ProtocolHandlerTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), $"hc-protocol-{Guid.NewGuid():N}");
    private readonly string _executable;

    public ProtocolHandlerTests()
    {
        Directory.CreateDirectory(_root);
        _executable = Path.Combine(_root, "Game.exe");
        File.WriteAllBytes(_executable, [0x4d, 0x5a]);
    }

    [Fact]
    public async Task ImplementsVersionedStatusIdentityConnectAndDisconnectContract()
    {
        var platform = new FakePlatform();
        var coordinator = new TunnelCoordinator(platform);
        await coordinator.InitializeAsync(CancellationToken.None);
        var handler = new ControlProtocolHandler(coordinator, new FixedIdentityProvider());

        var identity = await Send(handler, "identity", new { });
        Assert.True(identity.Ok);
        Assert.Equal("public-key", identity.Result.GetProperty("publicKey").GetString());

        var connected = await Send(handler, "connect", new
        {
            generation = "generation-1",
            applicationPaths = new[] { _executable },
            authorization = new
            {
                paths = new[]
                {
                    new { node = new { endpoint = "198.51.100.20:51820", public_key = new string('A', 44) },
                        client = new { assigned_ip = "10.88.0.2", dns_servers = new[] { "1.1.1.1" } },
                        lease_expires_at = "2030-01-01T00:05:00.000Z" },
                    new { node = new { endpoint = "198.51.100.21:51820", public_key = new string('B', 44) },
                        client = new { assigned_ip = "10.89.0.2", dns_servers = new[] { "1.1.1.1" } },
                        lease_expires_at = "2030-01-01T00:05:00.000Z" }
                }
            }
        });
        Assert.True(connected.Ok);
        Assert.Equal(Path.GetFullPath(_executable), platform.LastRequest!.ApplicationPaths[0]);

        var status = await Send(handler, "status", new { });
        Assert.Equal("connected", status.Result.GetProperty("status").GetString());

        var disconnected = await Send(handler, "disconnect", new { generation = "generation-1", reason = "test" });
        Assert.True(disconnected.Ok);
        Assert.Equal("idle", coordinator.Status.Status);
    }

    [Fact]
    public async Task RejectsUnknownVersionMethodAndInvalidPayloadWithoutLeakingDetails()
    {
        var coordinator = new TunnelCoordinator(new FakePlatform());
        await coordinator.InitializeAsync(CancellationToken.None);
        var handler = new ControlProtocolHandler(coordinator, new FixedIdentityProvider());

        var wrongVersion = await handler.HandleAsync(JsonSerializer.Serialize(new
        {
            version = 2, id = "request", method = "status", @params = new { }
        }), CancellationToken.None);
        Assert.False(wrongVersion.Ok);
        Assert.Equal("UNSUPPORTED_PROTOCOL", wrongVersion.Error!.Code);

        var unknown = await Send(handler, "run-command", new { command = "whoami" });
        Assert.False(unknown.Ok);
        Assert.Equal("UNKNOWN_METHOD", unknown.Error!.Code);

        var invalid = await Send(handler, "connect", new { generation = "g", applicationPaths = new[] { "relative.exe" } });
        Assert.False(invalid.Ok);
        Assert.Equal("INVALID_REQUEST", invalid.Error!.Code);
        Assert.DoesNotContain(_root, invalid.Error.Message);
    }

    private static async Task<ControlResponse> Send(ControlProtocolHandler handler, string method, object parameters)
    {
        var json = JsonSerializer.Serialize(new { version = 1, id = Guid.NewGuid().ToString(), method, @params = parameters });
        return await handler.HandleAsync(json, CancellationToken.None);
    }

    public void Dispose() => Directory.Delete(_root, true);

    private sealed class FixedIdentityProvider : ITunnelIdentityProvider
    {
        public Task<TunnelIdentity> GetIdentityAsync(CancellationToken cancellationToken) =>
            Task.FromResult(new TunnelIdentity("public-key", "private-key"));
    }

    private sealed class FakePlatform : ITunnelPlatform
    {
        public ConnectRequest? LastRequest { get; private set; }
        public Task CleanupOwnedStateAsync(CancellationToken cancellationToken) => Task.CompletedTask;
        public Task ConnectAsync(ConnectRequest request, CancellationToken cancellationToken) { LastRequest = request; return Task.CompletedTask; }
        public Task DisconnectAsync(string generation, CancellationToken cancellationToken) => Task.CompletedTask;
    }
}
