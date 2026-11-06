import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { AnalysisDiagnostic, SourceRange } from "@codetrail/shared";
import { hash, slash, within, type ScanResult } from "./scan.js";

export function rangeOf(file: ts.SourceFile, start: number, end: number): SourceRange {
  const first = file.getLineAndCharacterOfPosition(start);
  const last = file.getLineAndCharacterOfPosition(end);
  return { start: { line: first.line + 1, column: first.character + 1 }, end: { line: last.line + 1, column: last.character + 1 }, startOffset: start, endOffset: end };
}

export interface CompilerContext {
  program: ts.Program;
  checker: ts.TypeChecker;
  configuration: { path: string | null; hash: string };
  diagnostics: AnalysisDiagnostic[];
  configInputs: { path: string; hash: string }[];
}

export function createCompiler(scan: ScanResult): CompilerContext {
  const diagnostics: AnalysisDiagnostic[] = [];
  const libraryRoot = path.dirname(ts.getDefaultLibFilePath({}));
  const configReads = new Map(scan.configTexts);
  const auxiliaryCache = new Map<string, string>();
  const dependencyDeclarations = new Set<string>();
  const defaults: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.Preserve,
    strict: true, allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true, types: [],
  };
  const absolute = (value: string): string => path.resolve(value);
  function safeExisting(value: string): boolean {
    const location = absolute(value);
    if (!within(scan.root, location) && !within(libraryRoot, location)) return false;
    try {
      const real = realpathSync(location);
      return within(scan.root, real) || within(libraryRoot, real);
    } catch { return false; }
  }
  function readAllowed(value: string): string | undefined {
    const location = absolute(value);
    const captured = scan.files.get(location);
    if (captured) return captured.text;
    const cached = auxiliaryCache.get(location);
    if (cached !== undefined) return cached;
    if (!safeExisting(location)) return undefined;
    const isLib = within(libraryRoot, location) && /\.d\.ts$/.test(location);
    const isDependency = (slash(path.relative(scan.root, location)).split("/").includes("node_modules") || dependencyDeclarations.has(location)) && /\.d\.[cm]?ts$/.test(location);
    const isJson = location.endsWith(".json") && within(scan.root, location);
    // Unscanned project source, excluded source and executable configs are never fallback reads.
    if (!isLib && !isDependency && !isJson) return undefined;
    try {
      if (lstatSync(location).isSymbolicLink()) return undefined;
      const text = readFileSync(location, "utf8");
      auxiliaryCache.set(location, text);
      if (isDependency) dependencyDeclarations.add(realpathSync(location));
      if (isJson || isDependency && !isLib) configReads.set(location, text);
      return text;
    } catch { return undefined; }
  }
  function report(diagnostic: ts.Diagnostic): void {
    const entry: AnalysisDiagnostic = {
      code: `TS${diagnostic.code}`,
      severity: diagnostic.category === ts.DiagnosticCategory.Error ? "error" : "warning",
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    };
    if (diagnostic.file && within(scan.root, diagnostic.file.fileName)) {
      entry.path = slash(path.relative(scan.root, diagnostic.file.fileName));
      if (diagnostic.start !== undefined) entry.range = rangeOf(diagnostic.file, diagnostic.start, diagnostic.start + (diagnostic.length ?? 0));
    }
    diagnostics.push(entry);
  }
  const configPath = ["tsconfig.json", "jsconfig.json"].map((name) => path.join(scan.root, name)).find((name) => existsSync(name)) ?? null;
  let configured: ts.CompilerOptions = {};
  if (configPath) {
    // TS's config parser requires normalized paths for attaching syntax diagnostics.
    const normalizedConfig = slash(configPath);
    const config = ts.readConfigFile(normalizedConfig, readAllowed);
    if (config.error) report(config.error);
    if (config.config) {
      // Phase-one scope is the scanned allowlist; config contributes compiler options, not new files.
      const raw = { ...config.config, files: [...scan.files.keys()].map((file) => slash(path.relative(scan.root, file))), include: [], exclude: [] };
      const parsed = ts.parseJsonConfigFileContent(raw, {
        useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
        fileExists: (name) => readAllowed(name) !== undefined,
        readFile: readAllowed,
        readDirectory: () => [],
      }, slash(scan.root), undefined, normalizedConfig);
      configured = parsed.options;
      for (const error of parsed.errors) report(error);
      if (parsed.projectReferences?.length) diagnostics.push({ code: "PROJECT_REFERENCES_UNSUPPORTED", severity: "warning", message: "Project references are not traversed in this prototype; select one subproject." });
      if (Array.isArray(configured.plugins) && configured.plugins.length) diagnostics.push({ code: "PLUGINS_NOT_EXECUTED", severity: "info", message: "Compiler plugins are not executed during analysis." });
    }
  }
  const options: ts.CompilerOptions = {
    ...defaults, ...configured, allowJs: true, noEmit: true, declaration: false, declarationMap: false,
    emitDeclarationOnly: false, composite: false, incremental: false, isolatedDeclarations: false, skipLibCheck: true,
  };
  delete options.tsBuildInfoFile;
  const host = ts.createCompilerHost(options, true);
  host.getCurrentDirectory = () => scan.root;
  host.readFile = readAllowed;
  host.fileExists = (name) => readAllowed(name) !== undefined;
  host.directoryExists = (name) => {
    try { return safeExisting(name) && statSync(name).isDirectory(); }
    catch { return false; }
  };
  host.getDirectories = (name) => {
    if (!safeExisting(name)) return [];
    try { return readdirSync(name, { withFileTypes: true }).filter((entry) => entry.isDirectory() && safeExisting(path.join(name, entry.name))).map((entry) => entry.name); }
    catch { return []; }
  };
  host.realpath = (name) => safeExisting(name) ? realpathSync(name) : name;
  host.getSourceFile = (name, languageVersion) => {
    const text = readAllowed(name);
    return text === undefined ? undefined : ts.createSourceFile(name, text, languageVersion, true);
  };
  host.writeFile = () => { throw new Error("Analysis cannot emit into the target project"); };
  const program = ts.createProgram([...scan.files.keys()], options, host);
  for (const diagnostic of [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()]) report(diagnostic);
  for (const file of program.getSourceFiles()) {
    if (!scan.files.has(absolute(file.fileName))) continue;
    for (const diagnostic of [...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file)]) report(diagnostic);
  }
  const configHash = hash(JSON.stringify({ options, reads: [...configReads].map(([name, text]) => [slash(path.relative(scan.root, name)), hash(text)]).sort() }));
  return { program, checker: program.getTypeChecker(), configuration: { path: configPath ? slash(path.relative(scan.root, configPath)) : null, hash: configHash }, diagnostics, configInputs: [...configReads].map(([file, text]) => ({ path: file, hash: hash(text) })) };
}
