using HoaxConnect.Service.Security;

namespace HoaxConnect.Service.Tests;

public sealed class ProtectedIdentityStoreTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), $"hc-identity-{Guid.NewGuid():N}");

    public ProtectedIdentityStoreTests() => Directory.CreateDirectory(_root);

    [Fact]
    public async Task PersistsOnlyProtectedPrivateMaterialAndRestoresIdentity()
    {
        var protector = new PrefixProtector();
        var path = Path.Combine(_root, "identity.bin");
        var store = new ProtectedIdentityStore(path, protector, () => new TunnelIdentity("public-key", "private-key"));

        var first = await store.GetOrCreateAsync(CancellationToken.None);
        var raw = await File.ReadAllTextAsync(path);
        var second = await store.GetOrCreateAsync(CancellationToken.None);

        Assert.Equal(first, second);
        Assert.DoesNotContain("private-key", raw);
        Assert.StartsWith("protected:", raw);
    }

    public void Dispose() => Directory.Delete(_root, true);

    private sealed class PrefixProtector : ISecretProtector
    {
        public byte[] Protect(byte[] value) => System.Text.Encoding.UTF8.GetBytes("protected:" + Convert.ToBase64String(value));
        public byte[] Unprotect(byte[] value)
        {
            var encoded = System.Text.Encoding.UTF8.GetString(value)["protected:".Length..];
            return Convert.FromBase64String(encoded);
        }
    }
}
