// The package-relative path of a linted file (`src/domain/ids.ts`), or null for a file outside packages/kopje.
export function packagePath(filename) {
  const match = /(?:^|\/)packages\/kopje\/(.+)$/.exec(filename.replaceAll("\\", "/"));
  return match === null ? null : match[1];
}
