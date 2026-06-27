// 编辑表结构：按「原列快照 vs 当前编辑」差异生成 ALTER TABLE 语句。
// 方言差异收敛在本模块（前端设计器既有模式，见 NewTableDialog），并有 alter.test.ts 覆盖。
// 标识符均经 quoteIdent；列名来源于元数据或设计器内用户输入（非用户数据行）。

import { quoteIdent, qualifiedTable } from "@/lib/sql";
import type { TableRef, IndexInfo, ForeignKeyInfo, TableOptions } from "@/ipc/types";

/** SQL 字符串字面量（注释 / 选项值）：单引号转义。 */
function sqlStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** 设计器行模型。origName 为该列在库中的原名；新列为 null。 */
export interface ColEdit {
  name: string;
  type: string;
  length: string;
  notNull: boolean;
  def: string;
  origName: string | null;
}

/** 类型 + 可选长度，如 `VARCHAR(255)` / `INT`。 */
function colType(c: ColEdit): string {
  const len = c.length.trim();
  return len ? `${c.type}(${len})` : c.type;
}

/** 列完整定义（用于 ADD / MySQL MODIFY|CHANGE）：类型 [NOT NULL] [DEFAULT ..]。 */
function colDef(c: ColEdit): string {
  let s = colType(c);
  if (c.notNull) s += " NOT NULL";
  if (c.def.trim()) s += ` DEFAULT ${c.def.trim()}`;
  return s;
}

/** 某已有列是否在类型/非空/默认上发生了变化。 */
function isChanged(c: ColEdit, o: ColEdit): boolean {
  return colType(c) !== colType(o) || c.notNull !== o.notNull || c.def.trim() !== o.def.trim();
}

/**
 * 生成 ALTER 语句列表（每条带结尾分号，可 join("\n") 后整体执行）。
 * - 新增列：ADD COLUMN
 * - 删除列：DROP COLUMN（原有列在 edited 中消失）
 * - 改名：MySQL CHANGE（合并重定义）；PG/SQLite RENAME COLUMN
 * - 改类型/非空/默认：MySQL MODIFY；PG 拆成独立 ALTER COLUMN；SQLite 不生成（UI 已禁用）
 */
export function buildAlterStatements(
  kind: string,
  quoteChar: string,
  table: TableRef,
  original: ColEdit[],
  edited: ColEdit[],
): string[] {
  const q = quoteChar;
  const qt = qualifiedTable(q, table.database, table.schema, table.name);
  const stmts: string[] = [];
  const alter = (clause: string) => stmts.push(`ALTER TABLE ${qt} ${clause};`);

  const origByName = new Map(original.filter((c) => c.origName).map((c) => [c.origName, c]));
  const keptOrig = new Set(edited.filter((c) => c.origName).map((c) => c.origName));

  // 删除：原有列不在 edited 中
  for (const o of original) {
    if (o.origName && !keptOrig.has(o.origName)) {
      alter(`DROP COLUMN ${quoteIdent(o.origName, q)}`);
    }
  }

  for (const c of edited) {
    const name = c.name.trim();
    if (!name) continue;

    // 新增列
    if (!c.origName) {
      alter(`ADD COLUMN ${quoteIdent(name, q)} ${colDef(c)}`);
      continue;
    }

    const o = origByName.get(c.origName);
    if (!o) continue;
    const renamed = name !== c.origName;
    const changed = isChanged(c, o);

    if (kind === "mysql") {
      if (renamed) {
        alter(`CHANGE COLUMN ${quoteIdent(c.origName, q)} ${quoteIdent(name, q)} ${colDef(c)}`);
      } else if (changed) {
        alter(`MODIFY COLUMN ${quoteIdent(name, q)} ${colDef(c)}`);
      }
    } else if (kind === "sqlite") {
      // SQLite ALTER 仅支持改名（类型/约束变更需重建表，UI 已禁用）
      if (renamed) alter(`RENAME COLUMN ${quoteIdent(c.origName, q)} TO ${quoteIdent(name, q)}`);
    } else {
      // postgres：改名与各项变更拆成独立语句，改名后用新名
      if (renamed) alter(`RENAME COLUMN ${quoteIdent(c.origName, q)} TO ${quoteIdent(name, q)}`);
      const ident = quoteIdent(name, q);
      if (colType(c) !== colType(o)) alter(`ALTER COLUMN ${ident} TYPE ${colType(c)}`);
      if (c.notNull !== o.notNull) alter(`ALTER COLUMN ${ident} ${c.notNull ? "SET" : "DROP"} NOT NULL`);
      if (c.def.trim() !== o.def.trim()) {
        alter(c.def.trim() ? `ALTER COLUMN ${ident} SET DEFAULT ${c.def.trim()}` : `ALTER COLUMN ${ident} DROP DEFAULT`);
      }
    }
  }

  return stmts;
}

// ---- 索引 ----------------------------------------------------------------

/** 索引设计器行。origName 为库中原名；新建为 null。method 为索引方法（BTREE/HASH/gin…，空=默认）。 */
export interface IdxEdit {
  name: string;
  columns: string[];
  unique: boolean;
  method: string;
  origName: string | null;
}

function idxChanged(c: IdxEdit, o: IndexInfo): boolean {
  return (
    c.name !== o.name ||
    c.unique !== o.unique ||
    c.method !== ((o as { method?: string }).method ?? "") ||
    c.columns.join(",") !== o.columns.join(",")
  );
}

/** 索引差异 → CREATE / DROP INDEX 语句（改动 = 先删后建）。主键索引不在此管理。 */
export function buildIndexStatements(
  kind: string,
  q: string,
  table: TableRef,
  original: IndexInfo[],
  edited: IdxEdit[],
): string[] {
  const qt = qualifiedTable(q, table.database, table.schema, table.name);
  const stmts: string[] = [];
  const origByName = new Map(original.map((o) => [o.name, o]));
  const kept = new Set(edited.filter((e) => e.origName).map((e) => e.origName));

  const dropIdx = (name: string) => {
    // MySQL：DROP INDEX 需带表名（ALTER 形式）；PG/SQLite：DROP INDEX name。
    if (kind === "mysql") stmts.push(`ALTER TABLE ${qt} DROP INDEX ${quoteIdent(name, q)};`);
    else stmts.push(`DROP INDEX ${quoteIdent(name, q)};`);
  };
  const createIdx = (e: IdxEdit) => {
    const cols = e.columns.filter(Boolean).map((c) => quoteIdent(c, q)).join(", ");
    const uniq = e.unique ? "UNIQUE " : "";
    const m = e.method.trim();
    // MySQL：USING 在 ON 之前；PostgreSQL：USING 在表名之后、列之前。
    if (m && kind === "mysql") {
      stmts.push(`CREATE ${uniq}INDEX ${quoteIdent(e.name, q)} USING ${m} ON ${qt} (${cols});`);
    } else if (m) {
      stmts.push(`CREATE ${uniq}INDEX ${quoteIdent(e.name, q)} ON ${qt} USING ${m} (${cols});`);
    } else {
      stmts.push(`CREATE ${uniq}INDEX ${quoteIdent(e.name, q)} ON ${qt} (${cols});`);
    }
  };

  // 删除：原有索引不在 edited 中保留
  for (const o of original) {
    if (!kept.has(o.name)) dropIdx(o.name);
  }
  for (const e of edited) {
    if (!e.name.trim() || e.columns.filter(Boolean).length === 0) continue;
    if (!e.origName) {
      createIdx(e); // 新建
    } else {
      const o = origByName.get(e.origName);
      if (o && idxChanged(e, o)) {
        dropIdx(e.origName);
        createIdx(e);
      }
    }
  }
  return stmts;
}

// ---- 外键 ----------------------------------------------------------------

export interface FkEdit {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  origName: string | null;
}

function fkChanged(c: FkEdit, o: ForeignKeyInfo): boolean {
  return (
    c.name !== o.name ||
    c.columns.join(",") !== o.columns.join(",") ||
    c.refTable !== o.ref_table ||
    c.refColumns.join(",") !== o.ref_columns.join(",")
  );
}

/** 外键差异 → ADD / DROP CONSTRAINT（改动 = 先删后加）。SQLite 不支持（UI 已禁用）。 */
export function buildForeignKeyStatements(
  kind: string,
  q: string,
  table: TableRef,
  original: ForeignKeyInfo[],
  edited: FkEdit[],
): string[] {
  const qt = qualifiedTable(q, table.database, table.schema, table.name);
  const stmts: string[] = [];
  const origByName = new Map(original.map((o) => [o.name, o]));
  const kept = new Set(edited.filter((e) => e.origName).map((e) => e.origName));

  const dropFk = (name: string) => {
    // MySQL：DROP FOREIGN KEY；PG：DROP CONSTRAINT。
    const clause = kind === "mysql" ? "DROP FOREIGN KEY" : "DROP CONSTRAINT";
    stmts.push(`ALTER TABLE ${qt} ${clause} ${quoteIdent(name, q)};`);
  };
  const addFk = (e: FkEdit) => {
    const cols = e.columns.filter(Boolean).map((c) => quoteIdent(c, q)).join(", ");
    const refCols = e.refColumns.filter(Boolean).map((c) => quoteIdent(c, q)).join(", ");
    const ref = quoteIdent(e.refTable, q);
    stmts.push(
      `ALTER TABLE ${qt} ADD CONSTRAINT ${quoteIdent(e.name, q)} FOREIGN KEY (${cols}) REFERENCES ${ref} (${refCols});`,
    );
  };

  for (const o of original) {
    if (!kept.has(o.name)) dropFk(o.name);
  }
  for (const e of edited) {
    if (!e.name.trim() || !e.refTable.trim() || e.columns.filter(Boolean).length === 0) continue;
    if (!e.origName) {
      addFk(e);
    } else {
      const o = origByName.get(e.origName);
      if (o && fkChanged(e, o)) {
        dropFk(e.origName);
        addFk(e);
      }
    }
  }
  return stmts;
}

// ---- 表选项 + 注释 -------------------------------------------------------

/** 表选项 / 注释差异 → ALTER（MySQL 合并表选项；PG COMMENT ON TABLE）。SQLite 不支持。 */
export function buildOptionStatements(
  kind: string,
  q: string,
  table: TableRef,
  original: TableOptions,
  edited: TableOptions,
): string[] {
  const qt = qualifiedTable(q, table.database, table.schema, table.name);
  const stmts: string[] = [];
  const norm = (s: string | null) => (s ?? "").trim();

  if (kind === "mysql") {
    const parts: string[] = [];
    if (norm(edited.engine) && norm(edited.engine) !== norm(original.engine)) {
      parts.push(`ENGINE = ${edited.engine!.trim()}`);
    }
    if (norm(edited.charset) && norm(edited.charset) !== norm(original.charset)) {
      let cs = `DEFAULT CHARSET = ${edited.charset!.trim()}`;
      if (norm(edited.collation)) cs += ` COLLATE = ${edited.collation!.trim()}`;
      parts.push(cs);
    } else if (norm(edited.collation) && norm(edited.collation) !== norm(original.collation)) {
      parts.push(`DEFAULT COLLATE = ${edited.collation!.trim()}`);
    }
    if (norm(edited.comment) !== norm(original.comment)) {
      parts.push(`COMMENT = ${sqlStr(norm(edited.comment))}`);
    }
    if (parts.length) stmts.push(`ALTER TABLE ${qt} ${parts.join(", ")};`);
  } else if (kind === "postgres") {
    if (norm(edited.comment) !== norm(original.comment)) {
      const body = norm(edited.comment) ? sqlStr(norm(edited.comment)) : "NULL";
      stmts.push(`COMMENT ON TABLE ${qt} IS ${body};`);
    }
  }
  // sqlite：无表选项 / 注释
  return stmts;
}
