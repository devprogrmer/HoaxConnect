using HoaxConnect.Service.Security;

namespace HoaxConnect.Service.Tests;

public sealed class PathValidatorTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), $"hc-path-{Guid.NewGuid():N}");

    public PathValidatorTests() => Directory.CreateDirectory(_root);

    [Fact]
    public void AcceptsExistingAbsoluteExeAndNormalizesDuplicates()
    {
        var executable = Path.Combine(_root, "Game.exe");
        File.WriteAllBytes(executable, [0x4d, 0x5a]);

        var result = ExecutablePathValidator.Validate([executable, executable.ToUpperInvariant()]);

        Assert.Single(result);
        Assert.Equal(Path.GetFullPath(executable), result[0]);
    }

    [Theory]
    [InlineData("relative.exe")]
    [InlineData("C:\\missing.exe")]
    [InlineData("C:\\Windows\\not-a-program.txt")]
    public void RejectsUnsafePaths(string path) =>
        Assert.Throws<InvalidDataException>(() => ExecutablePathValidator.Validate([path]));

    [Fact]
    public void RejectsReparsePoints()
    {
        var target = Path.Combine(_root, "target.exe");
        var link = Path.Combine(_root, "linked.exe");
        File.WriteAllBytes(target, [0x4d, 0x5a]);
        try
        {
            File.CreateSymbolicLink(link, target);
        }
        catch (Exception error) when (error is UnauthorizedAccessException or IOException)
        {
            return;
        }

        Assert.Throws<InvalidDataException>(() => ExecutablePathValidator.Validate([link]));
    }

    public void Dispose() => Directory.Delete(_root, true);
}
