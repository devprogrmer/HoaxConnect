using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;

using Microsoft.Diagnostics.Tracing.Parsers;
using Microsoft.Diagnostics.Tracing.Session;

namespace HoaxTraffic;

internal sealed class ProcessTraffic
{
    public long RxWindow;
    public long TxWindow;

    public long TcpRxWindow;
    public long TcpTxWindow;

    public long UdpRxWindow;
    public long UdpTxWindow;

    public long RxTotal;
    public long TxTotal;

    public long LastSeenTicks;
}

internal sealed class ProcessInfo
{
    public int Pid { get; init; }
    public string Name { get; init; } = "";
    public string Path { get; init; } = "";

    public double RxBps { get; init; }
    public double TxBps { get; init; }

    public double TcpRxBps { get; init; }
    public double TcpTxBps { get; init; }

    public double UdpRxBps { get; init; }
    public double UdpTxBps { get; init; }

    public long RxTotal { get; init; }
    public long TxTotal { get; init; }
}

internal static class Program
{
    private static readonly ConcurrentDictionary<int, ProcessTraffic>
        Traffic = new();

    private static readonly ConcurrentDictionary<int, (string Name, string Path)>
        ProcessCache = new();

    private static readonly object OutputLock = new();

    private static readonly JsonSerializerOptions JsonOptions =
        new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase
        };

    private static long _previousTick =
        Stopwatch.GetTimestamp();

    private static TraceEventSession? _session;

    private static void Record(
        int pid,
        bool receive,
        bool tcp,
        int size
    )
    {
        if (pid < 0 || size <= 0)
            return;

        var item =
            Traffic.GetOrAdd(
                pid,
                _ => new ProcessTraffic()
            );

        Interlocked.Exchange(
            ref item.LastSeenTicks,
            DateTime.UtcNow.Ticks
        );

        if (receive)
        {
            Interlocked.Add(
                ref item.RxWindow,
                size
            );

            Interlocked.Add(
                ref item.RxTotal,
                size
            );

            if (tcp)
            {
                Interlocked.Add(
                    ref item.TcpRxWindow,
                    size
                );
            }
            else
            {
                Interlocked.Add(
                    ref item.UdpRxWindow,
                    size
                );
            }
        }
        else
        {
            Interlocked.Add(
                ref item.TxWindow,
                size
            );

            Interlocked.Add(
                ref item.TxTotal,
                size
            );

            if (tcp)
            {
                Interlocked.Add(
                    ref item.TcpTxWindow,
                    size
                );
            }
            else
            {
                Interlocked.Add(
                    ref item.UdpTxWindow,
                    size
                );
            }
        }
    }

    private static (string Name, string Path)
        GetProcessInfo(int pid)
    {
        return ProcessCache.GetOrAdd(
            pid,
            static id =>
            {
                if (id == 0)
                    return ("Idle", "");

                if (id == 4)
                    return ("System", "");

                try
                {
                    using var process =
                        Process.GetProcessById(id);

                    var name =
                        process.ProcessName;

                    if (
                        !name.EndsWith(
                            ".exe",
                            StringComparison.OrdinalIgnoreCase
                        )
                    )
                    {
                        name += ".exe";
                    }

                    string path = "";

                    try
                    {
                        path =
                            process.MainModule?.FileName
                            ?? "";
                    }
                    catch
                    {
                    }

                    return (
                        name,
                        path
                    );
                }
                catch
                {
                    return (
                        $"PID {id}",
                        ""
                    );
                }
            }
        );
    }

    private static void EmitSnapshot()
    {
        lock (OutputLock)
        {
            var nowTick =
                Stopwatch.GetTimestamp();

            var elapsed =
                (
                    nowTick -
                    _previousTick
                )
                /
                (double)
                Stopwatch.Frequency;

            _previousTick =
                nowTick;

            if (
                elapsed <= 0 ||
                elapsed > 10
            )
            {
                elapsed = 1;
            }

            var now =
                DateTime.UtcNow;

            var rows =
                new List<ProcessInfo>();

            foreach (
                var pair in Traffic
            )
            {
                var pid =
                    pair.Key;

                var item =
                    pair.Value;

                var lastTicks =
                    Interlocked.Read(
                        ref item.LastSeenTicks
                    );

                if (lastTicks <= 0)
                    continue;

                var age =
                    now -
                    new DateTime(
                        lastTicks,
                        DateTimeKind.Utc
                    );

                if (
                    age.TotalSeconds > 60
                )
                {
                    Traffic.TryRemove(
                        pid,
                        out _
                    );

                    ProcessCache.TryRemove(
                        pid,
                        out _
                    );

                    continue;
                }

                var rx =
                    Interlocked.Exchange(
                        ref item.RxWindow,
                        0
                    );

                var tx =
                    Interlocked.Exchange(
                        ref item.TxWindow,
                        0
                    );

                var tcpRx =
                    Interlocked.Exchange(
                        ref item.TcpRxWindow,
                        0
                    );

                var tcpTx =
                    Interlocked.Exchange(
                        ref item.TcpTxWindow,
                        0
                    );

                var udpRx =
                    Interlocked.Exchange(
                        ref item.UdpRxWindow,
                        0
                    );

                var udpTx =
                    Interlocked.Exchange(
                        ref item.UdpTxWindow,
                        0
                    );

                if (
                    rx == 0 &&
                    tx == 0 &&
                    age.TotalSeconds > 8
                )
                {
                    continue;
                }

                var info =
                    GetProcessInfo(pid);

                rows.Add(
                    new ProcessInfo
                    {
                        Pid = pid,

                        Name =
                            info.Name,

                        Path =
                            info.Path,

                        RxBps =
                            rx / elapsed,

                        TxBps =
                            tx / elapsed,

                        TcpRxBps =
                            tcpRx / elapsed,

                        TcpTxBps =
                            tcpTx / elapsed,

                        UdpRxBps =
                            udpRx / elapsed,

                        UdpTxBps =
                            udpTx / elapsed,

                        RxTotal =
                            Interlocked.Read(
                                ref item.RxTotal
                            ),

                        TxTotal =
                            Interlocked.Read(
                                ref item.TxTotal
                            )
                    }
                );
            }

            rows =
                rows
                    .OrderByDescending(
                        x =>
                            x.RxBps +
                            x.TxBps
                    )
                    .Take(100)
                    .ToList();

            var payload =
                new
                {
                    status = "ok",

                    collectedAt =
                        DateTimeOffset
                            .UtcNow
                            .ToString("O"),

                    processes =
                        rows
                };

            Console.WriteLine(
                JsonSerializer.Serialize(
                    payload,
                    JsonOptions
                )
            );

            Console.Out.Flush();
        }
    }

    public static int Main()
    {
        if (!OperatingSystem.IsWindows())
        {
            Console.Error.WriteLine(
                "HoaxTraffic requires Windows."
            );

            return 1;
        }

        if (
            TraceEventSession.IsElevated() != true
        )
        {
            Console.Error.WriteLine(
                "Administrator privileges are required for kernel ETW."
            );

            return 2;
        }

        var sessionName =
            $"HoaxConnectNetwork-{Environment.ProcessId}";

        try
        {
            using var session =
                new TraceEventSession(
                    sessionName
                );

            _session =
                session;

            session.StopOnDispose =
                true;

            session.BufferSizeMB =
                64;

            session.EnableKernelProvider(
                KernelTraceEventParser
                    .Keywords
                    .NetworkTCPIP
                |
                KernelTraceEventParser
                    .Keywords
                    .Process
            );

            session.Source.Kernel
                .TcpIpSend += data =>
            {
                Record(
                    data.ProcessID,
                    false,
                    true,
                    data.size
                );
            };

            session.Source.Kernel
                .TcpIpRecv += data =>
            {
                Record(
                    data.ProcessID,
                    true,
                    true,
                    data.size
                );
            };

            session.Source.Kernel
                .UdpIpSend += data =>
            {
                Record(
                    data.ProcessID,
                    false,
                    false,
                    data.size
                );
            };

            session.Source.Kernel
                .UdpIpRecv += data =>
            {
                Record(
                    data.ProcessID,
                    true,
                    false,
                    data.size
                );
            };

            session.Source.Kernel
                .TcpIpSendIPV6 += data =>
            {
                Record(
                    data.ProcessID,
                    false,
                    true,
                    data.size
                );
            };

            session.Source.Kernel
                .TcpIpRecvIPV6 += data =>
            {
                Record(
                    data.ProcessID,
                    true,
                    true,
                    data.size
                );
            };

            session.Source.Kernel
                .UdpIpSendIPV6 += data =>
            {
                Record(
                    data.ProcessID,
                    false,
                    false,
                    data.size
                );
            };

            session.Source.Kernel
                .UdpIpRecvIPV6 += data =>
            {
                Record(
                    data.ProcessID,
                    true,
                    false,
                    data.size
                );
            };

            Console.CancelKeyPress +=
                (_, eventArgs) =>
                {
                    eventArgs.Cancel =
                        true;

                    try
                    {
                        session.Stop();
                    }
                    catch
                    {
                    }
                };

            _ =
                Task.Run(
                    () =>
                    {
                        string? line;

                        while (
                            (
                                line =
                                    Console.ReadLine()
                            )
                            != null
                        )
                        {
                            if (
                                line.Trim()
                                    .Equals(
                                        "stop",
                                        StringComparison
                                            .OrdinalIgnoreCase
                                    )
                            )
                            {
                                try
                                {
                                    session.Stop();
                                }
                                catch
                                {
                                }

                                break;
                            }
                        }

                        try
                        {
                            session.Stop();
                        }
                        catch
                        {
                        }
                    }
                );

            using var timer =
                new Timer(
                    _ =>
                    {
                        try
                        {
                            EmitSnapshot();
                        }
                        catch (
                            Exception ex
                        )
                        {
                            Console.Error.WriteLine(
                                ex.Message
                            );
                        }
                    },
                    null,
                    1000,
                    1000
                );

            session.Source.Process();

            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(
                ex.ToString()
            );

            return 3;
        }
        finally
        {
            _session = null;
        }
    }
}
