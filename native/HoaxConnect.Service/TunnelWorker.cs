using HoaxConnect.Service.Core;
using HoaxConnect.Service.Protocol;
using Microsoft.Extensions.Hosting;

namespace HoaxConnect.Service;

public sealed class TunnelWorker(TunnelCoordinator coordinator, NamedPipeControlServer server) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await coordinator.InitializeAsync(stoppingToken);
        await server.RunAsync(stoppingToken);
    }
}
