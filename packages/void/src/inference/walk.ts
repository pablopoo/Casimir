import { walk } from 'estree-walker';
import { parseSync } from 'vite';
import { isIdentifier, isMemberExpression, type AstNode } from '../shared/ast.ts';
import { staticModuleReferences } from '../shared/module-references.ts';
import { staticLiteral } from '../shared/static-exports.ts';

export type InferredBindings = {
  needsD1: boolean;
  needsKV: boolean;
  needsR2: boolean;
  needsAuth: boolean;
  needsQueues: boolean;
  needsAI: boolean;
  needsSandbox: boolean;
  needsLive?: boolean;
  needsEmail?: boolean;
};

// SEND_EMAIL is intentionally absent from this regex: Void owns that binding
// (managed sends go through __VOID_PROXY/email/send; native Cloudflare deploys
// add SEND_EMAIL themselves), so the `void/email` import (below) is the
// sole driver of `needsEmail`.
const ENV_BINDING_RE = /\benv\s*\.\s*(DB|KV|STORAGE|QUEUE_\w+|AI|SANDBOX)\b/;

/**
 * Infer which Cloudflare bindings a source file uses.
 *
 * Read Vite's module metadata, then walk the AST only for potential env bindings.
 */
export function inferBindingsFromSource(code: string, filename: string): InferredBindings {
  const result: InferredBindings = {
    needsD1: false,
    needsKV: false,
    needsR2: false,
    needsAuth: false,
    needsQueues: false,
    needsAI: false,
    needsSandbox: false,
    needsLive: false,
    needsEmail: false,
  };

  let parsed: ReturnType<typeof parseSync>;
  try {
    parsed = parseSync(filename, code);
    if (parsed.errors.length > 0) {
      return result;
    }
  } catch {
    return result;
  }

  function recordModuleReference(source: string, statement: string): void {
    switch (source) {
      case 'void/db':
        result.needsD1 = true;
        break;
      case 'void/kv':
        result.needsKV = true;
        break;
      case 'void/storage':
        result.needsR2 = true;
        break;
      case 'void/auth':
        result.needsAuth = true;
        break;
      case 'void/queues':
        result.needsQueues = true;
        break;
      case 'void/ai':
        result.needsAI = true;
        break;
      case 'void/sandbox':
        result.needsSandbox = true;
        break;
      case 'void/email':
        result.needsEmail = true;
        break;
      case 'void/live':
        result.needsLive = true;
        break;
      case 'void/client':
      case 'void/client/react':
      case 'void/client/vue':
      case 'void/client/svelte':
      case 'void/client/solid': {
        // Check if the `auth` specifier is imported (not just `fetch`)
        if (/\bauth\b/.test(statement)) {
          result.needsAuth = true;
        }
        break;
      }
    }
  }

  for (const reference of staticModuleReferences(parsed, code)) {
    recordModuleReference(reference.source, code.slice(reference.start, reference.end));
  }

  for (const reference of parsed.module.dynamicImports) {
    // Parse just the argument so literal decoding does not materialize the whole file's AST.
    const argument = code.slice(reference.moduleRequest.start, reference.moduleRequest.end);
    const expression = parseSync(filename, `(${argument})`).program.body[0];
    const source =
      expression?.type === 'ExpressionStatement'
        ? staticLiteral(expression.expression as AstNode)
        : undefined;
    if (typeof source === 'string') {
      recordModuleReference(source, code.slice(reference.start, reference.end));
    }
  }

  if (!ENV_BINDING_RE.test(code)) {
    return result;
  }

  walk(parsed.program as unknown as Parameters<typeof walk>[0], {
    enter(node) {
      const current = node as AstNode;
      if (!isMemberExpression(current)) {
        return;
      }
      if (current.computed) {
        return;
      }

      const property = current.property;
      if (!isIdentifier(property)) {
        return;
      }

      // Check if the object is *.env (i.e., a MemberExpression with .env)
      const obj = current.object;
      const isViaContextEnv =
        isMemberExpression(obj) && isIdentifier(obj.property) && obj.property.name === 'env';
      const isDirectEnv = isIdentifier(obj) && obj.name === 'env';
      if (!isViaContextEnv && !isDirectEnv) {
        return;
      }

      switch (property.name) {
        case 'DB':
          result.needsD1 = true;
          break;
        case 'KV':
          result.needsKV = true;
          break;
        case 'STORAGE':
          result.needsR2 = true;
          break;
        case 'AI':
          result.needsAI = true;
          break;
        case 'SANDBOX':
          result.needsSandbox = true;
          break;
        default:
          if (property.name.startsWith('QUEUE_')) {
            result.needsQueues = true;
          }
          break;
      }
    },
  });

  return result;
}

/**
 * Merge multiple InferredBindings into a single result (union).
 */
export function mergeBindings(bindings: Array<InferredBindings>): InferredBindings {
  return {
    needsD1: bindings.some((b) => b.needsD1),
    needsKV: bindings.some((b) => b.needsKV),
    needsR2: bindings.some((b) => b.needsR2),
    needsAuth: bindings.some((b) => b.needsAuth),
    needsQueues: bindings.some((b) => b.needsQueues),
    needsAI: bindings.some((b) => b.needsAI),
    needsSandbox: bindings.some((b) => b.needsSandbox),
    needsLive: bindings.some((b) => b.needsLive),
    needsEmail: bindings.some((b) => b.needsEmail),
  };
}
