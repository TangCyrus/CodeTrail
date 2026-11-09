import path from "node:path";
import ts from "typescript";
import type { DispatchResult, ObjectDispatchContext } from "./object-dispatch.js";

const unwrap = (node: ts.Expression): ts.Expression => {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
  return node;
};
const constant = (node: ts.VariableDeclaration): boolean => ts.isVariableDeclarationList(node.parent) && !!(node.parent.flags & ts.NodeFlags.Const);
const rejected = (code: string, message: string, node: ts.Node): DispatchResult => ({ failure: { code, message, nodes: [node] } });

/** Resolve invocation of a bound value, never treat creating a binding as executing its body. */
export class BoundCallResolver {
  private readonly library = path.dirname(ts.getDefaultLibFilePath({}));
  private readonly functionSafety = new Map<string, boolean>();
  private readonly bindCache = new WeakMap<ts.PropertyAccessExpression, boolean>();
  private readonly returnCache = new WeakMap<ts.Block, ts.ReturnStatement[]>();
  constructor(private readonly context: ObjectDispatchContext) {}

  forward(call: ts.CallExpression): DispatchResult | undefined {
    const callee = unwrap(call.expression);
    if (!ts.isPropertyAccessExpression(callee) || !["call", "apply"].includes(callee.name.text)
      || !call.arguments.length || call.arguments.some(ts.isSpreadElement) || !this.nativeBind(callee)) return;
    const declarations = this.declarations(unwrap(callee.expression)), implementations = declarations.flatMap(declaration => this.implementation(declaration) ?? []);
    if (implementations.length !== 1 || !declarations.every(declaration => this.closedFunction(declaration))) return;
    return { value: implementations[0]!, via: [callee, call.arguments[0]!, implementations[0]!] };
  }

  private symbol(node: ts.Node): ts.Symbol | undefined {
    const checker = this.context.checker(node);
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol;
  }
  private declarations(node: ts.Node): ts.Node[] {
    return (this.symbol(node)?.declarations ?? []).flatMap(declaration => this.context.native(declaration) ?? []);
  }
  private implementation(node: ts.Node): ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | undefined {
    if (ts.isFunctionDeclaration(node) && node.body) return node;
    if (ts.isVariableDeclaration(node) && constant(node) && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) return node.initializer;
    return;
  }
  private standard(node: ts.Node): boolean {
    const file = node.getSourceFile();
    return file.isDeclarationFile && path.resolve(path.dirname(file.fileName)) === path.resolve(this.library);
  }
  private expanded(node: ts.Expression): ts.Expression {
    while (ts.isParenthesizedExpression(node.parent) || ts.isAsExpression(node.parent) || ts.isNonNullExpression(node.parent)
      || ts.isTypeAssertionExpression(node.parent) || ts.isSatisfiesExpression(node.parent)) node = node.parent;
    return node;
  }
  private typeOnly(node: ts.Node): boolean {
    for (; node.parent && !ts.isStatement(node); node = node.parent) if (ts.isTypeNode(node)) return true;
    return false;
  }
  private nativeBind(access: ts.PropertyAccessExpression): boolean {
    const cached = this.bindCache.get(access);
    if (cached !== undefined) return cached;
    const result = this.nativeBindUncached(access);
    this.bindCache.set(access, result);
    return result;
  }
  private nativeBindUncached(access: ts.PropertyAccessExpression): boolean {
    const declarations = this.symbol(access.name)?.declarations;
    if (!declarations?.length || !declarations.every(node => this.standard(node) && !this.context.written.has(this.context.key(node)))) return false;
    // A captured alias/escape of Function or Function.prototype can hide an intrinsic replacement.
    for (const key of ["Function", "prototype"]) {
      const checker = this.context.checker(access);
      const global = checker.resolveName("Function", access, ts.SymbolFlags.Value, false);
      const constructor = global?.valueDeclaration;
      const symbol = key === "Function" ? global : constructor && checker.getTypeAtLocation(constructor).getProperty("prototype");
      for (const declaration of symbol?.declarations ?? []) {
        for (const reference of this.context.uses.get(this.context.key(declaration)) ?? []) {
          if (this.typeOnly(reference)) continue;
          const value = this.expanded(ts.isPropertyAccessExpression(reference.parent) && reference.parent.name === reference ? reference.parent : reference);
          const parent = value.parent;
          if (ts.isPropertyAccessExpression(parent) && parent.expression === value) {
            if (key === "Function" && parent.name.text === "prototype") continue;
            if (key === "prototype" && ["bind", "call", "apply"].includes(parent.name.getText())
              && ts.isCallExpression(parent.parent) && parent.parent.expression === parent) continue;
          }
          return false;
        }
      }
    }
    return true;
  }
  private closedFunction(declaration: ts.Node): boolean {
    const key = this.context.key(declaration), cached = this.functionSafety.get(key);
    if (cached !== undefined) return cached;
    const pending = [declaration], visited = new Set<string>();
    let safe = true, count = 0;
    for (let index = 0; index < pending.length && safe; index++) {
      const current = pending[index]!, currentKey = this.context.key(current);
      if (visited.has(currentKey)) continue;
      visited.add(currentKey);
      if (visited.size > 128 || this.context.written.has(currentKey)) { safe = false; break; }
      let statement: ts.Node = current;
      if (ts.isVariableDeclaration(current)) statement = current.parent.parent;
      if (ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) { safe = false; break; }
      const implementation = this.implementation(current);
      if (implementation && ts.isFunctionExpression(implementation) && implementation.name) pending.push(implementation);
      for (const reference of this.context.uses.get(currentKey) ?? []) {
        if (++count > 1024) { safe = false; break; }
        if ("name" in current && reference === current.name || this.typeOnly(reference)) continue;
        const value = this.expanded(reference), parent = value.parent;
        if (ts.isCallExpression(parent) && parent.expression === value) continue;
        if (ts.isVariableDeclaration(parent) && parent.initializer === value && ts.isIdentifier(parent.name) && constant(parent)) { pending.push(parent); continue; }
        if (ts.isPropertyAccessExpression(parent) && parent.expression === value && ["name", "length"].includes(parent.name.text)) continue;
        if (ts.isPropertyAccessExpression(parent) && parent.expression === value && ["bind", "call", "apply"].includes(parent.name.getText())
          && ts.isCallExpression(parent.parent) && parent.parent.expression === parent) continue;
        safe = false; break;
      }
    }
    this.functionSafety.set(key, safe);
    return safe;
  }

  resolve(expression: ts.Expression, depth = 0, seen = new Set<string>()): DispatchResult | undefined {
    if (depth > 12) return rejected("binding-budget", "绑定函数来源追踪达到深度上限。", expression);
    expression = unwrap(expression);
    if (ts.isIdentifier(expression)) {
      const declarations = this.declarations(expression), declaration = declarations[0];
      if (declarations.length !== 1 || !declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return;
      const key = this.context.key(declaration);
      if (seen.has(key)) return;
      const result = this.resolve(declaration.initializer, depth + 1, new Set([...seen, key]));
      if (result && (!constant(declaration) || this.context.written.has(key))) return rejected("binding-value-written", "绑定结果存在可变别名或未支持的写入，无法固定被调用的函数。", declaration);
      return result && "value" in result ? { ...result, via: [...result.via, declaration] } : result;
    }
    if (!ts.isCallExpression(expression)) return;
    const callee = unwrap(expression.expression);
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === "bind") {
      if (!expression.arguments.length || expression.arguments.some(ts.isSpreadElement) || !this.nativeBind(callee)) return rejected("binding-intrinsic", "bind 不是可确认且未被改写的标准库绑定方法。", callee);
      const declarations = this.declarations(unwrap(callee.expression)), implementations = declarations.flatMap(declaration => this.implementation(declaration) ?? []);
      const target = implementations[0];
      if (implementations.length !== 1 || !target || !declarations.every(declaration => this.closedFunction(declaration))) return rejected("binding-target", "绑定前的函数存在重写、暴露或未确认来源，无法确定被调用的函数体。", callee.expression);
      return { value: target, via: [callee, expression.arguments[0]!, target] };
    }
    if (!ts.isIdentifier(callee)) return;
    const declarations = this.declarations(callee), implementations = declarations.flatMap(declaration => this.implementation(declaration) ?? []);
    const implementation = implementations[0];
    if (implementations.length !== 1 || !implementation?.body || !ts.isBlock(implementation.body) || implementation.asteriskToken
      || implementation.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) || declarations.some(node => this.context.written.has(this.context.key(node)))) return;
    const returns: ts.ReturnStatement[] = this.returnCache.get(implementation.body) ?? [];
    const visit = (node: ts.Node): void => { if (ts.isFunctionLike(node)) return; if (ts.isReturnStatement(node)) returns.push(node); ts.forEachChild(node, visit); };
    if (!this.returnCache.has(implementation.body)) { visit(implementation.body); this.returnCache.set(implementation.body, returns); }
    const returned = returns[0];
    if (returns.length !== 1 || !returned?.expression || returned.parent !== implementation.body) return;
    const result = this.resolve(returned.expression, depth + 1, seen);
    return result && "value" in result ? { ...result, via: [...result.via, expression.expression, returned] } : result;
  }
}
