import path from "node:path";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";

/** Read package selection as data only; no alias expansion or package-manager execution. */
export function pnpmPatterns(text: string): string[] {
  if (Buffer.byteLength(text, "utf8") > 64 * 1024) throw new Error("Workspace configuration exceeds 64 KiB");
  const document = parseDocument(text, { schema: "core", uniqueKeys: true, strict: true });
  if (document.errors.length || document.warnings.length || !isMap(document.contents)) throw new Error("Invalid workspace YAML");
  const packages = document.get("packages", true);
  if (packages === undefined) return [];
  if (!isSeq(packages) || packages.items.length > 256) throw new Error("Expected at most 256 package patterns");
  return packages.items.map((item) => {
    if (!isScalar(item) || typeof item.value !== "string" || item.value.length > 512) throw new Error("Expected literal package patterns");
    const negative = item.value.startsWith("!"), raw = negative ? item.value.slice(1) : item.value;
    const normalized = path.posix.normalize(raw);
    if (!raw || raw.includes("\\") || /[\x00-\x1f]/.test(raw) || path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw)
      || normalized === ".." || normalized.startsWith("../")) throw new Error("Package pattern escapes the project root");
    return `${negative ? "!" : ""}${normalized.replace(/^\.\//, "")}`;
  });
}
