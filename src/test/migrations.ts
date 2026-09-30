// ═══════════════════════════════════════════════════
// Test helper: the schema as defined by ALL supabase/migrations, applied in
// the same order as the Supabase CLI (byte order of the file name).
// Used by schema-contract tests so they never read a single migration by name.
// ═══════════════════════════════════════════════════
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

export const MIGRATIONS_DIR = resolve(process.cwd(), 'supabase/migrations');

/** Migration file names in apply order. */
export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Every migration concatenated in apply order (comments stripped). */
export function allMigrationsSql(): string {
  return migrationFiles()
    .map((f) => readFileSync(resolve(MIGRATIONS_DIR, f), 'utf8').replace(/--[^\n]*/g, ''))
    .join('\n');
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

/**
 * Columns of `public.<table>` after all migrations: the union of every
 * CREATE TABLE body and every ALTER TABLE … ADD COLUMN, minus DROP COLUMNs.
 */
export function tableColumns(table: string, sql: string = allMigrationsSql()): string[] {
  const cols = new Set<string>();
  const createRe = new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table} \\(([\\s\\S]*?)\\n\\);`, 'gi');
  for (const m of sql.matchAll(createRe)) {
    for (const line of m[1].split('\n')) {
      const c = line.trim().split(/\s+/)[0]?.toLowerCase();
      if (c && IDENT.test(c) && !['constraint', 'primary', 'unique', 'foreign', 'check'].includes(c)) cols.add(c);
    }
  }
  const alterRe = new RegExp(`ALTER TABLE (?:ONLY )?public\\.${table}\\b([^;]*);`, 'gi');
  for (const m of sql.matchAll(alterRe)) {
    for (const a of m[1].matchAll(/ADD COLUMN (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)/gi)) cols.add(a[1].toLowerCase());
    for (const d of m[1].matchAll(/DROP COLUMN (?:IF EXISTS )?([a-z_][a-z0-9_]*)/gi)) cols.delete(d[1].toLowerCase());
  }
  return [...cols];
}
