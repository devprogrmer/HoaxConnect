using HoaxConnect.Service.Security;

namespace HoaxConnect.Service.Tests;

public sealed class DpapiProtectorTests
{
    [Fact]
    public void MachineScopeRoundTripsWithoutPlaintext()
    {
        var protector = new DpapiSecretProtector();
        var plaintext = System.Text.Encoding.UTF8.GetBytes("private-key-material");

        var protectedValue = protector.Protect(plaintext);
        var restored = protector.Unprotect(protectedValue);

        Assert.Equal(plaintext, restored);
        Assert.DoesNotContain("private-key-material", System.Text.Encoding.UTF8.GetString(protectedValue));
    }
}
