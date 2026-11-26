using System.Security.Cryptography;
using HoaxConnect.Service.Core;
using HoaxConnect.Service.Platform.Windows;
using HoaxConnect.Service.Protocol;
using HoaxConnect.Service.Security;

namespace HoaxConnect.Service.Tests;

public sealed class SingBoxTunnelPlatformTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), $"hc-engine-{Guid.NewGuid():N}");
    private readonly string _engine;
    private readonly string _supportLibrary;
    private readonly string _state;

    public SingBoxTunnelPlatformTests()
    {
        Directory.CreateDirectory(_root);
        _engine = Path.Combine(_root, "sing-box.exe");
        _supportLibrary = Path.Combine(_root, "libcronet.dll");
        _state = Path.Combine(_root, "state");
        File.WriteAllBytes(_engine, [1, 2, 3, 4]);
        File.WriteAllBytes(_supportLibrary, [5, 6, 7, 8]);
    }

    [Fact]
    public async Task VerifiesEngineChecksConfigThenStartsAndCleansOwnedState()
    {
        var host = new FakeProcessHost();
        var platform = Create(host, Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(_engine))));

        await platform.ConnectAsync(Request(), CancellationToken.None);

        Assert.Equal(["check", "start"], host.Calls);
        Assert.True(File.Exists(Path.Combine(_state, "active.json")));
        Assert.Contains("process_path", await File.ReadAllTextAsync(Path.Combine(_state, "active.json")));

        await platform.DisconnectAsync("generation-1", CancellationToken.None);
        Assert.Equal("stop", host.Calls[^1]);
        Assert.False(File.Exists(Path.Combine(_state, "active.json")));
    }

    [Fact]
    public async Task RejectsTamperedEngineBeforeExecutingIt()
    {
        var host = new FakeProcessHost();
        var platform = Create(host, new string('0', 64));

        await Assert.ThrowsAsync<InvalidDataException>(() => platform.ConnectAsync(Request(), CancellationToken.None));

        Assert.Empty(host.Calls);
    }

    [Fact]
    public async Task RejectsTamperedSupportLibraryBeforeExecutingEngine()
    {
        var host = new FakeProcessHost();
        var platform = new SingBoxTunnelPlatform(
            _engine, Hash(_engine), _supportLibrary, new string('0', 64), _state,
            new FixedIdentityProvider(), host);

        await Assert.ThrowsAsync<InvalidDataException>(() => platform.ConnectAsync(Request(), CancellationToken.None));

        Assert.Empty(host.Calls);
    }

    [Fact]
    public async Task StartupCleanupStopsEngineAndDeletesStaleConfiguration()
    {
        Directory.CreateDirectory(_state);
        await File.WriteAllTextAsync(Path.Combine(_state, "active.json"), "secret");
        var host = new FakeProcessHost();
        var platform = Create(host, Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(_engine))));

        await platform.CleanupOwnedStateAsync(CancellationToken.None);

        Assert.Equal(["stop"], host.Calls);
        Assert.False(File.Exists(Path.Combine(_state, "active.json")));
    }

    private SingBoxTunnelPlatform Create(FakeProcessHost host, string hash) =>
        new(_engine, hash, _supportLibrary, Hash(_supportLibrary), _state, new FixedIdentityProvider(), host);

    private static string Hash(string path) =>
        Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)));

    private static ConnectRequest Request() => new(
        "generation-1", [@"C:\Games\Game.exe"],
        new TunnelAuthorization("198.51.100.20:51820", new string('B', 44), "10.88.0.2", ["1.1.1.1"], DateTimeOffset.UtcNow.AddMinutes(5)));

    public void Dispose() => Directory.Delete(_root, true);

    private sealed class FixedIdentityProvider : ITunnelIdentityProvider
    {
        public Task<TunnelIdentity> GetIdentityAsync(CancellationToken cancellationToken) =>
            Task.FromResult(new TunnelIdentity("public", new string('A', 44)));
    }

    private sealed class FakeProcessHost : ISingBoxProcessHost
    {
        public List<string> Calls { get; } = [];
        public Task CheckAsync(string executable, string configuration, CancellationToken cancellationToken) { Calls.Add("check"); return Task.CompletedTask; }
        public Task StartAsync(string executable, string configuration, CancellationToken cancellationToken) { Calls.Add("start"); return Task.CompletedTask; }
        public Task StopAsync(CancellationToken cancellationToken) { Calls.Add("stop"); return Task.CompletedTask; }
    }
}
