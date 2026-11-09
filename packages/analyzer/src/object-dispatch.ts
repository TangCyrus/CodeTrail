import ts from "typescript";

export interface DispatchFailure { code: string; message: string; nodes: ts.Node[] }
export type DispatchResult = { value: ts.Node; via: ts.Node[] } | { failure: DispatchFailure };
type Binding = ts.VariableDeclaration | ts.BindingElement;
interface Origin { literal: ts.ObjectLiteralExpression; root: ts.ObjectLiteralExpression; path: string[]; via: ts.Node[]; bindings: { node: Binding; path: string[] }[]; returns: ts.ReturnStatement[] }
type ObjectResult = Origin | { failure: DispatchFailure };
export interface ObjectDispatchContext {
  key(node: ts.Node): string;
  native(node: ts.Node): ts.Node | undefined;
  checker(node: ts.Node): ts.TypeChecker;
  uses: ReadonlyMap<string, readonly ts.Identifier[]>;
  written: ReadonlySet<string>;
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
const bindingVariable = (node: Binding): ts.VariableDeclaration | undefined => ts.isVariableDeclaration(node) ? node
  : ts.isObjectBindingPattern(node.parent) && ts.isVariableDeclaration(node.parent.parent) ? node.parent.parent : undefined;
const prefix = (a: readonly string[], b: readonly string[]): boolean => a.length <= b.length && a.every((value, index) => value === b[index]);

/** Closed local object values only. No matching interface implementations by type/name. */
export class ObjectDispatchResolver {
  private readonly declarationCache = new WeakMap<ts.Node, ts.Node[]>();
  private readonly memberCache = new WeakMap<ts.ObjectLiteralExpression, ReturnType<ObjectDispatchResolver["membersUncached"]>>();
  private readonly functionCache = new WeakMap<ts.Node, ts.FunctionLikeDeclaration | null>();
  private readonly returnCache = new WeakMap<ts.Node, ts.ReturnStatement[]>();
  private readonly writeCache = new Map<string, boolean>();
  private readonly safetyCache = new Map<string, DispatchFailure | null>();
  private readonly treeCache = new WeakMap<ts.ObjectLiteralExpression, { literals: Map<ts.ObjectLiteralExpression, string[]>; references: { node: ts.Node; path: string[] }[]; failure?: DispatchFailure }>();
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
      if (ts.isPropertyAssignment(member) && member.name.text === "__proto__") return failure("object-prototype", "对象字面量改变原型链，不能把继承方法的 this 当作原型对象。", member);
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
    if (ts.isObjectLiteralExpression(expression)) return { literal: expression, root: expression, path: [], via: [expression], bindings: [], returns: [] };
    if (expression.kind === ts.SyntaxKind.ThisKeyword) {
      const owner = this.thisOwner(expression);
      if (!owner) return failure("receiver-this", "this 不属于可确认的对象方法；类、普通回调及共享函数的接收者继续保留缺口。", expression);
      let root = owner;
      while (ts.isPropertyAssignment(root.parent) && ts.isObjectLiteralExpression(root.parent.parent)) root = root.parent.parent;
      if (!ts.isVariableDeclaration(root.parent) || !ts.isIdentifier(root.parent.name)) return failure("receiver-this", "此方法没有封闭的 const 对象绑定，不能把工厂实例或外部接收者合并为一个 this。", expression);
      const origin = this.object(root.parent.name, depth + 1, seen);
      if ("failure" in origin) return origin;
      const path = this.tree(origin.root).literals.get(owner);
      if (!path) return failure("receiver-this", "this 所属对象不在已确认的对象树中。", expression);
      return { ...origin, literal: owner, path, via: [...origin.via, expression] };
    }
    if (ts.isIdentifier(expression)) {
      const declarations = this.declarations(expression), declaration = declarations[0];
      if (declarations.length !== 1 || !declaration) return failure("receiver-origin", "接收者没有唯一的已捕获源码声明。", expression);
      if (ts.isBindingElement(declaration)) {
        const variable = bindingVariable(declaration), name = declaration.propertyName ?? declaration.name;
        if (!variable?.initializer || !constant(variable) || declaration.initializer || declaration.dotDotDotToken || !ts.isIdentifier(declaration.name)
          || !ts.isIdentifier(name) && !ts.isStringLiteral(name)) return failure("alias-pattern", "对象解构包含默认值、rest、嵌套模式或可变绑定，当前无法确认别名。", declaration);
        const base = this.object(variable.initializer, depth + 1, seen);
        if ("failure" in base) return base;
        const nested = this.nested(base, name.text, declaration);
        return "failure" in nested ? nested : { ...nested, bindings: [...nested.bindings, { node: declaration, path: nested.path }] };
      }
      if (ts.isParameter(declaration)) return failure("receiver-parameter", "接收者来自参数，接口签名不能确定实际对象。", declaration);
      if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) return failure("receiver-origin", "接收者没有支持的对象初始化来源。", declaration);
      if (!constant(declaration)) return failure("receiver-mutable", "接收者绑定可被重写，无法固定到唯一对象。", declaration);
      const key = this.context.key(declaration);
      if (seen.has(key)) return failure("receiver-cycle", "对象别名形成循环，无法确认来源。", declaration);
      const next = this.object(declaration.initializer, depth + 1, new Set([...seen, key]));
      return "failure" in next ? next : { ...next, bindings: [...next.bindings, { node: declaration, path: next.path }], via: [...next.via, declaration] };
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
      return this.nested(base, name, expression);
    }
    return failure("receiver-origin", "接收者来自条件、队列、调用结果或其他未支持的数据流。", expression);
  }

  private nested(base: Origin, name: string, node: ts.Node): ObjectResult {
    const members = this.members(base.literal);
    if (!(members instanceof Map)) return members;
    const member = members.get(name), value = member && this.memberValue(member);
    if (!value || !ts.isObjectLiteralExpression(value)) return failure("nested-shared", "嵌套属性不是自有内联对象；共享对象、参数和动态初始化尚未形成受控别名。", node);
    if (base.path.length >= 12) return failure("dispatch-budget", "嵌套对象路径达到追踪上限。", node);
    return { ...base, literal: value, path: [...base.path, name], via: [...base.via, member!, value] };
  }

  private thisOwner(node: ts.Node): ts.ObjectLiteralExpression | undefined {
    for (let current = node.parent; current; current = current.parent) {
      if (ts.isArrowFunction(current)) continue;
      if (ts.isMethodDeclaration(current) && ts.isObjectLiteralExpression(current.parent)) return current.parent;
      if (ts.isFunctionExpression(current) && ts.isPropertyAssignment(current.parent) && ts.isObjectLiteralExpression(current.parent.parent)) return current.parent.parent;
      if (ts.isFunctionLike(current) || ts.isClassLike(current)) return;
    }
    return;
  }

  private tree(root: ts.ObjectLiteralExpression): { literals: Map<ts.ObjectLiteralExpression, string[]>; references: { node: ts.Node; path: string[] }[]; failure?: DispatchFailure } {
    const cached = this.treeCache.get(root);
    if (cached) return cached;
    const result: ReturnType<ObjectDispatchResolver["tree"]> = { literals: new Map(), references: [] };
    const visitLiteral = (literal: ts.ObjectLiteralExpression, path: string[]): void => {
      if (path.length > 12 || result.literals.size >= 128) { result.failure ??= failure("dispatch-budget", "对象树达到追踪上限。", literal).failure; return; }
      result.literals.set(literal, path);
      const members = this.members(literal);
      if (!(members instanceof Map)) { result.failure ??= members.failure; return; }
      for (const [name, member] of members) {
        const value = this.memberValue(member);
        if (value && ts.isObjectLiteralExpression(value)) visitLiteral(value, [...path, name]);
      }
    };
    visitLiteral(root, []);
    const visitThis = (node: ts.Node): void => {
      if (node.kind === ts.SyntaxKind.ThisKeyword) {
        const owner = this.thisOwner(node), path = owner && result.literals.get(owner);
        if (path) result.references.push({ node, path });
      }
      ts.forEachChild(node, visitThis);
    };
    visitThis(root);
    // A shared ordinary function's dynamic this cannot be tied to this allocation.
    for (const literal of result.literals.keys()) {
      const members = this.members(literal);
      if (!(members instanceof Map)) continue;
      for (const member of members.values()) {
        const value = this.memberValue(member), implementation = value && this.functionValue(value);
        if (!implementation || ts.isArrowFunction(implementation) || ts.isMethodDeclaration(implementation)
          || ts.isFunctionExpression(implementation) && ts.isPropertyAssignment(implementation.parent) && implementation.parent.parent === literal) continue;
        const find = (node: ts.Node): void => { if (node.kind === ts.SyntaxKind.ThisKeyword) result.failure ??= failure("object-this", "共享普通函数使用动态 this，无法把它固定到单个对象。", node).failure; ts.forEachChild(node, find); };
        find(implementation);
      }
    }
    this.treeCache.set(root, result);
    return result;
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
    const key = JSON.stringify([this.context.key(origin.root), origin.path, selected, origin.bindings.map(binding => [this.context.key(binding.node), binding.path]).sort(), origin.returns.map(node => this.context.key(node)).sort()]);
    if (this.safetyCache.has(key)) return this.safetyCache.get(key) ?? undefined;
    const result = this.safeUncached(origin, selected);
    this.safetyCache.set(key, result ?? null);
    return result;
  }

  private safeUncached(origin: Origin, selected: string): DispatchFailure | undefined {
    const tree = this.tree(origin.root);
    if (tree.failure) return tree.failure;
    const pending = [...origin.bindings], visited = new Set<string>();
    const target = [...origin.path, selected];
    let escaped: DispatchFailure | undefined, references = 0;
    const typeOnly = (node: ts.Node): boolean => {
      for (; node.parent && !ts.isStatement(node); node = node.parent) if (ts.isTypeNode(node)) return true;
      return false;
    };
    const literalAt = (path: string[]): ts.ObjectLiteralExpression | undefined => {
      let literal = origin.root;
      for (const name of path) {
        const members = this.members(literal);
        if (!(members instanceof Map)) return;
        const member = members.get(name), value = member && this.memberValue(member);
        if (!value || !ts.isObjectLiteralExpression(value)) return;
        literal = value;
      }
      return literal;
    };
    const leak = (path: string[], node: ts.Node): void => {
      escaped ??= failure(path.length ? "nested-escaped" : "receiver-escaped", "对象或子对象被传参、存储、返回或暴露到未验证位置，不能排除成员被替换。", node).failure;
    };
    const consume = (reference: ts.Expression, initial: string[]): DispatchFailure | undefined => {
      if (++references > 1024) return failure("dispatch-budget", "对象引用数量达到追踪上限。", reference).failure;
      if (typeOnly(reference)) return;
      let expression = this.expanded(reference), path = initial;
      while ((ts.isPropertyAccessExpression(expression.parent) || ts.isElementAccessExpression(expression.parent)) && expression.parent.expression === expression) {
        const access = expression.parent, name = this.property(access);
        if (name === undefined) return failure(this.write(access) ? "computed-write" : "computed-alias", "动态属性访问可能暴露或改写对象树中的目标，保留缺口。", access).failure;
        const next = [...path, name];
        if (this.write(access)) {
          if (prefix(next, origin.path) || next.length === target.length && prefix(next, target)) return failure("member-written", "目标成员或其父路径存在直接、别名或解构写入，无法确定唯一实现。", access).failure;
          return;
        }
        const literal = literalAt(path), members = literal && this.members(literal);
        const member = members instanceof Map ? members.get(name) : undefined, value = member && this.memberValue(member);
        expression = this.expanded(access);
        if (value && ts.isObjectLiteralExpression(value)) { path = next; continue; }
        if (value) {
          const implementation = this.functionValue(value);
          if (implementation) {
            if (ts.isCallExpression(expression.parent) && expression.parent.expression === expression) return;
            if (tree.references.length) return failure("method-detached", "对象方法被提取或经过未支持的重绑定，无法保证方法体中的 this 始终指向原对象。", expression).failure;
            return;
          }
        }
        // An unknown callable receives this object even when a different member was selected.
        if (ts.isCallExpression(expression.parent) && expression.parent.expression === expression) leak(path, expression);
        return;
      }
      const parent = expression.parent;
      if (ts.isVariableDeclaration(parent) && parent.initializer === expression) {
        if (ts.isIdentifier(parent.name)) { pending.push({ node: parent, path }); return; }
        if (ts.isObjectBindingPattern(parent.name) && constant(parent)) {
          const literal = literalAt(path), members = literal && this.members(literal);
          for (const element of parent.name.elements) {
            const name = element.propertyName ?? element.name;
            if (element.initializer || element.dotDotDotToken || !ts.isIdentifier(element.name) || !ts.isIdentifier(name) && !ts.isStringLiteral(name)) return failure("alias-pattern", "解构别名包含默认值、rest 或嵌套模式，无法确认对象树的暴露范围。", element).failure;
            const member = members instanceof Map ? members.get(name.text) : undefined, value = member && this.memberValue(member);
            if (value && ts.isObjectLiteralExpression(value)) pending.push({ node: element, path: [...path, name.text] });
            else if (value && this.functionValue(value) && tree.references.length) return failure("method-detached", "解构提取了对象方法，无法保证 this 的接收者。", element).failure;
          }
          return;
        }
      }
      if (ts.isReturnStatement(parent) && origin.returns.includes(parent)) return;
      if (ts.isTypeOfExpression(parent) || ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) return;
      leak(path, expression);
      return;
    };
    for (const reference of tree.references) {
      const problem = consume(reference.node as ts.Expression, reference.path);
      if (problem) return problem;
    }
    for (let index = 0; index < pending.length; index++) {
      const binding = pending[index]!, declaration = binding.node;
      const key = JSON.stringify([this.context.key(declaration), binding.path]);
      if (visited.has(key)) continue;
      visited.add(key);
      if (visited.size > 128) return failure("dispatch-budget", "对象别名数量达到追踪上限。", declaration).failure;
      const variable = bindingVariable(declaration);
      if (!variable || !constant(variable) || exported(variable) || this.reassigned(declaration)) return failure("receiver-mutable", "对象或子对象的别名可重写或被导出，无法确认受控实例。", declaration).failure;
      for (const reference of this.context.uses.get(this.context.key(declaration)) ?? []) {
        if (reference === declaration.name || ts.isImportSpecifier(reference.parent)) continue;
        const problem = consume(reference, binding.path);
        if (problem) return problem;
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
