using System.Diagnostics;
using HoaxConnect.Service.Protocol;

namespace HoaxConnect.Service.Security;

public sealed class SingBoxIdentityProvider(ProtectedIdentityStore store) : ITunnelIdentityProvider
{
    public Task<TunnelIdentity> GetIdentityAsync(CancellationToken cancellationToken) =>
        store.GetOrCreateAsync(cancellationToken);

    public static TunnelIdentity Generate(string executable)
    {
        var start = new ProcessStartInfo(executable, "generate wg-keypair")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        using var process = Process.Start(start) ?? throw new InvalidOperationException("Routing engine could not start.");
        var output = process.StandardOutput.ReadToEnd();
        var error = process.StandardError.ReadToEnd();
        process.WaitForExit(10_000);
        if (!process.HasExited || process.ExitCode != 0)
            throw new InvalidOperationException("Routing key generation failed: " + error.Trim());
        var values = output.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries)
            .Select(line => line.Split(':', 2, StringSplitOptions.TrimEntries))
            .Where(parts => parts.Length == 2)
            .ToDictionary(parts => parts[0], parts => parts[1], StringComparer.OrdinalIgnoreCase);
        if (!values.TryGetValue("PrivateKey", out var privateKey) || !values.TryGetValue("PublicKey", out var publicKey))
            throw new InvalidDataException("Routing engine returned an invalid key pair.");
        return new TunnelIdentity(publicKey, privateKey);
    }
}
