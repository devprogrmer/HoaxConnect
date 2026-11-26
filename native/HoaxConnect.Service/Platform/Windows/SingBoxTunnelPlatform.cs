using System.Security.Cryptography;
using System.Security.AccessControl;
using System.Security.Principal;
using HoaxConnect.Service.Core;
using HoaxConnect.Service.Protocol;

namespace HoaxConnect.Service.Platform.Windows;

public interface ISingBoxProcessHost
{
    Task CheckAsync(string executable, string configuration, CancellationToken cancellationToken);
    Task StartAsync(string executable, string configuration, CancellationToken cancellationToken);
    Task StopAsync(CancellationToken cancellationToken);
}

public sealed class SingBoxTunnelPlatform(
    string executable,
    string expectedSha256,
    string supportLibrary,
    string expectedSupportLibrarySha256,
    string stateDirectory,
    ITunnelIdentityProvider identities,
    ISingBoxProcessHost processHost) : ITunnelPlatform
{
    private string ConfigurationPath => Path.Combine(stateDirectory, "active.json");

    public async Task CleanupOwnedStateAsync(CancellationToken cancellationToken)
    {
        await processHost.StopAsync(cancellationToken);
        if (File.Exists(ConfigurationPath)) File.Delete(ConfigurationPath);
    }

    public async Task ConnectAsync(ConnectRequest request, CancellationToken cancellationToken)
    {
        VerifyEngine();
        SecureStateDirectory();
        var identity = await identities.GetIdentityAsync(cancellationToken);
        var configuration = SingBoxConfigBuilder.Build(request, identity);
        var temporary = ConfigurationPath + ".tmp";
        await File.WriteAllTextAsync(temporary, configuration, cancellationToken);
        File.Move(temporary, ConfigurationPath, true);
        try
        {
            await processHost.CheckAsync(executable, ConfigurationPath, cancellationToken);
            await processHost.StartAsync(executable, ConfigurationPath, cancellationToken);
        }
        catch
        {
            await CleanupOwnedStateAsync(CancellationToken.None);
            throw;
        }
    }

    public async Task DisconnectAsync(string generation, CancellationToken cancellationToken) =>
        await CleanupOwnedStateAsync(cancellationToken);

    private void VerifyEngine()
    {
        VerifyFile(executable, expectedSha256, "Routing engine");
        VerifyFile(supportLibrary, expectedSupportLibrarySha256, "Routing support library");
    }

    private static void VerifyFile(string path, string expectedSha256, string label)
    {
        if (!File.Exists(path)) throw new FileNotFoundException($"{label} is missing.", path);
        var actual = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)));
        if (!string.Equals(actual, expectedSha256, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException($"{label} integrity check failed.");
    }

    private void SecureStateDirectory()
    {
        Directory.CreateDirectory(stateDirectory);
        var security = new DirectorySecurity();
        security.SetAccessRuleProtection(true, false);
        const FileSystemRights full = FileSystemRights.FullControl;
        const InheritanceFlags inheritance = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
        security.AddAccessRule(new FileSystemAccessRule(
            new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), full, inheritance,
            PropagationFlags.None, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(
            new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), full, inheritance,
            PropagationFlags.None, AccessControlType.Allow));
        var serviceIdentity = WindowsIdentity.GetCurrent().User
            ?? throw new InvalidOperationException("The tunnel service identity is unavailable.");
        security.AddAccessRule(new FileSystemAccessRule(
            serviceIdentity, full, inheritance, PropagationFlags.None, AccessControlType.Allow));
        new DirectoryInfo(stateDirectory).SetAccessControl(security);
    }
}
