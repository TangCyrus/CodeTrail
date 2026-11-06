import ts from "typescript";

export interface DispatchFailure { code: string; message: string; nodes: ts.Node[] }
export type DispatchResult = { value: ts.Node; via: ts.Node[] } | { failure: DispatchFailure };
interface Origin { literal: ts.ObjectLiteralExpression; via: ts.Node[]; bindings: ts.VariableDeclaration[]; returns: ts.ReturnStatement[] }
type ObjectResult = Origin | { failure: DispatchFailure };
export interface ObjectDispatchContext {
  key(node: ts.Node): string;
  native(node: ts.Node): ts.Node | undefined;
  checker(node: ts.Node): ts.TypeChecker;
  uses: ReadonlyMap<string, readonly ts.Identifier[]>;
}
const unwrap = (expression: ts.Expression): ts.Expression => {
  while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)
    || ts.isNonNullExpression(expression) || ts.isSatisfiesExpression(expression)) expression = expression.expression;
  return expression;
};
const failure = (code: string, message: string, ...nodes: ts.Node[]): { failure: DispatchFailure } => ({ failure: { code, message, nodes: nodes.slice(0, 2) } });
const constant = (node: ts.VariableDeclaration): boolean => ts.isVariableDeclarationList(node.parent) && !!(node.parent.flags & ts.NodeFlags.Const);
const exported = (node: ts.VariableDeclaration): boolean => ts.isVariableStatement(node.parent.parent)
  && !!node.parent.parent.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);

/** Closed local object values only. No matching interface implementations by type/name. */
export class ObjectDispatchResolver {
  private readonly declarationCache = new WeakMap<ts.Node, ts.Node[]>();
  private readonly memberCache = new WeakMap<ts.ObjectLiteralExpression, ReturnType<ObjectDispatchResolver["membersUncached"]>>();
  private readonly functionCache = new WeakMap<ts.Node, ts.FunctionLikeDeclaration | null>();
  private readonly returnCache = new WeakMap<ts.Node, ts.ReturnStatement[]>();
  private readonly writeCache = new Map<string, boolean>();
  private readonly safetyCache = new Map<string, DispatchFailure | null>();
  constructor(private readonly context: ObjectDispatchContext) {}

  private declarations(node: ts.Node): ts.Node[] {
    const cached = this.declarationCache.get(node);
    if (cached) return cached;
    const checker = this.context.checker(node);
    let symbol = ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent)
      ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const declarations = [...new Map((symbol?.declarations ?? []).flatMap(declaration => {
      const native = this.context.native(declaration);
      return native ? [[this.context.key(native), native] as const] : [];
    })).values()];
    this.declarationCache.set(node, declarations);
    return declarations;
  }

  private property(expression: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
    if (ts.isPropertyAccessExpression(expression)) return ts.isIdentifier(expression.name) ? expression.name.text : undefined;
    const argument = expression.argumentExpression && unwrap(expression.argumentExpression);
    return argument && ts.isStringLiteral(argument) ? argument.text : undefined;
  }

  private members(literal: ts.ObjectLiteralExpression): Map<string, ts.ObjectLiteralElementLike> | { failure: DispatchFailure } {
    let cached = this.memberCache.get(literal);
    if (!cached) { cached = this.membersUncached(literal); this.memberCache.set(literal, cached); }
    return cached;
  }

  private membersUncached(literal: ts.ObjectLiteralExpression): Map<string, ts.ObjectLiteralElementLike> | { failure: DispatchFailure } {
    const members = new Map<string, ts.ObjectLiteralElementLike>();
    for (const member of literal.properties) {
      if ((!ts.isPropertyAssignment(member) && !ts.isShorthandPropertyAssignment(member) && !ts.isMethodDeclaration(member))
        || !member.name || !ts.isIdentifier(member.name) && !ts.isStringLiteral(member.name)) {
        return failure("object-shape", "对象含展开、访问器或动态成员，无法确认最终属性值。", member);
      }
      if (members.has(member.name.text)) return failure("object-shape", "对象成员名称重复，保留分发缺口。", member);
      members.set(member.name.text, member);
    }
    return members;
  }

  private memberValue(member: ts.ObjectLiteralElementLike): ts.Expression | ts.MethodDeclaration | undefined {
    return ts.isMethodDeclaration(member) ? member : ts.isPropertyAssignment(member) ? unwrap(member.initializer)
      : ts.isShorthandPropertyAssignment(member) ? member.name : undefined;
  }

  private object(expression: ts.Expression, depth: number, seen: Set<string>): ObjectResult {
    if (depth > 12) return failure("dispatch-budget", "对象来源追踪达到深度上限。", expression);
    expression = unwrap(expression);
    if (ts.isObjectLiteralExpression(expression)) return { literal: expression, via: [expression], bindings: [], returns: [] };
    if (ts.isIdentifier(expression)) {
      const declarations = this.declarations(expression), declaration = declarations[0];
      if (declarations.length !== 1 || !declaration) return failure("receiver-origin", "接收者没有唯一的已捕获源码声明。", expression);
      if (ts.isParameter(declaration) || ts.isBindingElement(declaration)) return failure("receiver-parameter", "接收者来自参数或未支持的解构来源，接口签名不能确定实际对象。", declaration);
      if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) return failure("receiver-origin", "接收者没有支持的对象初始化来源。", declaration);
      if (!constant(declaration)) return failure("receiver-mutable", "接收者绑定可被重写，无法固定到唯一对象。", declaration);
      const key = this.context.key(declaration);
      if (seen.has(key)) return failure("receiver-cycle", "对象别名形成循环，无法确认来源。", declaration);
      const next = this.object(declaration.initializer, depth + 1, new Set([...seen, key]));
      return "failure" in next ? next : { ...next, bindings: [...next.bindings, declaration], via: [...next.via, declaration] };
    }
    if (ts.isCallExpression(expression)) {
      const callee = unwrap(expression.expression);
      const location = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
      const declarations = this.declarations(location);
      const implementations = declarations.flatMap(declaration => {
        if (ts.isFunctionDeclaration(declaration) && declaration.body) return [declaration as ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression];
        if (ts.isVariableDeclaration(declaration) && constant(declaration) && declaration.initializer
          && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) return [declaration.initializer];
        return [];
      });
      const implementation = implementations[0];
      if (implementations.length !== 1 || !implementation || !implementation.body || !ts.isBlock(implementation.body)
        || implementation.asteriskToken || implementation.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
        return failure("factory-origin", "工厂没有唯一的同步源码实现，不能由返回类型推断对象。", expression);
      }
      if (declarations.some(declaration => this.reassigned(declaration))) return failure("factory-written", "工厂绑定有赋值，不能确认被调用的实现。", implementation);
      const returns: ts.ReturnStatement[] = this.returnCache.get(implementation) ?? [];
      const visit = (node: ts.Node): void => {
        if (ts.isFunctionLike(node)) return;
        if (ts.isReturnStatement(node)) returns.push(node);
        ts.forEachChild(node, visit);
      };
      if (!this.returnCache.has(implementation)) { visit(implementation.body); this.returnCache.set(implementation, returns); }
      const returned = returns[0];
      if (returns.length !== 1 || !returned?.expression || returned.parent !== implementation.body) return failure("factory-returns", "工厂存在分支返回或非直接返回，无法确定唯一对象来源。", implementation);
      const result = this.object(returned.expression, depth + 1, seen);
      if ("failure" in result) return result;
      // A captured/global shared object is not a fresh allocation for this factory invocation.
      if (result.literal.getStart() < implementation.body.getStart() || result.literal.end > implementation.body.end
        || result.literal.getSourceFile() !== implementation.getSourceFile()) return failure("shared-return", "工厂返回共享或外部捕获对象，不能证明该调用获得独立对象。", returned);
      return { ...result, returns: [...result.returns, returned], via: [...result.via, expression.expression, returned] };
    }
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const name = this.property(expression);
      if (name === undefined) return failure("computed-member", "属性名称是动态表达式，无法固定调用目标。", expression);
      const base = this.object(expression.expression, depth + 1, seen);
      if ("failure" in base) return base;
      const safe = this.safe(base, name);
      if (safe) return { failure: safe };
      // Extracted aliases of a nested object require a separate points-to graph.
      // Safety of the containing object's binding alone cannot establish that.
      return failure("receiver-nested", "嵌套对象属性及其别名尚未形成受控来源，保留分发缺口。", expression);
    }
    return failure(expression.kind === ts.SyntaxKind.ThisKeyword ? "receiver-this" : "receiver-origin",
      expression.kind === ts.SyntaxKind.ThisKeyword ? "this 的具体接收者未被固定，保留动态分发缺口。" : "接收者来自条件、队列、调用结果或其他未支持的数据流。", expression);
  }

  private expanded(node: ts.Expression): ts.Expression {
    while (ts.isParenthesizedExpression(node.parent) || ts.isAsExpression(node.parent) || ts.isTypeAssertionExpression(node.parent)
      || ts.isNonNullExpression(node.parent) || ts.isSatisfiesExpression(node.parent)) node = node.parent;
    return node;
  }

  private write(node: ts.Expression): boolean {
    node = this.expanded(node);
    const parent = node.parent;
    if (ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return true;
    if ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) && (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)) return true;
    if (ts.isDeleteExpression(parent)) return true;
    if ((ts.isForInStatement(parent) || ts.isForOfStatement(parent)) && parent.initializer === node) return true;
    // Destructuring assignment targets are uncommon; reject the whole containing assignment conservatively.
    for (let current: ts.Node = node; ts.isArrayLiteralExpression(current.parent) || ts.isObjectLiteralExpression(current.parent)
      || ts.isPropertyAssignment(current.parent) || ts.isShorthandPropertyAssignment(current.parent) || ts.isSpreadElement(current.parent) || ts.isSpreadAssignment(current.parent); current = current.parent) {
      const container = current.parent.parent;
      if (ts.isBinaryExpression(container) && container.operatorToken.kind === ts.SyntaxKind.EqualsToken && container.left === current.parent) return true;
      if ((ts.isForInStatement(container) || ts.isForOfStatement(container)) && container.initializer === current.parent) return true;
    }
    return false;
  }

  private reassigned(declaration: ts.Node): boolean {
    const key = this.context.key(declaration), cached = this.writeCache.get(key);
    if (cached !== undefined) return cached;
    const result = (this.context.uses.get(key) ?? []).some(reference => this.write(
      ts.isPropertyAccessExpression(reference.parent) && reference.parent.name === reference ? reference.parent : reference));
    this.writeCache.set(key, result);
    return result;
  }

  private safe(origin: Origin, selected: string): DispatchFailure | undefined {
    const key = JSON.stringify([this.context.key(origin.literal), selected, origin.bindings.map(node => this.context.key(node)).sort(), origin.returns.map(node => this.context.key(node)).sort()]);
    if (this.safetyCache.has(key)) return this.safetyCache.get(key) ?? undefined;
    const result = this.safeUncached(origin, selected);
    this.safetyCache.set(key, result ?? null);
    return result;
  }

  private safeUncached(origin: Origin, selected: string): DispatchFailure | undefined {
    const members = this.members(origin.literal);
    if (!(members instanceof Map)) return members.failure;
    let thisUse: ts.Node | undefined;
    const findThis = (node: ts.Node): void => { if (node.kind === ts.SyntaxKind.ThisKeyword) thisUse ??= node; ts.forEachChild(node, findThis); };
    // No context-insensitive inference for methods that can expose or mutate an unknown `this`.
    for (const member of members.values()) {
      findThis(member);
      const value = this.memberValue(member), implementation = value && this.functionValue(value);
      if (implementation) findThis(implementation);
    }
    if (thisUse) return failure("object-this", "对象方法使用 this，当前追踪不能证明接收者及其别名始终受控。", thisUse).failure;
    const pending = [...origin.bindings], visited = new Set<string>();
    let escaped: DispatchFailure | undefined;
    let references = 0;
    for (let index = 0; index < pending.length; index++) {
      const binding = pending[index]!, key = this.context.key(binding);
      if (visited.has(key)) continue;
      visited.add(key);
      if (visited.size > 128) return failure("dispatch-budget", "对象别名数量达到追踪上限。", binding).failure;
      if (!constant(binding) || exported(binding) || this.reassigned(binding)) return failure("receiver-mutable", "对象绑定可重写或被导出，无法确认唯一受控实例。", binding).failure;
      for (const reference of this.context.uses.get(key) ?? []) {
        if (++references > 1024) return failure("dispatch-budget", "对象引用数量达到追踪上限。", binding).failure;
        if (reference === binding.name || ts.isImportSpecifier(reference.parent)) continue;
        // Type-only mentions do not expose the runtime object.
        let typeOnly = false;
        for (let part: ts.Node = reference; part.parent && !ts.isStatement(part); part = part.parent) if (ts.isTypeNode(part)) { typeOnly = true; break; }
        if (typeOnly) continue;
        const expression = this.expanded(reference), parent = expression.parent;
        if (ts.isVariableDeclaration(parent) && parent.initializer === expression && ts.isIdentifier(parent.name)) { pending.push(parent); continue; }
        if (ts.isReturnStatement(parent) && origin.returns.includes(parent)) continue;
        if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === expression) {
          const name = this.property(parent);
          if (this.write(parent) && (name === selected || name === undefined)) return failure(name === undefined ? "computed-write" : "member-written", "对象目标成员存在直接、别名或动态属性写入，无法确定唯一实现。", parent).failure;
          // Calling an unknown member passes this object as its receiver.
          const access = this.expanded(parent);
          if (ts.isCallExpression(access.parent) && access.parent.expression === access && name !== selected) {
            const other = name === undefined ? undefined : members.get(name), value = other && this.memberValue(other);
            if (!value || !this.functionValue(value)) escaped ??= failure("receiver-escaped", "对象被用作未验证方法的接收者，可能修改目标成员。", parent).failure;
          }
          continue;
        }
        if (ts.isTypeOfExpression(parent) || ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) continue;
        escaped ??= failure("receiver-escaped", "对象被传参、存储、返回或以其他未验证方式暴露，不能排除成员被替换。", expression).failure;
      }
    }
    return escaped;
  }

  private functionValue(value: ts.Expression | ts.MethodDeclaration): ts.FunctionLikeDeclaration | undefined {
    if (this.functionCache.has(value)) return this.functionCache.get(value) ?? undefined;
    const result = this.functionValueUncached(value);
    this.functionCache.set(value, result ?? null);
    return result;
  }

  private functionValueUncached(value: ts.Expression | ts.MethodDeclaration): ts.FunctionLikeDeclaration | undefined {
    if (ts.isMethodDeclaration(value) || ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return value;
    if (!ts.isIdentifier(value)) return;
    const declarations = this.declarations(value);
    const implementations = declarations.flatMap(declaration => {
      if (ts.isFunctionDeclaration(declaration) && declaration.body && !this.reassigned(declaration)) return [declaration as ts.FunctionLikeDeclaration];
      if (ts.isVariableDeclaration(declaration) && constant(declaration) && declaration.initializer && !this.reassigned(declaration)
        && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) return [declaration.initializer];
      return [];
    });
    return implementations.length === 1 ? implementations[0] : undefined;
  }

  resolve(expression: ts.PropertyAccessExpression | ts.ElementAccessExpression): DispatchResult {
    if (ts.isPropertyAccessExpression(expression) && ts.isPrivateIdentifier(expression.name)) return failure("private-member", "私有成员尚未纳入对象来源追踪。", expression);
    const name = this.property(expression);
    if (name === undefined) return failure("computed-member", "属性名称是动态表达式，无法固定调用目标。", expression);
    const origin = this.object(expression.expression, 0, new Set());
    if ("failure" in origin) return origin;
    const members = this.members(origin.literal);
    if (!(members instanceof Map)) return members;
    const member = members.get(name), value = member && this.memberValue(member);
    if (!value) return failure("member-origin", "对象没有明确的自有目标成员实现。", origin.literal);
    const implementation = this.functionValue(value);
    if (!implementation) return failure("member-not-concrete", "成员来自参数、签名、可重写函数或未支持的函数值，不能确定实际实现。", member!);
    const unsafe = this.safe(origin, name);
    if (unsafe) return { failure: unsafe };
    return { value: implementation, via: [...new Set([...origin.via, member!, implementation])] };
  }
}
