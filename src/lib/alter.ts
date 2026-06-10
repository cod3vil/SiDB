// 编辑表结构：按「原列快照 vs 当前编辑」差异生成 ALTER TABLE 语句。
// 方言差异收敛在本模块（前端设计器既有模式，见 NewTableDialog），并有 alter.test.ts 覆盖。
// 标识符均经 quoteIdent；列名来源于元数据或设计器内用户输入（非用户数据行）。

import { quoteIdent, qualifiedTable } from "@/lib/sql";
import type { TableRef } from "@/ipc/types";

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
