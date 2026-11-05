import { parseSync } from 'vite';
import {
  isIdentifier,
  type AstExportNamedDeclaration,
  type AstNode,
  type AstProgram,
  type AstVariableDeclaration,
} from './ast.ts';

/** Read the initializer of directly exported constants without evaluating user code. */
export function staticExportInitializers(
  filename: string,
  source: string,
  names: ReadonlySet<string>,
): Map<string, AstNode> {
  const result = new Map<string, AstNode>();
  const program = parseSync(filename, source).program as unknown as AstProgram;
  for (const statement of program.body ?? []) {
    if (statement.type !== 'ExportNamedDeclaration') {
      continue;
    }
    const declaration = (statement as AstExportNamedDeclaration).declaration;
    if (
      declaration?.type !== 'VariableDeclaration' ||
      (declaration as AstVariableDeclaration).kind !== 'const'
    ) {
      continue;
    }
    for (const variable of (declaration as AstVariableDeclaration).declarations ?? []) {
      if (isIdentifier(variable.id) && names.has(variable.id.name) && variable.init) {
        result.set(variable.id.name, variable.init);
      }
    }
  }
  return result;
}

export function unwrapStaticExpression(node: AstNode | undefined): AstNode | undefined {
  while (
    node &&
    [
      'ParenthesizedExpression',
      'TSAsExpression',
      'TSSatisfiesExpression',
      'TSTypeAssertion',
    ].includes(node.type)
  ) {
    node = node.expression as AstNode | undefined;
  }
  return node;
}

export function staticLiteral(node: AstNode | undefined): unknown {
  node = unwrapStaticExpression(node);
  if (node?.type === 'Literal') {
    return node.value;
  }
  if (node?.type === 'TemplateLiteral') {
    const expressions = node.expressions as Array<AstNode> | undefined;
    const quasis = node.quasis as Array<{ value?: { cooked?: string } }> | undefined;
    if (expressions?.length === 0 && quasis?.length === 1) {
      return quasis[0]?.value?.cooked;
    }
  }
  return undefined;
}
