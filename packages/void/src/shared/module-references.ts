import type { parseSync } from 'vite';

type ModuleReference = { source: string; start: number; end: number };

/** Runtime imports and re-exports, in source order, including empty export lists. */
export function staticModuleReferences(
  parsed: ReturnType<typeof parseSync>,
  code: string,
): Array<ModuleReference> {
  const { staticImports, staticExports } = parsed.module;
  // Module metadata omits empty re-exports and the type-only flag on empty imports.
  // These candidates need the AST; false positives in comments/strings only cost a parse read.
  const needsAst =
    /\bexport\s*(?:\/|\{\s*(?:\}|\/))/.test(code) ||
    staticImports.some(
      (item) =>
        item.entries.length === 0 &&
        code.slice(item.start, item.moduleRequest.start).trim() !== 'import',
    );
  if (!needsAst) {
    return [
      ...staticImports
        .filter((item) => item.entries.length === 0 || item.entries.some((entry) => !entry.isType))
        .map((item) => ({ source: item.moduleRequest.value, start: item.start, end: item.end })),
      ...staticExports.flatMap((item) => {
        const entry = item.entries.find((entry) => !entry.isType && entry.moduleRequest);
        return entry?.moduleRequest
          ? [{ source: entry.moduleRequest.value, start: item.start, end: item.end }]
          : [];
      }),
    ].sort((a, b) => a.start - b.start);
  }
  return parsed.program.body.flatMap((statement) => {
    if (
      statement.type !== 'ImportDeclaration' &&
      statement.type !== 'ExportNamedDeclaration' &&
      statement.type !== 'ExportAllDeclaration'
    ) {
      return [];
    }
    if (
      !statement.source ||
      ('importKind' in statement && statement.importKind === 'type') ||
      ('exportKind' in statement && statement.exportKind === 'type') ||
      ('specifiers' in statement &&
        statement.specifiers.length > 0 &&
        statement.specifiers.every(
          (specifier) =>
            ('importKind' in specifier && specifier.importKind === 'type') ||
            ('exportKind' in specifier && specifier.exportKind === 'type'),
        ))
    ) {
      return [];
    }
    return [{ source: statement.source.value, start: statement.start, end: statement.end }];
  });
}
