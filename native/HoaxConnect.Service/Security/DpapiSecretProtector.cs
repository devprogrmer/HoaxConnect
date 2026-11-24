using System.Security.Cryptography;

namespace HoaxConnect.Service.Security;

public sealed class DpapiSecretProtector : ISecretProtector
{
    private static readonly byte[] Entropy = "HoaxConnect.TunnelIdentity.v1"u8.ToArray();

    public byte[] Protect(byte[] value) =>
        ProtectedData.Protect(value, Entropy, DataProtectionScope.LocalMachine);

    public byte[] Unprotect(byte[] value) =>
        ProtectedData.Unprotect(value, Entropy, DataProtectionScope.LocalMachine);
}
