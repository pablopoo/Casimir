import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseSync } from 'vite';
import { readProjectPaths, type ProjectPaths } from '../project-paths.ts';
import type { VoidAuthConfig } from '../runtime/auth.ts';
import type { AstNode, AstProgram } from '../shared/ast.ts';

function isVoidAuthConfigSource(code: string, filename: string): boolean {
  if (!code.includes('void/auth')) {
    return false;
  }
  let program: AstProgram;
  try {
    program = parseSync(filename, code).program as unknown as AstProgram;
  } catch {
    return false;
  }
  return (program.body ?? []).some((node: AstNode) => {
    if (
      node.type !== 'ImportDeclaration' &&
      node.type !== 'ExportNamedDeclaration' &&
      node.type !== 'ExportAllDeclaration'
    ) {
      return false;
    }
    return (node.source as { value?: unknown } | undefined)?.value === 'void/auth';
  });
}

export function findVoidAuthConfig(
  root: string,
  paths: ProjectPaths = readProjectPaths(root),
): string | null {
  for (const absPath of paths.authConfigCandidates) {
    if (!existsSync(absPath)) {
      continue;
    }
    const code = readFileSync(absPath, 'utf-8');
    if (isVoidAuthConfigSource(code, absPath)) {
      return absPath;
    }
  }
  return null;
}

export async function loadVoidAuthConfig(
  configPath: string | null,
): Promise<VoidAuthConfig | undefined> {
  if (!configPath) {
    return undefined;
  }
  const mod = await import(pathToFileURL(configPath).href);
  return (mod.default ?? mod.auth ?? mod.config) as VoidAuthConfig | undefined;
}
