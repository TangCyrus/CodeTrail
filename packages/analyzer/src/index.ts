import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import ts from "typescript";
import { assertSnapshotIntegrity, type AnalysisSnapshot, type AnalyzerAdapter, type AnalyzeRequest, type AnalysisPhase, type CapturedSource, type EvidenceRecord, type RelationKind, type RelationRecord, type SourceFileRecord, type SymbolKind, type SymbolRecord, type UnresolvedRecord } from "@codetrail/shared";
import { createCompiler, rangeOf } from "./compiler.js";
import { hash, scanProject, slash, within } from "./scan.js";

const VERSION = "0.5.0";
const shortId = (prefix: string, value: string): string => `${prefix}:${hash(value).slice(0, 24)}`;
type NamedDeclaration = ts.Declaration & { name: ts.DeclarationName };
interface Registered { node: ts.Node; record: SymbolRecord; symbol: ts.Symbol | undefined; callable: boolean }

function declarationKind(node: ts.Node): SymbolKind | undefined {
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) return "method";
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isEnumDeclaration(node)) return "enum";
  if (ts.isVariableDeclaration(node)) return node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) ? "function" : "variable";
  if (ts.isParameter(node)) return "parameter";
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) || ts.isEnumMember(node)) return "property";
  return undefined;
}

function hasExecutableBody(node: ts.Node): boolean {
  return (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && !!node.body
    || (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) && !!node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer));
}

function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)
    || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
  return node;
}

function insideImportOrExport(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current && !ts.isSourceFile(current); current = current.parent) {
    if (ts.isImportDeclaration(current) || ts.isImportEqualsDeclaration(current) || ts.isExportDeclaration(current)) return true;
  }
  return false;
}

function isTypeUsage(node: ts.Node): boolean {
  for (let current = node.parent; current && !ts.isSourceFile(current); current = current.parent) {
    if (ts.isExpressionWithTypeArguments(current) && ts.isHeritageClause(current.parent)) {
      const declaration = current.parent.parent;
      return !(current.parent.token === ts.SyntaxKind.ExtendsKeyword && (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)));
    }
    if (ts.isTypeNode(current)) return true;
    if (ts.isExpressionStatement(current) || ts.isBlock(current) || ts.isVariableDeclaration(current)) return false;
  }
  return false;
}

function isReferenceIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (insideImportOrExport(node)) return false;
  if ("name" in parent && parent.name === node
    && !ts.isPropertyAccessExpression(parent) && !ts.isShorthandPropertyAssignment(parent)
    && !ts.isJsxOpeningElement(parent) && !ts.isJsxSelfClosingElement(parent)) return false;
  if (ts.isJsxClosingElement(parent) || ts.isLabeledStatement(parent)
    || ts.isBreakOrContinueStatement(parent) || ts.isBindingElement(parent) && parent.propertyName === node) return false;
  if ((ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent)) && /^[a-z]/.test(node.text)) return false;
  return true;
}

export class TypeScriptAnalyzer implements AnalyzerAdapter {
  readonly name = "typescript-compiler";

  analyze(request: AnalyzeRequest, hooks: AnalyzerHooks = {}): AnalysisSnapshot {
    const started = performance.now();
    hooks.onProgress?.("scanning");
    const scan = scanProject(request);
    hooks.onSources?.([...scan.files.values()].map((file) => ({ path: file.path, content: file.text, hash: file.hash })));
    hooks.onProgress?.("compiling");
    const compiler = createCompiler(scan);
    let checker!: ts.TypeChecker;
    let program!: ts.Program;
    const environments = new Map(compiler.files.map((entry) => [entry.source, entry]));
    function activate(file: ts.SourceFile): void {
      const environment = environments.get(file)!;
      checker = environment.checker; program = environment.program;
    }
    const diagnostics = [...scan.diagnostics, ...compiler.diagnostics];
    const sourceFiles = compiler.files.map((entry) => entry.source);
    const files: SourceFileRecord[] = sourceFiles.map((file) => {
      const scanned = scan.files.get(path.resolve(file.fileName))!;
      activate(file);
      return {
        id: shortId("file", scanned.path), path: scanned.path, hash: scanned.hash,
        language: path.extname(scanned.path).slice(1) as SourceFileRecord["language"],
        bytes: scanned.bytes, lineCount: file.getLineStarts().length,
        parseStatus: program.getSyntacticDiagnostics(file).length ? "error" : "ok",
      };
    });
    const fileByAbsolute = new Map(sourceFiles.map((source, index) => [path.resolve(source.fileName), files[index]!]));
    const evidence = new Map<string, EvidenceRecord>();
    const relations = new Map<string, RelationRecord>();
    const unresolved = new Map<string, UnresolvedRecord>();
    const registered: Registered[] = [];
    const byNode = new Map<ts.Node, Registered>();
    const bySymbol = new Map<ts.Symbol, Registered[]>();
    const byDeclaration = new Map<string, Registered[]>();
    const declarationKey = (node: ts.Node): string => `${path.resolve(node.getSourceFile().fileName)}:${node.pos}:${node.end}:${node.kind}`;
    const owners = new Map<ts.Node, string>();
    hooks.onProgress?.("extracting");

    function signatureOf(node: ts.Node): string {
      const declaration = (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) && node.initializer
        ? node.initializer : node;
      if (ts.isFunctionLike(declaration)) {
        const signature = checker.getSignatureFromDeclaration(declaration);
        if (signature) return checker.signatureToString(signature, declaration, ts.TypeFormatFlags.NoTruncation).slice(0, 400);
      }
      if ("name" in node && node.name) return checker.typeToString(checker.getTypeAtLocation(node.name as ts.Node), node, ts.TypeFormatFlags.NoTruncation).slice(0, 400);
      return node.getText().slice(0, 400);
    }

    function makeEvidence(node: ts.Node): string {
      const source = node.getSourceFile();
      const file = fileByAbsolute.get(path.resolve(source.fileName))!;
      const start = node.getStart(source);
      const end = node.getEnd();
      const id = shortId("evidence", `${file.id}:${file.hash}:${start}:${end}`);
      if (!evidence.has(id)) evidence.set(id, { id, fileId: file.id, fileHash: file.hash, range: rangeOf(source, start, end), excerpt: source.text.slice(start, end), extractor: `typescript@${ts.version}` });
      return id;
    }
    function addEdge(kind: RelationKind, from: string, to: string, node: ts.Node, usage?: RelationRecord["usage"]): void {
      const evidenceId = makeEvidence(node);
      const id = shortId("edge", `${kind}:${from}:${to}:${evidenceId}:${usage ?? ""}`);
      const entry: RelationRecord = { id, from, to, kind, evidenceId, origin: kind === "REGISTERS_CALLBACK" ? "rule" : "static", resolution: kind === "REGISTERS_CALLBACK" ? "callback-argument-rule" : kind === "CONTAINS" ? "syntax" : "compiler-symbol" };
      if (usage) entry.usage = usage;
      relations.set(id, entry);
    }
    function addUnresolved(kind: UnresolvedRecord["kind"], from: string, node: ts.Node, reason: UnresolvedRecord["reason"], candidateIds: string[] = []): void {
      const evidenceId = makeEvidence(node);
      const id = shortId("unresolved", `${kind}:${from}:${evidenceId}:${reason}`);
      unresolved.set(id, { id, from, kind, reason, evidenceId, candidateIds });
    }
    function canonical(symbol: ts.Symbol | undefined): ts.Symbol | undefined {
      const seen = new Set<ts.Symbol>();
      while (symbol && (symbol.flags & ts.SymbolFlags.Alias)) {
        if (seen.has(symbol)) return undefined;
        seen.add(symbol);
        const next = checker.getAliasedSymbol(symbol);
        if (next === symbol) return undefined;
        symbol = next;
      }
      return symbol;
    }
    function ownerOf(node: ts.Node): string {
      for (let current: ts.Node | undefined = node; current; current = current.parent) {
        const owner = owners.get(current);
        if (owner) return owner;
      }
      return fileByAbsolute.get(path.resolve(node.getSourceFile().fileName))!.id;
    }
    function collect(node: ts.Node, parentId: string, scope: string): void {
      const kind = declarationKind(node);
      let nextParent = parentId;
      let nextScope = scope;
      if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) && !node.name) && !byNode.has(node)) {
        const file = fileByAbsolute.get(path.resolve(node.getSourceFile().fileName))!;
        const position = node.getSourceFile().getLineAndCharacterOfPosition(node.getStart());
        const name = ts.isFunctionExpression(node) && node.name ? node.name.text : ts.isFunctionDeclaration(node) ? "default" : `<anonymous@${position.line + 1}:${position.character + 1}>`;
        const qualifiedName = scope ? `${scope}.${name}` : name;
        const id = shortId("symbol", `${file.path}:${node.pos}:function:${qualifiedName}`);
        const symbol = "name" in node && node.name ? checker.getSymbolAtLocation(node.name) : undefined;
        const record: SymbolRecord = { id, fileId: file.id, name, qualifiedName, kind: "function", parentId, range: rangeOf(node.getSourceFile(), node.getStart(), node.getEnd()), signature: signatureOf(node), exported: ts.isFunctionDeclaration(node) };
        const entry = { node, record, symbol, callable: true };
        registered.push(entry);
        byNode.set(node, entry);
        if (symbol) bySymbol.set(symbol, [entry]);
        owners.set(node, id);
        nextParent = id;
        nextScope = qualifiedName;
      }
      if (kind && "name" in node && node.name && (ts.isIdentifier(node.name as ts.Node) || ts.isStringLiteral(node.name as ts.Node))) {
        const declaration = node as NamedDeclaration;
        const name = declaration.name.getText();
        const symbol = checker.getSymbolAtLocation(declaration.name);
        if ((kind === "function" || kind === "method") && !hasExecutableBody(node)
          && symbol?.declarations?.some(hasExecutableBody)) return;
        // Overload signatures share a symbol; prefer the implementation for location and ownership.
        let existing = symbol ? bySymbol.get(symbol)?.[0] : undefined;
        if (existing && (kind === "function" || kind === "method") && !hasExecutableBody(node)) {
          byNode.set(node, existing);
          owners.set(node, existing.record.id);
          return;
        }
        if (existing && hasExecutableBody(node) && (kind === "function" || kind === "method")) {
          existing.node = node;
          existing.callable = true;
          existing.record.range = rangeOf(node.getSourceFile(), node.getStart(), node.getEnd());
          existing.record.signature = signatureOf(node);
          byNode.set(node, existing);
        } else {
          const qualifiedName = scope ? `${scope}.${name}` : name;
          const file = fileByAbsolute.get(path.resolve(node.getSourceFile().fileName))!;
          const id = shortId("symbol", `${file.path}:${node.pos}:${kind}:${qualifiedName}`);
          const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
          const isExported = !!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
            || ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent) && ts.isVariableStatement(node.parent.parent)
              && !!node.parent.parent.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
          const record: SymbolRecord = { id, fileId: file.id, name, qualifiedName, kind, parentId, range: rangeOf(node.getSourceFile(), node.getStart(), node.getEnd()), signature: signatureOf(node), exported: isExported };
          existing = { node, record, symbol, callable: hasExecutableBody(node) };
          registered.push(existing);
          byNode.set(node, existing);
          if (symbol) bySymbol.set(symbol, [...(bySymbol.get(symbol) ?? []), existing]);
        }
        nextParent = existing.record.id;
        nextScope = existing.record.qualifiedName;
        // A local initializer is executed by its containing function, not by the variable.
        // Parameter annotations also belong to the declaring function's dependency surface.
        if (kind !== "variable" && kind !== "parameter" && kind !== "property" || existing.callable) owners.set(node, nextParent);
        if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
          byNode.set(node.initializer, existing);
          owners.set(node.initializer, nextParent);
          if (ts.isFunctionExpression(node.initializer) && node.initializer.name) {
            const innerSymbol = checker.getSymbolAtLocation(node.initializer.name);
            if (innerSymbol) bySymbol.set(innerSymbol, [existing]);
          }
        }
      }
      ts.forEachChild(node, (child) => collect(child, nextParent, nextScope));
    }
    for (const source of sourceFiles) { activate(source); collect(source, fileByAbsolute.get(path.resolve(source.fileName))!.id, ""); }
    for (const entry of registered) {
      const key = declarationKey(entry.node);
      byDeclaration.set(key, [...(byDeclaration.get(key) ?? []), entry]);
      addEdge("CONTAINS", entry.record.parentId, entry.record.id, entry.node);
    }

    function symbolAt(expression: ts.Node): ts.Symbol | undefined {
      if (ts.isShorthandPropertyAssignment(expression.parent)) return canonical(checker.getShorthandAssignmentValueSymbol(expression.parent));
      if (ts.isPropertyAccessExpression(expression)) expression = expression.name;
      return canonical(checker.getSymbolAtLocation(expression));
    }
    function targets(symbol: ts.Symbol | undefined): Registered[] {
      if (!symbol) return [];
      // Independent TS programs have different Symbol/Node objects for the same captured declaration.
      // Join only exact source positions, never names or generated declaration text.
      const entries = bySymbol.get(symbol) ?? (symbol.declarations ?? []).flatMap((declaration) => byNode.get(declaration) ?? byDeclaration.get(declarationKey(declaration)) ?? []);
      return [...new Map(entries.map((entry) => [entry.record.id, entry])).values()];
    }
    // Public exports can be declared separately (export { local }) or through a barrel.
    for (const source of sourceFiles) {
      activate(source);
      const moduleSymbol = checker.getSymbolAtLocation(source);
      if (!moduleSymbol) continue;
      for (const exported of checker.getExportsOfModule(moduleSymbol)) {
        for (const target of targets(canonical(exported))) target.record.exported = true;
      }
    }
    function missingReason(symbol: ts.Symbol | undefined): UnresolvedRecord["reason"] {
      const declarations = symbol?.declarations;
      if (!declarations?.length) return "unresolved";
      const hasInternal = declarations.some((declaration) => fileByAbsolute.has(path.resolve(declaration.getSourceFile().fileName)));
      return hasInternal ? "unsupported" : "external";
    }
    function inspectImport(node: ts.ImportDeclaration | ts.ExportDeclaration): void {
      const specifier = node.moduleSpecifier;
      if (!specifier || !ts.isStringLiteral(specifier)) return;
      const from = fileByAbsolute.get(path.resolve(node.getSourceFile().fileName))!.id;
      const symbol = symbolAt(specifier);
      const declaration = symbol?.declarations?.find(ts.isSourceFile);
      const to = declaration ? fileByAbsolute.get(path.resolve(declaration.fileName))?.id : undefined;
      let usage: RelationRecord["usage"] = "value";
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        if (clause?.isTypeOnly) usage = "type";
        else if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          const flags = clause.namedBindings.elements.map((element) => element.isTypeOnly);
          if (!clause.name && flags.length && flags.every(Boolean)) usage = "type";
          else if (flags.some(Boolean)) usage = "mixed";
        }
      } else if (node.isTypeOnly) usage = "type";
      else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        const flags = node.exportClause.elements.map((element) => element.isTypeOnly);
        if (flags.length && flags.every(Boolean)) usage = "type";
        else if (flags.some(Boolean)) usage = "mixed";
      }
      if (to) addEdge("IMPORTS", from, to, specifier, usage);
      else {
        let reason = symbol ? "external" as const : "unresolved" as UnresolvedRecord["reason"];
        if (specifier.text.startsWith(".")) {
          const location = path.resolve(path.dirname(node.getSourceFile().fileName), specifier.text);
          if ([...scan.excluded].some((excluded) => location === excluded || within(excluded, location) || location.replace(/\.[cm]?js$/, "") === excluded.replace(/\.(?:tsx?|jsx?)$/, ""))) reason = "excluded";
        }
        addUnresolved("IMPORTS", from, specifier, reason);
      }
    }
    function inspectCall(node: ts.CallExpression): void {
      const from = ownerOf(node);
      const expression = unwrap(node.expression);
      const symbol = symbolAt(expression);
      const candidates = byNode.has(expression) ? [byNode.get(expression)!] : targets(symbol);
      const type = checker.getTypeAtLocation(expression);
      const dynamic = !!(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter))
        || candidates.some((candidate) => candidate.record.kind === "parameter");
      if (expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(expression) && expression.text === "require" && !candidates.length) {
        addUnresolved("CALLS", from, node.expression, "unsupported");
      } else if (dynamic) addUnresolved("CALLS", from, node.expression, "dynamic", candidates.map((entry) => entry.record.id));
      else if (candidates.length > 1) addUnresolved("CALLS", from, node.expression, "ambiguous", candidates.map((entry) => entry.record.id));
      else if (candidates[0]?.callable) addEdge("CALLS", from, candidates[0].record.id, node.expression);
      else addUnresolved("CALLS", from, node.expression, candidates.length ? "dynamic" : missingReason(symbol), candidates.map((entry) => entry.record.id));
      for (const argument of node.arguments) {
        const unwrapped = unwrap(argument);
        const argumentTargets = byNode.has(unwrapped) ? [byNode.get(unwrapped)!] : targets(symbolAt(unwrapped));
        if (argumentTargets.length === 1 && argumentTargets[0]!.callable) {
          addEdge("REGISTERS_CALLBACK", from, argumentTargets[0]!.record.id, argument);
        }
      }
    }
    function inspectJsx(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement): void {
      if (ts.isIdentifier(node.tagName) && /^[a-z]/.test(node.tagName.text)) return;
      const from = ownerOf(node);
      const symbol = symbolAt(node.tagName);
      const matches = targets(symbol);
      if (matches.length === 1 && (matches[0]!.callable || matches[0]!.record.kind === "class")) addEdge("RENDERS", from, matches[0]!.record.id, node.tagName);
      else addUnresolved("RENDERS", from, node.tagName, matches.length > 1 ? "ambiguous" : missingReason(symbol), matches.map((entry) => entry.record.id));
    }
    function inspect(node: ts.Node): void {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) inspectImport(node);
      if (ts.isCallExpression(node)) inspectCall(node);
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) inspectJsx(node);
      if (ts.isIdentifier(node) && isReferenceIdentifier(node)) {
        const from = ownerOf(node);
        const symbol = symbolAt(node);
        const matches = targets(symbol);
        if (matches.length) {
          for (const target of matches) addEdge("REFERENCES", from, target.record.id, node, isTypeUsage(node) ? "type" : "value");
        } else if (symbol || !(ts.isJsxAttribute(node.parent) || ts.isJsxNamespacedName(node.parent))) {
          addUnresolved("REFERENCES", from, node, missingReason(symbol));
        }
      }
      ts.forEachChild(node, inspect);
    }
    for (const file of sourceFiles) { activate(file); inspect(file); }
    hooks.onProgress?.("verifying");
    // Re-scan the allowlist to catch new/deleted files and changed ignore rules as well as edits.
    const refreshed = scanProject(request);
    let stale = refreshed.files.size !== scan.files.size
      || [...scan.files].some(([name, file]) => refreshed.files.get(name)?.hash !== file.hash)
      || JSON.stringify([...scan.configTexts].sort()) !== JSON.stringify([...refreshed.configTexts].sort());
    for (const input of compiler.configInputs) {
      try { if (!within(scan.root, realpathSync(input.path)) || hash(readFileSync(input.path, "utf8")) !== input.hash) stale = true; }
      catch { stale = true; }
    }
    if (compiler.missingInputs.some((file) => existsSync(file))) stale = true;
    if (stale) diagnostics.push({ code: "STALE_INPUT", severity: "warning", message: "Source changed during analysis; refresh before using source positions." });
    const symbolRecords = registered.map((entry) => entry.record);
    const relationRecords = [...relations.values()];
    const unresolvedRecords = [...unresolved.values()];
    const snapshot: AnalysisSnapshot = {
      schemaVersion: "0.1",
      id: shortId("snapshot", JSON.stringify({ files: files.map((file) => [file.path, file.hash]), config: compiler.configuration.hash, analyzer: VERSION, compiler: ts.version })),
      rootDir: scan.root, createdAt: new Date().toISOString(),
      status: stale || diagnostics.some((entry) => entry.severity === "error" || entry.severity === "warning") ? "partial" : "complete",
      stale, analyzer: { name: this.name, version: VERSION, compilerVersion: ts.version },
      configuration: { ...compiler.configuration, inputs: compiler.configInputs.map((input) => ({ path: slash(path.relative(scan.root, input.path)), hash: input.hash })), missingInputs: compiler.missingInputs.map((file) => slash(path.relative(scan.root, file))) },
      scope: { maxFiles: request.maxFiles ?? 500, maxFileBytes: request.maxFileBytes ?? 1024 * 1024 },
      files, symbols: symbolRecords,
      relations: relationRecords, evidence: [...evidence.values()], unresolved: unresolvedRecords,
      diagnostics, skipped: scan.skipped,
      statistics: { files: files.length, symbols: symbolRecords.length, relations: relationRecords.length, unresolved: unresolvedRecords.length, parseErrors: files.filter((file) => file.parseStatus === "error").length, durationMs: Math.round((performance.now() - started) * 100) / 100 },
      limitations: [
        "Static symbol relations are not runtime execution traces or complete data flow.",
        "Callback arguments are rule candidates, not proven callback execution.",
        "Dynamic dispatch, callable parameters and CommonJS require have no proven direct call edge; anonymous callbacks have their own lexical owner.",
        "Scope is the scanned TS/JS allowlist; bounded in-root project references supply per-project options without expanding the source scope.",
        "Workspace output-to-source redirects require unique compiler output paths; ambiguous configurations and package identities remain explicit gaps.",
        "Unbuilt workspace entries may use literal supported tsdown metadata or explicit svelte-package input/output paths; dynamic build configuration is not executed or inferred.",
        "Third-party declarations may inform types inside the root; dependency implementations are not indexed.",
        "Complete means the analysis pass completed without reported errors; unresolved relations remain separately visible.",
      ],
    };
    assertSnapshotIntegrity(snapshot);
    return snapshot;
  }
}

export interface AnalyzerHooks {
  onProgress?: (phase: AnalysisPhase) => void;
  onSources?: (sources: CapturedSource[]) => void;
}
export const analyzeProject = (request: AnalyzeRequest, hooks?: AnalyzerHooks): AnalysisSnapshot => new TypeScriptAnalyzer().analyze(request, hooks);

/** A bounded scan only: no compiler and no execution. Compare source scope and configuration inputs. */
export function isSnapshotStale(snapshot: AnalysisSnapshot): boolean {
  if (snapshot.stale) return true;
  if (snapshot.analyzer.name === "typescript-compiler" && snapshot.analyzer.version !== VERSION) return true;
  try {
    const scan = scanProject({ rootDir: snapshot.rootDir, ...snapshot.scope });
    if (scan.files.size !== snapshot.files.length) return true;
    for (const file of snapshot.files) {
      if (scan.files.get(path.resolve(snapshot.rootDir, file.path))?.hash !== file.hash) return true;
    }
    for (const input of snapshot.configuration.inputs ?? []) {
      const absolute = path.resolve(snapshot.rootDir, input.path);
      if (!within(snapshot.rootDir, absolute) || !within(snapshot.rootDir, realpathSync(absolute))) return true;
      if (hash(readFileSync(absolute, "utf8")) !== input.hash) return true;
    }
    for (const missing of snapshot.configuration.missingInputs ?? []) {
      const absolute = path.resolve(snapshot.rootDir, missing);
      if (!within(snapshot.rootDir, absolute) || existsSync(absolute)) return true;
    }
    const knownInputs = new Set(snapshot.configuration.inputs?.map((input) => input.path));
    for (const name of [...scan.configTexts.keys(), path.join(snapshot.rootDir, "tsconfig.json"), path.join(snapshot.rootDir, "jsconfig.json")]) {
      try {
        realpathSync(name);
        if (!knownInputs.has(slash(path.relative(snapshot.rootDir, name)))) return true;
      } catch { /* Absent optional configuration. */ }
    }
    return false;
  } catch { return true; }
}
