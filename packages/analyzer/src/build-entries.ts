import path from "node:path";
import ts from "typescript";

/** svelte-package's explicit input/output directories preserve TS/JS module paths. */
export function sveltePackageEntries(build: string, directory: string, sources: string[]): { source: string; output: string }[] {
  const match = /^svelte-package\s+--input\s+([\w./-]+)\s+--output\s+([\w./-]+)$/.exec(build.trim());
  if (!match) throw new Error("Expected explicit svelte-package input/output directories");
  const resolve = (value: string): string => {
    const normalized = path.posix.normalize(value);
    if (path.posix.isAbsolute(value) || normalized === ".." || normalized.startsWith("../")) throw new Error("Build path escapes package");
    return path.resolve(directory, normalized);
  };
  const input = resolve(match[1]!), output = resolve(match[2]!), result: { source: string; output: string }[] = [];
  for (const source of sources) {
    const relative = path.relative(input, source);
    if (!relative) throw new Error("Input must be a source directory");
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !/\.(?:ts|js)$/.test(source) || /\.d\.ts$/.test(source)) continue;
    const stem = relative.replace(/\.(?:ts|js)$/, "");
    result.push({ source, output: path.join(output, stem + ".js") }, { source, output: path.join(output, stem + ".d.ts") });
  }
  return result;
}

/** A deliberately small tsdown data subset; never import or evaluate target configuration. */
export function tsdownEntries(text: string, directory: string, packageType: unknown, build: unknown): { source: string; output: string }[] {
  if (Buffer.byteLength(text, "utf8") > 64 * 1024) throw new Error("Build configuration exceeds 64 KiB");
  if (typeof build !== "string" || !/^tsdown(?:\s+--tsconfig\s+[\w./-]+\.json)?$/.test(build.trim())) throw new Error("Build command overrides are not statically supported");
  const file = ts.createSourceFile("tsdown.config.ts", text, ts.ScriptTarget.Latest, true);
  if ((file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) throw new Error("Invalid build configuration");
  let binding: string | undefined, expression: ts.Expression | undefined;
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === "tsdown") {
      const names = statement.importClause?.namedBindings;
      if (!names || !ts.isNamedImports(names) || statement.importClause?.isTypeOnly) throw new Error("Unsupported build import");
      for (const name of names.elements) if ((name.propertyName?.text ?? name.name.text) === "defineConfig" && !name.isTypeOnly) binding = name.name.text;
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals && !expression) expression = statement.expression;
    else throw new Error("Build configuration contains executable or unsupported statements");
  }
  if (!binding || !expression || !ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)
    || expression.expression.text !== binding || expression.arguments.length !== 1 || !ts.isObjectLiteralExpression(expression.arguments[0]!)) throw new Error("Expected a literal defineConfig object");
  const values = new Map<string, ts.Expression>();
  const allowed = new Set(["entry", "format", "outDir", "root", "unbundle", "dts", "sourcemap", "clean", "minify", "fixedExtension", "exports", "publint"]);
  function literal(node: ts.Expression): boolean {
    return ts.isStringLiteral(node) || ts.isNumericLiteral(node) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(node.kind)
      || ts.isArrayLiteralExpression(node) && node.elements.every((item) => ts.isExpression(item) && literal(item))
      || ts.isObjectLiteralExpression(node) && node.properties.every((item) => ts.isPropertyAssignment(item) && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && literal(item.initializer));
  }
  for (const property of expression.arguments[0]!.properties) {
    if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) throw new Error("Unsupported build property");
    const name = property.name.text;
    if (!allowed.has(name) || values.has(name) || !literal(property.initializer)) throw new Error("Dynamic, duplicate or unsupported build option");
    values.set(name, property.initializer);
  }
  const strings = (name: string): string[] => {
    const node = values.get(name), nodes = node && ts.isArrayLiteralExpression(node) ? node.elements : node ? [node] : [];
    if (!nodes.length || nodes.some((item) => !ts.isStringLiteral(item))) throw new Error(`Expected literal ${name}`);
    return nodes.map((item) => (item as ts.StringLiteral).text);
  };
  if (values.get("unbundle")?.kind !== ts.SyntaxKind.TrueKeyword || values.get("fixedExtension")?.kind !== ts.SyntaxKind.FalseKeyword
    || values.get("dts")?.kind !== ts.SyntaxKind.TrueKeyword) throw new Error("Expected explicit unbundle, dts and fixedExtension settings");
  const entries = strings("entry"), formats = strings("format");
  if (entries.length > 64 || formats.some((value) => !["esm", "cjs"].includes(value))) throw new Error("Unsupported entry count or format");
  const relativePath = (value: string): string => {
    const normalized = path.posix.normalize(value);
    if (!value || /[\x00-\x1f*?{}[\]\\]/.test(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
      || normalized === ".." || normalized.startsWith("../")) throw new Error("Build path is dynamic or outside its package");
    return normalized;
  };
  const sources = entries.map((entry) => path.resolve(directory, relativePath(entry)));
  if (sources.some((source) => !/\.[jt]sx?$/.test(source))) throw new Error("Unsupported source extension");
  let common = path.dirname(sources[0]!);
  for (const source of sources) while (path.relative(common, source).startsWith(`..${path.sep}`)) common = path.dirname(common);
  const scalar = (name: string): string => { const node = values.get(name); if (!node || !ts.isStringLiteral(node)) throw new Error(`Expected scalar ${name}`); return node.text; };
  const inputRoot = values.has("root") ? path.resolve(directory, relativePath(scalar("root"))) : common;
  const outDir = path.resolve(directory, relativePath(values.has("outDir") ? scalar("outDir") : "dist"));
  const result: { source: string; output: string }[] = [];
  for (const source of sources) {
    const relative = path.relative(inputRoot, source);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Entry is outside the declared source directory");
    const stem = relative.replace(/\.[jt]sx?$/, "");
    for (const format of new Set(formats)) {
      const esm = format === "esm", extension = esm ? packageType === "module" ? ".js" : ".mjs" : packageType === "module" ? ".cjs" : ".js";
      const declaration = extension === ".mjs" ? ".d.mts" : extension === ".cjs" ? ".d.cts" : ".d.ts";
      result.push({ source, output: path.join(outDir, stem + extension) }, { source, output: path.join(outDir, stem + declaration) });
    }
  }
  return result;
}
