import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { AnalysisDiagnostic, SourceRange } from "@codetrail/shared";
import { hash, slash, within, type ScanResult } from "./scan.js";
import { pnpmPatterns } from "./workspace.js";
import { sveltePackageEntries, tsdownEntries } from "./build-entries.js";

export function rangeOf(file: ts.SourceFile, start: number, end: number): SourceRange {
  const first = file.getLineAndCharacterOfPosition(start), last = file.getLineAndCharacterOfPosition(end);
  return { start: { line: first.line + 1, column: first.character + 1 }, end: { line: last.line + 1, column: last.character + 1 }, startOffset: start, endOffset: end };
}
export interface CompilerFile { source: ts.SourceFile; program: ts.Program; checker: ts.TypeChecker }
export interface CompilerContext {
  files: CompilerFile[];
  configuration: { path: string | null; hash: string };
  diagnostics: AnalysisDiagnostic[];
  configInputs: { path: string; hash: string }[];
  missingInputs: string[];
}
interface Project { file: string; directory: string; options: ts.CompilerOptions; included: Set<string> }

/** Separate semantic environments, one scanned source identity. Nothing emits or executes. */
export function createCompiler(scan: ScanResult): CompilerContext {
  const diagnostics: AnalysisDiagnostic[] = [], reported = new Set<string>();
  const libraryRoot = path.dirname(ts.getDefaultLibFilePath({}));
  const configReads = new Map(scan.configTexts), auxiliary = new Map<string, string>();
  const missingInputs = new Set<string>(), dependencyRoots = new Set<string>(), missingPaths = new Set<string>();
  const defaults: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.Preserve,
    strict: true, allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true, types: [] };
  const absolute = (name: string): string => path.resolve(name);
  const pathKey = (name: string): string => ts.sys.useCaseSensitiveFileNames ? absolute(name) : absolute(name).toLowerCase();
  const captured = new Map([...scan.files].map(([name, source]) => [pathKey(name), source]));
  function diagnostic(code: string, message: string, file?: string): void {
    const key = `${code}:${file ?? ""}:${message}`;
    if (!reported.has(key)) { reported.add(key); diagnostics.push({ code, message, severity: "warning", ...(file ? { path: slash(path.relative(scan.root, file)) } : {}) }); }
  }
  function safeExisting(name: string): boolean {
    const location = absolute(name);
    if (!within(scan.root, location) && !within(libraryRoot, location)) return false;
    if (missingPaths.has(pathKey(location))) return false;
    try { const real = realpathSync(location); return within(scan.root, real) || within(libraryRoot, real); }
    catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        missingPaths.add(pathKey(location));
        if (within(scan.root, location)) missingInputs.add(location);
      }
      return false;
    }
  }
  function readAllowed(name: string): string | undefined {
    const location = absolute(name), source = captured.get(pathKey(location));
    if (source) return source.text;
    if (auxiliary.has(location)) return auxiliary.get(location);
    if (!safeExisting(location)) return undefined;
    const isLib = within(libraryRoot, location) && /\.d\.ts$/.test(location);
    const isDependency = /\.d\.[cm]?ts$/.test(location) && (slash(location).split("/").includes("node_modules") || [...dependencyRoots].some((root) => within(root, location)));
    const isJson = /\.json$/i.test(location) && within(scan.root, location);
    const isWorkspace = pathKey(location) === pathKey(path.join(scan.root, "pnpm-workspace.yaml"));
    if (!isLib && !isDependency && !isJson && !isWorkspace) return undefined;
    try {
      if (lstatSync(location).isSymbolicLink()) return undefined;
      const text = readFileSync(location, "utf8"), real = realpathSync(location);
      auxiliary.set(location, text);
      if (isDependency && !isLib) {
        const parts = slash(location).split("/"), index = parts.lastIndexOf("node_modules");
        if (index >= 0) {
          const length = parts[index + 1]?.startsWith("@") ? 3 : 2;
          const packageRoot = parts.slice(0, index + length).join("/");
          if (safeExisting(packageRoot) && realpathSync(packageRoot) !== scan.root) dependencyRoots.add(realpathSync(packageRoot));
        }
      }
      if (isJson || isWorkspace || isDependency && !isLib) configReads.set(real, text);
      return text;
    } catch { return undefined; }
  }
  function readMetadata(name: string): string | undefined {
    const text = readAllowed(name);
    if (text === undefined && within(scan.root, absolute(name)) && !existsSync(name)) missingInputs.add(absolute(name));
    return text;
  }
  function report(item: ts.Diagnostic): void {
    const entry: AnalysisDiagnostic = { code: `TS${item.code}`, severity: item.category === ts.DiagnosticCategory.Error ? "error" : "warning", message: ts.flattenDiagnosticMessageText(item.messageText, "\n") };
    if (item.file && within(scan.root, item.file.fileName)) {
      entry.path = slash(path.relative(scan.root, item.file.fileName));
      if (item.start !== undefined) entry.range = rangeOf(item.file, item.start, item.start + (item.length ?? 0));
    }
    const key = JSON.stringify(entry);
    if (!reported.has(key)) { reported.add(key); diagnostics.push(entry); }
  }
  const projects = new Map<string, Project>(), visiting = new Set<string>();
  // Let TypeScript select file membership from the captured allowlist, without filesystem glob reads.
  function readDirectory(directory: string, extensions?: readonly string[], excludes?: readonly string[], includes?: readonly string[], depth?: number): string[] {
    function matches(file: string, pattern: string): boolean {
      const resolved = slash(path.resolve(directory, pattern));
      return /[*?\[\]{}]/.test(resolved) ? path.matchesGlob(slash(file), resolved) : file === path.resolve(resolved) || within(path.resolve(resolved), file);
    }
    return [...scan.files.keys()].filter((file) => within(directory, file)
      && (!extensions || extensions.some((extension) => file.endsWith(extension)))
      && (!includes || includes.some((pattern) => matches(file, pattern)))
      && !excludes?.some((pattern) => matches(file, pattern))
      && (depth === undefined || path.relative(directory, path.dirname(file)).split(path.sep).filter(Boolean).length < depth));
  }
  function loadProject(name: string): void {
    const location = absolute(name), file = safeExisting(location) ? path.resolve(scan.root, path.relative(scan.root, realpathSync.native(location))) : location;
    if (!within(scan.root, file) || !safeExisting(file)) {
      if (within(scan.root, file) && !existsSync(file)) missingInputs.add(file);
      diagnostic("PROJECT_REFERENCE_OUTSIDE_SCOPE", "Project reference is missing or outside the selected root; its source is not loaded.", within(scan.root, file) ? file : undefined); return;
    }
    if (visiting.has(file)) { diagnostic("PROJECT_REFERENCE_CYCLE", "Cyclic project reference; each configuration is read at most once.", file); return; }
    if (projects.has(file)) return;
    if (projects.size >= 64) { diagnostic("PROJECT_CONFIG_LIMIT", "At most 64 project configurations are analyzed."); return; }
    visiting.add(file);
    const directory = path.dirname(file), config = ts.readConfigFile(slash(file), readMetadata);
    if (config.error) report(config.error);
    const raw = (config.config ?? {}) as Record<string, unknown>;
    const parseHost: ts.ParseConfigHost = {
      useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
      fileExists: (name) => readAllowed(name) !== undefined, readFile: readMetadata, readDirectory,
    };
    const parsed = ts.parseJsonConfigFileContent({ ...raw, files: [...scan.files.keys()].map((source) => slash(path.relative(directory, source))), include: [], exclude: [] }, parseHost, slash(directory), undefined, slash(file));
    const membership = ts.parseJsonConfigFileContent(raw, parseHost, slash(directory), undefined, slash(file));
    for (const error of parsed.errors) report(error);
    projects.set(file, { file, directory, options: { ...defaults, ...parsed.options }, included: new Set(membership.fileNames.map(absolute)) });
    if (Array.isArray(parsed.options.plugins) && parsed.options.plugins.length) diagnostics.push({ code: "PLUGINS_NOT_EXECUTED", severity: "info", path: slash(path.relative(scan.root, file)), message: "Compiler plugins are not executed during analysis." });
    for (const reference of parsed.projectReferences ?? []) {
      const target = absolute(reference.path), next = /\.json$/i.test(target) ? target : path.join(target, "tsconfig.json");
      if ([...scan.excluded].some((excluded) => within(excluded, next))) { diagnostic("PROJECT_REFERENCE_EXCLUDED", "Referenced configuration is excluded by the scan scope.", file); continue; }
      loadProject(next);
    }
    visiting.delete(file);
  }
  const rootConfigs = ["tsconfig.json", "jsconfig.json"].map((name) => path.join(scan.root, name));
  rootConfigs.forEach(readMetadata);
  const configPath = rootConfigs.find((name) => safeExisting(name)) ?? null;
  if (configPath) loadProject(configPath);
  const packageFiles = new Set<string>();
  for (const source of scan.files.keys()) {
    let directory = path.dirname(source);
    while (within(scan.root, directory)) {
      const candidates = ["tsconfig.json", "jsconfig.json"].map((name) => path.join(directory, name));
      const found = candidates.find((name) => readMetadata(name) !== undefined);
      if (found) loadProject(found);
      const manifest = path.join(directory, "package.json");
      if (readMetadata(manifest) !== undefined) packageFiles.add(manifest);
      if (directory === scan.root) break;
      directory = path.dirname(directory);
    }
  }
  const fallback: Project = { file: "", directory: scan.root, options: defaults, included: new Set() };
  function owner(file: string): Project {
    const candidates = [...projects.values()].filter((project) => within(project.directory, file)).sort((a, b) => b.directory.length - a.directory.length || a.file.localeCompare(b.file));
    if (!candidates.length) return fallback;
    const nearest = candidates.filter((project) => project.directory === candidates[0]!.directory);
    if (nearest.length === 1) return nearest[0]!;
    const members = nearest.filter((project) => project.included.has(file));
    if (members.length === 1) return members[0]!;
    const standard = nearest.find((project) => ["tsconfig.json", "jsconfig.json"].includes(path.basename(project.file)));
    if (!members.length && standard) return standard;
    diagnostic("PROJECT_CONFIG_AMBIGUOUS", "Several referenced configurations share a directory; a unique file environment cannot be selected.", file);
    return fallback;
  }
  const owners = new Map([...scan.files.keys()].map((file) => [file, owner(file)]));
  const ownerByPath = new Map([...owners].map(([file, project]) => [pathKey(file), project]));
  const outputSources = new Map<string, string | null>(), outputDirectories = new Set<string>();
  const mapOutput = (output: string, source: string): void => {
    if (!within(scan.root, output)) return;
    const previous = outputSources.get(pathKey(output));
    if (previous !== undefined && previous !== null && previous !== source) diagnostic("WORKSPACE_OUTPUT_AMBIGUOUS", "Multiple scanned sources share a compiler output path; no source redirect is made.", output);
    outputSources.set(pathKey(output), previous === undefined || previous === source ? source : null);
    let directory = path.dirname(output);
    while (within(scan.root, directory)) { outputDirectories.add(pathKey(directory)); if (directory === scan.root) break; directory = path.dirname(directory); }
  };
  for (const [source, project] of owners) {
    if (/\.d\.ts$/.test(source)) continue;
    const inputRoot = project.options.rootDir ?? (project.options.composite ? project.directory : undefined);
    if (!inputRoot || !within(inputRoot, source)) continue;
    const relative = path.relative(inputRoot, source).replace(/\.[jt]sx?$/, "");
    if (project.options.outDir) {
      mapOutput(path.join(project.options.outDir, `${relative}.js`), source);
      if (project.options.jsx === ts.JsxEmit.Preserve && /[jt]sx$/.test(source)) mapOutput(path.join(project.options.outDir, `${relative}.jsx`), source);
    }
    const declarations = project.options.declarationDir ?? project.options.outDir;
    if (declarations) mapOutput(path.join(declarations, `${relative}.d.ts`), source);
  }
  const manifests = new Map<string, Record<string, unknown>>();
  for (const file of packageFiles) {
    try {
      const manifest: unknown = JSON.parse(readAllowed(file)!.replace(/^\uFEFF/, ""));
      if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("Package manifest must be an object");
      manifests.set(file, manifest as Record<string, unknown>);
    }
    catch { diagnostic("WORKSPACE_MANIFEST_INVALID", "Package manifest is invalid JSON.", file); }
  }
  const workspaceValue = manifests.get(path.join(scan.root, "package.json"))?.workspaces;
  let patterns: unknown = Array.isArray(workspaceValue) ? workspaceValue : workspaceValue && typeof workspaceValue === "object" ? (workspaceValue as { packages?: unknown }).packages : [];
  const workspacePath = path.join(scan.root, "pnpm-workspace.yaml"), workspaceText = readMetadata(workspacePath);
  if (workspaceText !== undefined) {
    try { patterns = pnpmPatterns(workspaceText); }
    catch { patterns = []; diagnostic("WORKSPACE_CONFIG_INVALID", "pnpm-workspace.yaml requires bounded literal package patterns; invalid YAML, aliases, tags and out-of-root patterns are not resolved.", workspacePath); }
  } else if (existsSync(workspacePath)) {
    patterns = []; diagnostic("WORKSPACE_CONFIG_UNREADABLE", "pnpm-workspace.yaml cannot be read inside the selected root.", workspacePath);
  }
  const names = new Map<string, string[]>();
  for (const [file, manifest] of manifests) {
    const directory = path.dirname(file), relative = slash(path.relative(scan.root, directory));
    const referenced = [...projects.values()].some((project) => project.directory === directory && project.file !== configPath);
    const declared = Array.isArray(patterns) && patterns.some((pattern) => typeof pattern === "string" && !pattern.startsWith("!") && path.matchesGlob(relative, pattern))
      && !patterns.some((pattern) => typeof pattern === "string" && pattern.startsWith("!") && path.matchesGlob(relative, pattern.slice(1)));
    if ((!declared && !referenced) || typeof manifest.name !== "string") continue;
    if (!/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/.test(manifest.name) || [".", ".."].includes(manifest.name)) {
      diagnostic("WORKSPACE_MANIFEST_INVALID", "Workspace package name is not a safe package identity.", file); continue;
    }
    names.set(manifest.name, [...(names.get(manifest.name) ?? []), directory]);
  }
  const aliases = new Map<string, string>();
  for (const [name, directories] of names) {
    if (directories.length !== 1) { diagnostic("WORKSPACE_PACKAGE_AMBIGUOUS", `Workspace package ${name} has multiple source directories; no package-name guess is made.`); continue; }
    const alias = path.join(scan.root, "node_modules", name), target = directories[0]!;
    if (existsSync(alias) && (!safeExisting(alias) || pathKey(realpathSync(alias)) !== pathKey(realpathSync(target)))) {
      diagnostic("WORKSPACE_INSTALL_CONFLICT", `Installed package ${name} does not point at the declared workspace; installed resolution is preserved.`); continue;
    }
    aliases.set(alias, target);
    const manifest = manifests.get(path.join(target, "package.json"))!;
    const build = manifest.scripts && typeof manifest.scripts === "object" ? (manifest.scripts as Record<string, unknown>).build : undefined;
    const dependencies = { ...(manifest.dependencies as object ?? {}), ...(manifest.devDependencies as object ?? {}) } as Record<string, unknown>;
    if (typeof build === "string" && build.startsWith("svelte-package") && typeof dependencies["@sveltejs/package"] === "string") {
      try {
        const mappings = sveltePackageEntries(build, target, [...scan.files.keys()]);
        if (mappings.some((mapping) => captured.has(pathKey(mapping.output)) && pathKey(mapping.output) !== pathKey(mapping.source))) throw new Error("Build output collides with source");
        for (const mapping of mappings) mapOutput(mapping.output, mapping.source);
      } catch { diagnostic("BUILD_ENTRY_UNSUPPORTED", "svelte-package mapping requires explicit literal --input/--output paths inside its package, with no command overrides.", path.join(target, "package.json")); }
    }
    const configFile = path.join(target, "tsdown.config.ts");
    // Build source must already be in the captured allowlist. Excluded configuration is not loaded as code.
    const config = captured.get(pathKey(configFile));
    if (!config) { if (!existsSync(configFile)) missingInputs.add(configFile); continue; }
    configReads.set(configFile, config.text);
    try {
      const mappings = tsdownEntries(config.text, target, manifest.type, build);
      if (mappings.some((mapping) => captured.has(pathKey(mapping.output)) && pathKey(mapping.output) !== pathKey(mapping.source))) throw new Error("Build output collides with scanned source");
      for (const mapping of mappings) {
        if (captured.has(pathKey(mapping.source))) mapOutput(mapping.output, captured.get(pathKey(mapping.source))!.absolutePath);
      }
    } catch {
      diagnostic("BUILD_ENTRY_UNSUPPORTED", "Build entry mapping requires a literal supported tsdown configuration and command; plugins, dynamic values and output overrides are not evaluated.", configFile);
    }
  }
  // Alias/output metadata is now fixed for this analysis. Cache lexical path
  // translation only; filesystem reads and scope validation keep their checks.
  const physicalPaths = new Map<string, string>(), aliasDirectories = new Set<string>();
  for (const alias of aliases.keys()) {
    for (let directory = alias; within(scan.root, directory); directory = path.dirname(directory)) {
      aliasDirectories.add(pathKey(directory));
      if (directory === scan.root) break;
    }
  }
  function physical(name: string): string {
    const location = absolute(name);
    const cached = physicalPaths.get(location);
    if (cached !== undefined) return cached;
    let result = location;
    for (const [alias, target] of aliases) if (within(alias, location)) { result = path.resolve(target, path.relative(alias, location)); break; }
    physicalPaths.set(location, result);
    return result;
  }
  const redirected = (name: string): string => { const location = physical(name); return outputSources.get(pathKey(location)) ?? location; };
  const directoryCache = new Map<string, boolean>();
  const resolutionHost: ts.ModuleResolutionHost = {
    fileExists: (name) => readAllowed(redirected(name)) !== undefined,
    readFile: (name) => readAllowed(redirected(name)),
    directoryExists: (name) => {
      const location = physical(name);
      if (outputDirectories.has(pathKey(location)) || aliasDirectories.has(pathKey(name))) return true;
      const key = pathKey(location), cached = directoryCache.get(key);
      if (cached !== undefined) return cached;
      let directory = false;
      try { directory = safeExisting(location) && statSync(location).isDirectory(); } catch { /* Not a readable directory. */ }
      directoryCache.set(key, directory);
      return directory;
    },
    realpath: (name) => { const location = redirected(name); return safeExisting(location) ? realpathSync(location) : location; },
    getCurrentDirectory: () => scan.root,
  };
  const groups = new Map<string, { options: ts.CompilerOptions; roots: string[] }>();
  const resolutionCaches = new Map<ts.CompilerOptions, ts.ModuleResolutionCache>();
  for (const [source, project] of owners) {
    const options: ts.CompilerOptions = { ...project.options, allowJs: true, noEmit: true, declaration: false, declarationMap: false,
      emitDeclarationOnly: false, composite: false, incremental: false, isolatedDeclarations: false, skipLibCheck: true, rootDir: scan.root };
    delete options.tsBuildInfoFile; delete options.outDir; delete options.declarationDir; delete options.configFilePath;
    const key = JSON.stringify(Object.entries(options).sort(([a], [b]) => a.localeCompare(b)));
    const group = groups.get(key) ?? { options, roots: [] }; group.roots.push(source); groups.set(key, group);
  }
  const files: CompilerFile[] = [];
  // TS's document registry shares declaration syntax across compatible language environments.
  // Project source ASTs/checkers remain independent; each analysis gets a fresh registry.
  const declarations = ts.createDocumentRegistry(ts.sys.useCaseSensitiveFileNames, scan.root);
  const declarationVersions = new Map<string, { snapshot: ts.IScriptSnapshot; version: string }>();
  for (const { options, roots } of groups.values()) {
    const host = ts.createCompilerHost(options, true);
    host.getCurrentDirectory = () => scan.root;
    host.readFile = readAllowed; host.fileExists = (name) => readAllowed(name) !== undefined;
    host.directoryExists = resolutionHost.directoryExists!;
    host.getDirectories = (name) => {
      if (!safeExisting(name)) return [];
      try { return readdirSync(name, { withFileTypes: true }).filter((entry) => entry.isDirectory() && safeExisting(path.join(name, entry.name))).map((entry) => entry.name); } catch { return []; }
    };
    host.realpath = (name) => safeExisting(name) ? realpathSync(name) : name;
    host.getSourceFile = (name, languageVersion) => {
      const text = readAllowed(name);
      if (text === undefined) return undefined;
      if (/\.d\.[cm]?ts$/.test(name) && !captured.has(pathKey(name))) {
        let document = declarationVersions.get(pathKey(name));
        if (!document) { document = { snapshot: ts.ScriptSnapshot.fromString(text), version: hash(text) }; declarationVersions.set(pathKey(name), document); }
        return declarations.acquireDocument(name, options, document.snapshot, document.version, ts.ScriptKind.TS, languageVersion);
      }
      return ts.createSourceFile(name, text, languageVersion, true);
    };
    host.writeFile = () => { throw new Error("Analysis cannot emit into the target project"); };
    host.resolveModuleNameLiterals = (literals, containingFile, _reference, _options, source) => literals.map((literal) => {
      const environment = ownerByPath.get(pathKey(containingFile))?.options ?? options;
      let cache = resolutionCaches.get(environment);
      if (!cache) {
        cache = ts.createModuleResolutionCache(scan.root, (name) => ts.sys.useCaseSensitiveFileNames ? name : name.toLowerCase(), environment);
        resolutionCaches.set(environment, cache);
      }
      const result = ts.resolveModuleName(literal.text, containingFile, environment, resolutionHost, cache, undefined, ts.getModeForUsageLocation(source, literal, environment));
      const resolved = result.resolvedModule;
      if (!resolved) return result;
      const location = captured.get(pathKey(redirected(resolved.resolvedFileName)))?.absolutePath;
      if (!location) return result;
      const { packageId: _packageId, ...details } = resolved;
      const extension = location.endsWith(".d.ts") ? ts.Extension.Dts : location.endsWith(".tsx") ? ts.Extension.Tsx : location.endsWith(".jsx") ? ts.Extension.Jsx : location.endsWith(".js") ? ts.Extension.Js : ts.Extension.Ts;
      return { ...result, resolvedModule: { ...details, resolvedFileName: location, extension, isExternalLibraryImport: false } };
    });
    const program = ts.createProgram(roots, options, host), checker = program.getTypeChecker();
    for (const item of [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()]) report(item);
    for (const root of roots) {
      const source = program.getSourceFile(root);
      if (!source) continue;
      files.push({ source, program, checker });
      for (const item of [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)]) report(item);
    }
  }
  files.sort((a, b) => absolute(a.source.fileName).localeCompare(absolute(b.source.fileName), "en"));
  for (const name of configReads.keys()) missingInputs.delete(name);
  const configHash = hash(JSON.stringify({ projects: [...projects].map(([file, project]) => [slash(path.relative(scan.root, file)), project.options]),
    reads: [...configReads].map(([file, text]) => [slash(path.relative(scan.root, file)), hash(text)]).sort(),
    missing: [...missingInputs].map((file) => slash(path.relative(scan.root, file))).sort() }));
  return { files, configuration: { path: configPath ? slash(path.relative(scan.root, configPath)) : null, hash: configHash }, diagnostics,
    configInputs: [...configReads].map(([file, text]) => ({ path: file, hash: hash(text) })), missingInputs: [...missingInputs] };
}
