/**
 * Promotion limits. Classifier and gates both read this file.
 *
 * Live extension: change a number, or add a prefix. Wire a new check in gates.ts.
 */
export const gatesConfig = {
  maxChangedLines: 80,
  maxChangedFiles: 4,
  protectedPrefixes: ["src/auth/", "auth/", "migrations/", "infra/"],
  testFileSuffixes: [".test.ts"],
  /**
   * Applied to added diff lines only. A skip that was already on the branch
   * is not this agent's doing.
   */
  forbiddenTestMarkers: [
    /\b(?:it|test|describe)\s*\.\s*skip\b/,
    /\b(?:it|test|describe)\s*\.\s*only\b/,
    /\b(?:xit|xdescribe|xtest)\s*\(/,
  ],
} as const;

export function normalizeRepoPath(filePath: string): string {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

export function isProtectedPath(
  filePath: string,
  prefixes: readonly string[] = gatesConfig.protectedPrefixes,
): boolean {
  const normalized = normalizeRepoPath(filePath);
  return prefixes.some((prefix) => {
    const withSlash = prefix.endsWith("/") ? prefix : `${prefix}/`;
    const bare = withSlash.slice(0, -1);
    return normalized === bare || normalized.startsWith(withSlash);
  });
}

export function isTestFile(
  filename: string,
  suffixes: readonly string[] = gatesConfig.testFileSuffixes,
): boolean {
  const normalized = normalizeRepoPath(filename);
  return suffixes.some((suffix) => normalized.endsWith(suffix));
}
