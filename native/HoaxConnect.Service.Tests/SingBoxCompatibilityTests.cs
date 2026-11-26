using System.Diagnostics;
using HoaxConnect.Service.Core;
using HoaxConnect.Service.Platform.Windows;
using HoaxConnect.Service.Security;

namespace HoaxConnect.Service.Tests;

public sealed class SingBoxCompatibilityTests
{
    [Fact]
    public async Task GeneratedConfigurationPassesPinnedEngineValidation()
    {
        var executable = Environment.GetEnvironmentVariable("HC_SING_BOX_PATH");
        if (string.IsNullOrWhiteSpace(executable)) return;
        var identity = SingBoxIdentityProvider.Generate(executable);
        var peer = SingBoxIdentityProvider.Generate(executable);
        var request = new ConnectRequest(
            "generation-1", [@"C:\Games\Game.exe"],
            new TunnelAuthorization("198.51.100.20:51820", peer.PublicKey, "10.88.0.2", ["1.1.1.1"], DateTimeOffset.UtcNow.AddMinutes(5)));
        var path = Path.Combine(Path.GetTempPath(), $"hc-config-{Guid.NewGuid():N}.json");
        try
        {
            await File.WriteAllTextAsync(path, SingBoxConfigBuilder.Build(request, identity));
            var start = new ProcessStartInfo(executable, $"check -c \"{path}\"")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardError = true,
            };
            using var process = Process.Start(start)!;
            var error = await process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync();
            Assert.True(process.ExitCode == 0, error);
        }
        finally { if (File.Exists(path)) File.Delete(path); }
    }
}
