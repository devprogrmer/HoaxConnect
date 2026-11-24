using System.Security.Principal;
using HoaxConnect.Service.Core;
using HoaxConnect.Service.Platform.Windows;
using HoaxConnect.Service.Protocol;
using HoaxConnect.Service.Security;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace HoaxConnect.Service;

public static class Program
{
    private const string EngineSha256 = "8f30682ee198855440d2a7fe070d5d3653793b2d01bb8c85eea88f93bbe7c8b9";
    private const string SupportLibrarySha256 = "3217c6260fbca5f16072e0b79735742f40109a63bb0ff88fd6b96dd6b54a2928";

    public static async Task Main(string[] args)
    {
        var engine = ReadArgument(args, "--engine-path")
            ?? Environment.GetEnvironmentVariable("HOAXCONNECT_ENGINE_PATH")
            ?? Path.Combine(AppContext.BaseDirectory, "routing", "sing-box.exe");
        var supportLibrary = Path.Combine(Path.GetDirectoryName(engine)!, "libcronet.dll");
        var programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
        var stateDirectory = Environment.GetEnvironmentVariable("HOAXCONNECT_STATE_DIR")
            ?? Path.Combine(programData, "HoaxConnect", "Tunnel");
        var allowedUser = ReadAllowedUser(Path.Combine(programData, "HoaxConnect", "allowed-user.sid"), args);

        var builder = Host.CreateApplicationBuilder(args);
        builder.Services.AddWindowsService(options => options.ServiceName = "HoaxConnect Tunnel");
        builder.Services.AddSingleton<ISingBoxProcessHost, SingBoxProcessHost>();
        builder.Services.AddSingleton<ITunnelIdentityProvider>(services =>
        {
            var store = new ProtectedIdentityStore(
                Path.Combine(stateDirectory, "identity.bin"), new DpapiSecretProtector(),
                () => SingBoxIdentityProvider.Generate(engine));
            return new SingBoxIdentityProvider(store);
        });
        builder.Services.AddSingleton<ITunnelPlatform>(services => new SingBoxTunnelPlatform(
            engine, EngineSha256, supportLibrary, SupportLibrarySha256, stateDirectory,
            services.GetRequiredService<ITunnelIdentityProvider>(),
            services.GetRequiredService<ISingBoxProcessHost>()));
        builder.Services.AddSingleton<TunnelCoordinator>();
        builder.Services.AddSingleton<ControlProtocolHandler>();
        builder.Services.AddSingleton(services =>
            new NamedPipeControlServer(services.GetRequiredService<ControlProtocolHandler>(), allowedUser));
        builder.Services.AddHostedService<TunnelWorker>();
        await builder.Build().RunAsync();
    }

    private static SecurityIdentifier ReadAllowedUser(string path, string[] args)
    {
        if (File.Exists(path)) return new SecurityIdentifier(File.ReadAllText(path).Trim());
        if (args.Contains("--console", StringComparer.OrdinalIgnoreCase))
            return WindowsIdentity.GetCurrent().User ?? throw new InvalidOperationException("Current user SID is unavailable.");
        throw new InvalidOperationException("The allowed desktop user SID is not configured.");
    }

    private static string? ReadArgument(string[] args, string name)
    {
        var index = Array.FindIndex(args, value => string.Equals(value, name, StringComparison.OrdinalIgnoreCase));
        if (index < 0) return null;
        if (index + 1 >= args.Length || string.IsNullOrWhiteSpace(args[index + 1]))
            throw new InvalidOperationException($"{name} requires a value.");
        return Path.GetFullPath(args[index + 1]);
    }
}
