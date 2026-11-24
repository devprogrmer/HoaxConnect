using HoaxConnect.Service.Core;

namespace HoaxConnect.Service.Tests;

public sealed class TunnelCoordinatorTests
{
    [Fact]
    public async Task StartupAlwaysCleansOwnedStateBeforeBecomingReady()
    {
        var platform = new FakePlatform();
        var coordinator = new TunnelCoordinator(platform);

        await coordinator.InitializeAsync(CancellationToken.None);

        Assert.Equal(["cleanup"], platform.Calls);
        Assert.Equal("idle", coordinator.Status.Status);
    }

    [Fact]
    public async Task DuplicateGenerationIsIdempotentAndStaleGenerationIsRejected()
    {
        var platform = new FakePlatform();
        var coordinator = new TunnelCoordinator(platform);
        await coordinator.InitializeAsync(CancellationToken.None);
        var request = Request("generation-b");

        await coordinator.ConnectAsync(request, CancellationToken.None);
        await coordinator.ConnectAsync(request, CancellationToken.None);

        Assert.Single(platform.Calls, call => call == "connect:generation-b");
        await Assert.ThrowsAsync<StaleGenerationException>(() =>
            coordinator.ConnectAsync(Request("generation-a"), CancellationToken.None));
        await Assert.ThrowsAsync<StaleGenerationException>(() =>
            coordinator.ConnectAsync(Request("generation-z"), CancellationToken.None));
    }

    [Fact]
    public async Task FailedAttemptDoesNotBlockNewUnorderedGeneration()
    {
        var platform = new FakePlatform { FailNextConnect = true };
        var coordinator = new TunnelCoordinator(platform);
        await coordinator.InitializeAsync(CancellationToken.None);

        await Assert.ThrowsAsync<IOException>(() =>
            coordinator.ConnectAsync(Request("generation-z"), CancellationToken.None));

        await coordinator.ConnectAsync(Request("generation-a"), CancellationToken.None);
        Assert.Equal("connected", coordinator.Status.Status);
        Assert.Equal("generation-a", coordinator.Status.Generation);
    }

    [Fact]
    public async Task DisconnectIsIdempotentAndIgnoresOlderGeneration()
    {
        var platform = new FakePlatform();
        var coordinator = new TunnelCoordinator(platform);
        await coordinator.InitializeAsync(CancellationToken.None);
        await coordinator.ConnectAsync(Request("generation-b"), CancellationToken.None);

        await coordinator.DisconnectAsync("generation-a", CancellationToken.None);
        Assert.Equal("connected", coordinator.Status.Status);
        await coordinator.DisconnectAsync("generation-b", CancellationToken.None);
        await coordinator.DisconnectAsync("generation-b", CancellationToken.None);

        Assert.Single(platform.Calls, call => call == "disconnect:generation-b");
        Assert.Equal("idle", coordinator.Status.Status);
    }

    [Fact]
    public async Task LeaseExpiryDisconnectsInsideServiceEvenIfElectronIsGone()
    {
        var platform = new FakePlatform();
        var coordinator = new TunnelCoordinator(platform);
        await coordinator.InitializeAsync(CancellationToken.None);
        var request = Request("generation-expiring") with
        {
            Authorization = Request("generation-expiring").Authorization with
            {
                LeaseExpiresAt = DateTimeOffset.UtcNow.AddMilliseconds(80)
            }
        };

        await coordinator.ConnectAsync(request, CancellationToken.None);
        await Task.Delay(250);

        Assert.Contains("disconnect:generation-expiring", platform.Calls);
        Assert.Equal("error", coordinator.Status.Status);
        Assert.Equal("LEASE_EXPIRED", coordinator.Status.ErrorCode);
    }

    private static ConnectRequest Request(string generation) => new(
        generation,
        [@"C:\\Games\\Game.exe"],
        new TunnelAuthorization("vpn.example.test:51820", new string('A', 44), "10.7.0.2/32", ["1.1.1.1"], DateTimeOffset.UtcNow.AddMinutes(5)));

    private sealed class FakePlatform : ITunnelPlatform
    {
        public List<string> Calls { get; } = [];
        public Task CleanupOwnedStateAsync(CancellationToken cancellationToken) { Calls.Add("cleanup"); return Task.CompletedTask; }
        public bool FailNextConnect { get; set; }
        public Task ConnectAsync(ConnectRequest request, CancellationToken cancellationToken)
        {
            Calls.Add($"connect:{request.Generation}");
            if (!FailNextConnect) return Task.CompletedTask;
            FailNextConnect = false;
            return Task.FromException(new IOException("Simulated tunnel startup failure."));
        }
        public Task DisconnectAsync(string generation, CancellationToken cancellationToken) { Calls.Add($"disconnect:{generation}"); return Task.CompletedTask; }
    }
}
