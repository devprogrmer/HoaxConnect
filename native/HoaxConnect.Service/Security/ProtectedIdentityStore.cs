using System.Text.Json;

namespace HoaxConnect.Service.Security;

public sealed record TunnelIdentity(string PublicKey, string PrivateKey);

public interface ISecretProtector
{
    byte[] Protect(byte[] value);
    byte[] Unprotect(byte[] value);
}

public sealed class ProtectedIdentityStore(string path, ISecretProtector protector, Func<TunnelIdentity> createIdentity)
{
    public async Task<TunnelIdentity> GetOrCreateAsync(CancellationToken cancellationToken)
    {
        if (File.Exists(path))
        {
            var protectedBytes = await File.ReadAllBytesAsync(path, cancellationToken);
            return JsonSerializer.Deserialize<TunnelIdentity>(protector.Unprotect(protectedBytes))
                ?? throw new InvalidDataException("Stored tunnel identity is invalid.");
        }

        var identity = createIdentity();
        var parent = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
        var protectedValue = protector.Protect(JsonSerializer.SerializeToUtf8Bytes(identity));
        var temporary = path + ".tmp";
        await File.WriteAllBytesAsync(temporary, protectedValue, cancellationToken);
        File.Move(temporary, path, true);
        return identity;
    }
}
