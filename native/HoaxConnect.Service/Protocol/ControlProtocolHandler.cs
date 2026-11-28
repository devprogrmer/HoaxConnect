using System.Text.Json;
using System.Text.Json.Serialization;
using HoaxConnect.Service.Core;
using HoaxConnect.Service.Security;
using Microsoft.Extensions.Logging;

namespace HoaxConnect.Service.Protocol;

public sealed record ControlError(
    [property: JsonPropertyName("code")] string Code,
    [property: JsonPropertyName("message")] string Message);
public sealed record ControlResponse(
    [property: JsonPropertyName("version")] int Version,
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("ok")] bool Ok,
    [property: JsonPropertyName("result")] JsonElement Result,
    [property: JsonPropertyName("error")] ControlError? Error)
{
    public static ControlResponse Success(string id, object value) => new(1, id, true, JsonSerializer.SerializeToElement(value), null);
    public static ControlResponse Failure(string id, string code, string message) => new(1, id, false, JsonSerializer.SerializeToElement(new { }), new(code, message));
}

public interface ITunnelIdentityProvider
{
    Task<TunnelIdentity> GetIdentityAsync(CancellationToken cancellationToken);
}

public sealed class ControlProtocolHandler(TunnelCoordinator coordinator, ITunnelIdentityProvider identities, ILogger<ControlProtocolHandler>? logger = null)
{
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };

    public async Task<ControlResponse> HandleAsync(string json, CancellationToken cancellationToken)
    {
        ControlRequest? request;
        try { request = JsonSerializer.Deserialize<ControlRequest>(json, JsonOptions); }
        catch (JsonException) { return ControlResponse.Failure("", "INVALID_REQUEST", "The request is invalid."); }
        if (request is null || string.IsNullOrWhiteSpace(request.Id))
            return ControlResponse.Failure("", "INVALID_REQUEST", "The request is invalid.");
        if (request.Version != 1)
            return ControlResponse.Failure(request.Id, "UNSUPPORTED_PROTOCOL", "The protocol version is not supported.");

        try
        {
            return request.Method switch
            {
                "status" => ControlResponse.Success(request.Id, coordinator.Status),
                "identity" => ControlResponse.Success(request.Id, await Identity(cancellationToken)),
                "connect" => await Connect(request, cancellationToken),
                "disconnect" => await Disconnect(request, cancellationToken),
                _ => ControlResponse.Failure(request.Id, "UNKNOWN_METHOD", "The requested method is not supported."),
            };
        }
        catch (Exception error) when (error is InvalidDataException or FormatException or JsonException)
        {
            return ControlResponse.Failure(request.Id, "INVALID_REQUEST", "The request is invalid.");
        }
        catch (StaleGenerationException)
        {
            return ControlResponse.Failure(request.Id, "STALE_GENERATION", "The tunnel request is stale.");
        }
        catch (Exception error)
        {
            logger?.LogError(error, "Tunnel control request {Method} failed", request.Method);
            return ControlResponse.Failure(request.Id, "SERVICE_FAILURE", "The tunnel service could not complete the request.");
        }
    }

    private async Task<object> Identity(CancellationToken cancellationToken)
    {
        var identity = await identities.GetIdentityAsync(cancellationToken);
        return new { publicKey = identity.PublicKey };
    }

    private async Task<ControlResponse> Connect(ControlRequest request, CancellationToken cancellationToken)
    {
        var input = request.Params.Deserialize<ConnectInput>(JsonOptions) ?? throw new InvalidDataException();
        var paths = ExecutablePathValidator.Validate(input.ApplicationPaths);
        var authorization = input.Authorization ?? throw new InvalidDataException();
        if (authorization.Paths is not { Count: >= 2 and <= 5 }) throw new InvalidDataException();
        var tunnelAuthorizations = authorization.Paths.Select(item =>
        {
            var node = item.Node ?? throw new InvalidDataException();
            var client = item.Client ?? throw new InvalidDataException();
            if (!DateTimeOffset.TryParse(item.LeaseExpiresAt, out var lease)) throw new InvalidDataException();
            return new TunnelAuthorization(Required(node.Endpoint), Required(node.PublicKey),
                Required(client.AssignedIp), client.DnsServers is { Count: > 0 }
                    ? client.DnsServers : throw new InvalidDataException(), lease);
        }).ToArray();
        await coordinator.ConnectAsync(new ConnectRequest(Required(input.Generation), paths, tunnelAuthorizations), cancellationToken);
        return ControlResponse.Success(request.Id, coordinator.Status);
    }

    private async Task<ControlResponse> Disconnect(ControlRequest request, CancellationToken cancellationToken)
    {
        var input = request.Params.Deserialize<DisconnectInput>(JsonOptions) ?? throw new InvalidDataException();
        await coordinator.DisconnectAsync(input.Generation, cancellationToken);
        return ControlResponse.Success(request.Id, coordinator.Status);
    }

    private static string Required(string? value) =>
        !string.IsNullOrWhiteSpace(value) ? value : throw new InvalidDataException();

    private sealed record ControlRequest(int Version, string Id, string Method, JsonElement Params);
    private sealed record ConnectInput(string Generation, IReadOnlyList<string> ApplicationPaths, AuthorizationInput? Authorization);
    private sealed record DisconnectInput(string? Generation, string? Reason);
    private sealed record AuthorizationInput(IReadOnlyList<PathInput>? Paths);
    private sealed record PathInput(NodeInput? Node, ClientInput? Client, [property: JsonPropertyName("lease_expires_at")] string? LeaseExpiresAt);
    private sealed record NodeInput(string? Endpoint, [property: JsonPropertyName("public_key")] string? PublicKey);
    private sealed record ClientInput([property: JsonPropertyName("assigned_ip")] string? AssignedIp, [property: JsonPropertyName("dns_servers")] IReadOnlyList<string>? DnsServers);
}
