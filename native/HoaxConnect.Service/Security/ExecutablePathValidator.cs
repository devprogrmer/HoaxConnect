namespace HoaxConnect.Service.Security;

public static class ExecutablePathValidator
{
    public static IReadOnlyList<string> Validate(IEnumerable<string>? paths)
    {
        if (paths is null) throw new InvalidDataException("At least one executable is required.");
        var validated = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var candidate in paths)
        {
            if (string.IsNullOrWhiteSpace(candidate) || !Path.IsPathFullyQualified(candidate))
                throw new InvalidDataException("Executable paths must be absolute.");

            var fullPath = Path.GetFullPath(candidate);
            if (!string.Equals(Path.GetExtension(fullPath), ".exe", StringComparison.OrdinalIgnoreCase) || !File.Exists(fullPath))
                throw new InvalidDataException("Executable path must reference an existing .exe file.");

            var info = new FileInfo(fullPath);
            if ((info.Attributes & FileAttributes.ReparsePoint) != 0 || info.LinkTarget is not null)
                throw new InvalidDataException("Executable path must not be a reparse point.");
            validated.Add(fullPath);
        }

        if (validated.Count == 0) throw new InvalidDataException("At least one executable is required.");
        return validated.ToArray();
    }
}
