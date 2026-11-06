import ts from "typescript";

/** Deliberately bounded value tracing. A signature is never an implementation. */
export function destructuredFactoryValue(
  symbol: ts.Symbol | undefined, checker: ts.TypeChecker,
  written: ReadonlySet<string>, key: (node: ts.Node) => string,
): { expression: ts.Expression | ts.MethodDeclaration; via: ts.Node[] } | undefined {
  const declarations = symbol?.declarations;
  if (declarations?.length !== 1) return;
  const binding = declarations[0]!;
  if (!ts.isBindingElement(binding) || binding.initializer || binding.dotDotDotToken
    || !ts.isIdentifier(binding.name) || written.has(key(binding))) return;
  const pattern = binding.parent;
  if (!ts.isObjectBindingPattern(pattern) || !ts.isVariableDeclaration(pattern.parent)) return;
  const variable = pattern.parent;
  if (!ts.isVariableDeclarationList(variable.parent) || !(variable.parent.flags & ts.NodeFlags.Const)
    || !variable.initializer || !ts.isCallExpression(variable.initializer)) return;
  const name = binding.propertyName ?? binding.name;
  if (!ts.isIdentifier(name) && !ts.isStringLiteral(name)) return;
  const call = variable.initializer;
  let factory = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression);
  if (factory?.flags && factory.flags & ts.SymbolFlags.Alias) factory = checker.getAliasedSymbol(factory);
  const implementations = factory?.declarations?.flatMap<ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction>(declaration => {
    if (ts.isFunctionDeclaration(declaration) && declaration.body) return [declaration];
    if (ts.isVariableDeclaration(declaration) && declaration.initializer
      && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
      && ts.isVariableDeclarationList(declaration.parent) && declaration.parent.flags & ts.NodeFlags.Const) return [declaration.initializer];
    return [];
  });
  if (implementations?.length !== 1 || factory?.declarations?.some(declaration => written.has(key(declaration)))) return;
  const implementation = implementations[0]!;
  if (implementation.asteriskToken || implementation.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    || !implementation.body || !ts.isBlock(implementation.body)) return;
  const returns: ts.ReturnStatement[] = [];
  function visit(node: ts.Node): void {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) returns.push(node);
    ts.forEachChild(node, visit);
  }
  visit(implementation.body);
  const returned = returns[0];
  if (returns.length !== 1 || !returned || returned.parent !== implementation.body || !returned.expression
    || !ts.isObjectLiteralExpression(returned.expression)) return;
  const names = new Set<string>();
  let selected: ts.ObjectLiteralElementLike | undefined;
  for (const property of returned.expression.properties) {
    if ((!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property) && !ts.isMethodDeclaration(property))
      || !property.name || (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))
      || names.has(property.name.text)) return;
    names.add(property.name.text);
    if (property.name.text === name.text) selected = property;
  }
  if (!selected) return;
  const expression = ts.isPropertyAssignment(selected) ? selected.initializer
    : ts.isShorthandPropertyAssignment(selected) ? selected.name
    : ts.isMethodDeclaration(selected) ? selected : undefined;
  if (!expression) return;
  if (!ts.isIdentifier(expression) && !ts.isArrowFunction(expression) && !ts.isFunctionExpression(expression) && !ts.isMethodDeclaration(expression)) return;
  let value = ts.isShorthandPropertyAssignment(selected) ? checker.getShorthandAssignmentValueSymbol(selected)
    : ts.isIdentifier(expression) ? checker.getSymbolAtLocation(expression) : undefined;
  if (value && value.flags & ts.SymbolFlags.Alias) value = checker.getAliasedSymbol(value);
  if (value?.declarations?.some(declaration => written.has(key(declaration)))) return;
  return { expression, via: [binding, call.expression, returned, selected] };
}
