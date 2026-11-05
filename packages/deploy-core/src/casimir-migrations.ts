import { canonicalJson } from './canonical-json.ts';
import { tokenizeSql } from './sql-tokenize.ts';

export type MigrationFile = { name: string; sql: string; sha256: string };
export type AppliedMigration = { name: string; sha256: string };
export type SchemaDescription = {
  objects: Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
  tables: Record<string, Array<string>>;
};
export type MigrationPlan = {
  files: Array<MigrationFile>;
  pending: Array<MigrationFile>;
  priorSchemaDigest: string;
  priorHistoryDigest: string;
  fingerprint: string;
};
export async function casimirDigest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}
type Token = { kind: 'word' | 'identifier' | 'literal' | 'symbol' | 'number'; value: string };
function lex(sql: string): Array<Token> {
  const result: Array<Token> = [];
  for (const segment of tokenizeSql(sql)) {
    const text = sql.slice(segment.start, segment.end);
    if (segment.kind === 'line-comment') {
      continue;
    }
    if (segment.kind === 'block-comment') {
      if (text.length < 4 || text.indexOf('*/', 2) !== text.length - 2) {
        throw new Error('migration_unterminated');
      }
      continue;
    }
    if (segment.kind === 'string' || segment.kind === 'ident-quote') {
      const close = text[0] === '[' ? ']' : text[0];
      let end = -1;
      for (let i = 1; i < text.length; i++) {
        if (text[i] !== close) {
          continue;
        }
        if (close !== ']' && text[i + 1] === close) {
          i++;
          continue;
        }
        end = i;
        break;
      }
      if (end !== text.length - 1 || end < 1) {
        throw new Error('migration_unterminated');
      }
      result.push({ kind: segment.kind === 'string' ? 'literal' : 'identifier', value: text });
      continue;
    }
    let position = 0;
    while (position < text.length) {
      const rest = text.slice(position);
      const match =
        /^(\s+|[A-Za-z_][A-Za-z0-9_]*|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[(),;+-])/.exec(
          rest,
        );
      if (!match) {
        throw new Error('migration_token');
      }
      const value = match[0];
      position += value.length;
      if (/^\s/.test(value)) {
        continue;
      }
      result.push({
        kind: /^[A-Za-z_]/.test(value) ? 'word' : /^[\d.]/.test(value) ? 'number' : 'symbol',
        value,
      });
    }
  }
  return result;
}
function identifier(token: Token | undefined): string {
  if (!token || !['word', 'identifier'].includes(token.kind)) {
    throw new Error('migration_identifier');
  }
  let value = token.value;
  if (token.kind === 'identifier') {
    value = value.slice(1, -1).replaceAll(value[0] + value[0], value[0]);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value) || /^(sqlite_|__|casimir_)/i.test(value)) {
    throw new Error('migration_identifier');
  }
  return value.toLowerCase();
}
function parse(sql: string, tables: Map<string, Set<string>>, objects: Set<string>): void {
  const tokens = lex(sql);
  let i = 0;
  const take = (value: string): boolean => {
    const token = tokens[i];
    if (
      !token ||
      (token.kind !== 'word' && token.kind !== 'symbol') ||
      token.value.toUpperCase() !== value
    ) {
      return false;
    }
    i++;
    return true;
  };
  const need = (value: string): void => {
    if (!take(value)) {
      throw new Error('migration_grammar');
    }
  };
  const name = (): string => identifier(tokens[i++]);
  while (i < tokens.length) {
    need('CREATE');
    if (take('TABLE')) {
      const table = name();
      if (objects.has(table) || tables.has(table)) {
        throw new Error('migration_exists');
      }
      need('(');
      const columns = new Set<string>();
      let primary = false;
      do {
        const column = name();
        if (columns.has(column)) {
          throw new Error('migration_column');
        }
        columns.add(column);
        const type = tokens[i++];
        if (
          !type ||
          type.kind !== 'word' ||
          !['INTEGER', 'TEXT', 'REAL', 'BLOB'].includes(type.value.toUpperCase())
        ) {
          throw new Error('migration_type');
        }
        let notNull = false,
          defaultValue = false;
        while (i < tokens.length && tokens[i].value !== ',' && tokens[i].value !== ')') {
          if (take('PRIMARY')) {
            if (primary) {
              throw new Error('migration_primary');
            }
            need('KEY');
            primary = true;
            if (take('AUTOINCREMENT') && type.value.toUpperCase() !== 'INTEGER') {
              throw new Error('migration_primary');
            }
          } else if (take('NOT')) {
            if (notNull) {
              throw new Error('migration_constraint');
            }
            need('NULL');
            notNull = true;
          } else if (take('DEFAULT')) {
            if (defaultValue) {
              throw new Error('migration_default');
            }
            defaultValue = true;
            const parenthesized = take('(');
            if (take('DATETIME')) {
              need('(');
              if (tokens[i++]?.value !== "'now'") {
                throw new Error('migration_default');
              }
              need(')');
            } else {
              const signed = take('+') || take('-');
              const token = tokens[i++];
              if (
                !token ||
                (signed
                  ? token.kind !== 'number'
                  : !['literal', 'number'].includes(token.kind) &&
                    !(
                      token.kind === 'word' &&
                      ['NULL', 'TRUE', 'FALSE'].includes(token.value.toUpperCase())
                    ))
              ) {
                throw new Error('migration_default');
              }
            }
            if (parenthesized) {
              need(')');
            }
          } else {
            throw new Error('migration_constraint');
          }
        }
      } while (take(','));
      need(')');
      objects.add(table);
      tables.set(table, columns);
    } else if (take('INDEX')) {
      const index = name();
      if (objects.has(index)) {
        throw new Error('migration_exists');
      }
      need('ON');
      const columns = tables.get(name());
      if (!columns) {
        throw new Error('migration_table');
      }
      need('(');
      do {
        if (!columns.has(name())) {
          throw new Error('migration_column');
        }
      } while (take(','));
      need(')');
      objects.add(index);
    } else {
      throw new Error('migration_grammar');
    }
    if (i < tokens.length) {
      need(';');
    }
  }
}
/** Strict, additive-only policy. Hashes use portable Web Crypto; no runtime imports. */
export async function validateCasimirMigrationBatch(
  files: Array<MigrationFile>,
  history: Array<AppliedMigration>,
  schema: SchemaDescription,
): Promise<MigrationPlan> {
  if (files.length > 4096 || history.length > files.length) {
    throw new Error('migration_history');
  }
  let previous = '';
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.sql$/.test(file.name) ||
      file.name <= previous ||
      file.sql.length > 4 * 1024 * 1024
    ) {
      throw new Error('migration_order');
    }
    previous = file.name;
    if ((await casimirDigest(file.sql)) !== file.sha256) {
      throw new Error('migration_hash');
    }
    if (
      i < history.length &&
      (history[i].name !== file.name || history[i].sha256 !== file.sha256)
    ) {
      throw new Error('migration_history');
    }
  }
  const pending = files.slice(history.length);
  const tables = new Map(
    Object.entries(schema.tables).map(([table, columns]) => [
      table.toLowerCase(),
      new Set(columns.map((c) => c.toLowerCase())),
    ]),
  );
  const objects = new Set(schema.objects.map((object) => object.name.toLowerCase()));
  for (const file of pending) {
    parse(file.sql, tables, objects);
  }
  const result = {
    files: files.map((f) => ({ ...f })),
    pending: pending.map((f) => ({ ...f })),
    priorSchemaDigest: await casimirDigest(canonicalJson(schema)),
    priorHistoryDigest: await casimirDigest(canonicalJson(history)),
  };
  return { ...result, fingerprint: await casimirDigest(canonicalJson(result)) };
}
