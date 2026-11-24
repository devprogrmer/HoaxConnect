namespace HoaxConnect.Service.Core;

public sealed class TunnelCoordinator(ITunnelPlatform platform)
{
    private readonly SemaphoreSlim _gate = new(1, 1);
    private TunnelStatus _status = new("starting", null, null);
    private CancellationTokenSource? _leaseCancellation;

    public TunnelStatus Status => _status;

    public async Task InitializeAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            await platform.CleanupOwnedStateAsync(cancellationToken);
            _status = new("idle", null, null);
        }
        finally { _gate.Release(); }
    }

    public async Task ConnectAsync(ConnectRequest request, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(request.Generation)) throw new InvalidDataException("Generation is required.");
        await _gate.WaitAsync(cancellationToken);
        try
        {
            if (_status.Generation == request.Generation && _status.Status == "connected") return;
            // Connection IDs are opaque UUIDs. Never replace a live tunnel with
            // another request until the current owner disconnects it.
            if (_status.Status == "connected")
                throw new StaleGenerationException();

            _status = new("connecting", request.Generation, request.Authorization.LeaseExpiresAt);
            try
            {
                await platform.ConnectAsync(request, cancellationToken);
                _status = new("connected", request.Generation, request.Authorization.LeaseExpiresAt);
                ScheduleLeaseExpiry(request.Generation, request.Authorization.LeaseExpiresAt);
            }
            catch
            {
                await platform.CleanupOwnedStateAsync(CancellationToken.None);
                _status = new("error", request.Generation, null, "TUNNEL_START_FAILED");
                throw;
            }
        }
        finally { _gate.Release(); }
    }

    public async Task DisconnectAsync(string? generation, CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            if (_status.Generation is null || _status.Status == "idle") return;
            if (!string.Equals(generation, _status.Generation, StringComparison.Ordinal)) return;
            var active = _status.Generation;
            CancelLeaseExpiry();
            _status = new("disconnecting", active, null);
            await platform.DisconnectAsync(active, cancellationToken);
            _status = new("idle", null, null);
        }
        finally { _gate.Release(); }
    }

    private void ScheduleLeaseExpiry(string generation, DateTimeOffset expiresAt)
    {
        CancelLeaseExpiry();
        var cancellation = new CancellationTokenSource();
        _leaseCancellation = cancellation;
        _ = ExpireLeaseAsync(generation, expiresAt, cancellation.Token);
    }

    private async Task ExpireLeaseAsync(string generation, DateTimeOffset expiresAt, CancellationToken cancellationToken)
    {
        try
        {
            while (expiresAt > DateTimeOffset.UtcNow)
            {
                var remaining = expiresAt - DateTimeOffset.UtcNow;
                await Task.Delay(remaining > TimeSpan.FromHours(12) ? TimeSpan.FromHours(12) : remaining, cancellationToken);
            }
            await _gate.WaitAsync(cancellationToken);
            try
            {
                if (_status.Status != "connected" || _status.Generation != generation) return;
                await platform.DisconnectAsync(generation, CancellationToken.None);
                _status = new("error", null, null, "LEASE_EXPIRED");
                _leaseCancellation?.Dispose();
                _leaseCancellation = null;
            }
            finally { _gate.Release(); }
        }
        catch (OperationCanceledException) { }
        catch
        {
            _status = new("error", generation, null, "LEASE_CLEANUP_FAILED");
        }
    }

    private void CancelLeaseExpiry()
    {
        var cancellation = Interlocked.Exchange(ref _leaseCancellation, null);
        if (cancellation is null) return;
        cancellation.Cancel();
        cancellation.Dispose();
    }
}
