using System.Diagnostics;
using System.Runtime.InteropServices;

namespace HoaxConnect.Service.Platform.Windows;

public sealed class SingBoxProcessHost : ISingBoxProcessHost, IDisposable
{
    private Process? _process;
    private readonly KillOnCloseJob _job = new();

    public async Task CheckAsync(string executable, string configuration, CancellationToken cancellationToken)
    {
        var result = await RunAsync(executable, $"check -c \"{configuration}\"", cancellationToken);
        if (result.ExitCode != 0) throw new InvalidDataException("Routing configuration failed validation: " + result.Error.Trim());
    }

    public async Task StartAsync(string executable, string configuration, CancellationToken cancellationToken)
    {
        await StopAsync(cancellationToken);
        var start = CreateStartInfo(executable, $"run -c \"{configuration}\"");
        _process = Process.Start(start) ?? throw new InvalidOperationException("Routing engine could not start.");
        _job.Add(_process);
        await Task.Delay(750, cancellationToken);
        if (_process.HasExited)
        {
            var error = await _process.StandardError.ReadToEndAsync(cancellationToken);
            throw new InvalidOperationException("Routing engine stopped during startup: " + error.Trim());
        }
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        var process = Interlocked.Exchange(ref _process, null);
        if (process is null) return;
        try
        {
            if (!process.HasExited) process.Kill(true);
            await process.WaitForExitAsync(cancellationToken);
        }
        catch (InvalidOperationException) { }
        finally { process.Dispose(); }
    }

    private static async Task<(int ExitCode, string Error)> RunAsync(string executable, string arguments, CancellationToken cancellationToken)
    {
        using var process = Process.Start(CreateStartInfo(executable, arguments))
            ?? throw new InvalidOperationException("Routing engine could not start.");
        var errorTask = process.StandardError.ReadToEndAsync(cancellationToken);
        await process.WaitForExitAsync(cancellationToken);
        return (process.ExitCode, await errorTask);
    }

    private static ProcessStartInfo CreateStartInfo(string executable, string arguments) => new(executable, arguments)
    {
        UseShellExecute = false,
        CreateNoWindow = true,
        RedirectStandardOutput = true,
        RedirectStandardError = true,
        WorkingDirectory = Path.GetDirectoryName(executable)!,
    };

    public void Dispose()
    {
        StopAsync(CancellationToken.None).GetAwaiter().GetResult();
        _job.Dispose();
    }

    private sealed class KillOnCloseJob : IDisposable
    {
        private readonly IntPtr _handle;

        public KillOnCloseJob()
        {
            _handle = CreateJobObject(IntPtr.Zero, null);
            if (_handle == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
            var limits = new JobObjectExtendedLimitInformation
            {
                BasicLimitInformation = new JobObjectBasicLimitInformation { LimitFlags = 0x00002000 }
            };
            var size = Marshal.SizeOf<JobObjectExtendedLimitInformation>();
            var pointer = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(limits, pointer, false);
                if (!SetInformationJobObject(_handle, 9, pointer, (uint)size)) throw new System.ComponentModel.Win32Exception();
            }
            finally { Marshal.FreeHGlobal(pointer); }
        }

        public void Add(Process process)
        {
            if (!AssignProcessToJobObject(_handle, process.Handle)) throw new System.ComponentModel.Win32Exception();
        }

        public void Dispose() => CloseHandle(_handle);

        [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
        [StructLayout(LayoutKind.Sequential)] private struct JobObjectBasicLimitInformation { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
        [StructLayout(LayoutKind.Sequential)] private struct JobObjectExtendedLimitInformation { public JobObjectBasicLimitInformation BasicLimitInformation; public IoCounters IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr CreateJobObject(IntPtr attributes, string? name);
        [DllImport("kernel32.dll")] private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
        [DllImport("kernel32.dll")] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    }
}
