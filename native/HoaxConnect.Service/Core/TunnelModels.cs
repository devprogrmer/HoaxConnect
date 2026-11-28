using System.Text.Json.Serialization;

namespace HoaxConnect.Service.Core;

public sealed record TunnelAuthorization(
    string Endpoint,
    string ServerPublicKey,
    string AssignedAddress,
    IReadOnlyList<string> DnsServers,
    DateTimeOffset LeaseExpiresAt);

public sealed record ConnectRequest(
    string Generation,
    IReadOnlyList<string> ApplicationPaths,
    IReadOnlyList<TunnelAuthorization> Authorizations)
{
    public DateTimeOffset LeaseExpiresAt => Authorizations.Min(item => item.LeaseExpiresAt);
}

public sealed record TunnelStatus(
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("generation")] string? Generation,
    [property: JsonPropertyName("leaseExpiresAt")] DateTimeOffset? LeaseExpiresAt,
    [property: JsonPropertyName("errorCode")] string? ErrorCode = null);

public interface ITunnelPlatform
{
    Task CleanupOwnedStateAsync(CancellationToken cancellationToken);
    Task ConnectAsync(ConnectRequest request, CancellationToken cancellationToken);
    Task DisconnectAsync(string generation, CancellationToken cancellationToken);
}

public sealed class StaleGenerationException : InvalidOperationException
{
    public StaleGenerationException() : base("A stale tunnel generation was rejected.") { }
}
