using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;

namespace HoaxConnect.Service.Protocol;

public sealed class NamedPipeControlServer(ControlProtocolHandler handler, SecurityIdentifier allowedUser)
{
    public const string PipeName = "HoaxConnect.Control.v1";
    public const int MaximumMessageBytes = 65_536;

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            var pipe = CreatePipe();
            await pipe.WaitForConnectionAsync(cancellationToken);
            _ = HandleClientAsync(pipe, cancellationToken);
        }
    }

    private async Task HandleClientAsync(NamedPipeServerStream pipe, CancellationToken cancellationToken)
    {
        await using (pipe)
        {
            var request = await ReadBoundedLineAsync(pipe, cancellationToken);
            if (!IsAllowedClient(pipe))
            {
                pipe.Disconnect();
                return;
            }

            var response = request is null
                ? ControlResponse.Failure("", "INVALID_REQUEST", "The request is invalid.")
                : await handler.HandleAsync(request, cancellationToken);
            var payload = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(response) + "\n");
            await pipe.WriteAsync(payload, cancellationToken);
            await pipe.FlushAsync(cancellationToken);
            pipe.Disconnect();
        }
    }

    private NamedPipeServerStream CreatePipe()
    {
        var security = new PipeSecurity();
        security.SetAccessRuleProtection(true, false);
        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(
            allowedUser, PipeAccessRights.FullControl, AccessControlType.Allow));
        return NamedPipeServerStreamAcl.Create(
            PipeName, PipeDirection.InOut, NamedPipeServerStream.MaxAllowedServerInstances, PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | PipeOptions.WriteThrough, 0, 0, security);
    }

    private bool IsAllowedClient(NamedPipeServerStream pipe)
    {
        SecurityIdentifier? client = null;
        pipe.RunAsClient(() => client = WindowsIdentity.GetCurrent(TokenAccessLevels.Query).User);
        return client is not null && client.Equals(allowedUser);
    }

    internal static async Task<string?> ReadBoundedLineAsync(Stream stream, CancellationToken cancellationToken)
    {
        using var memory = new MemoryStream();
        var one = new byte[1];
        while (memory.Length <= MaximumMessageBytes)
        {
            var count = await stream.ReadAsync(one, cancellationToken);
            if (count == 0) return null;
            if (one[0] == (byte)'\n') return Encoding.UTF8.GetString(memory.ToArray());
            memory.WriteByte(one[0]);
        }
        return null;
    }
}
