// 前端 DDL 生成用的标识符引号化（与后端 quote_table 规则一致）。
// 仅用于「新建库/表」设计器中由用户新定义的标识符（非元数据回填、非用户数据）。

export function quoteIdent(name: string, quoteChar: string): string {
  const q = quoteChar || '"';
  return q + name.split(q).join(q + q) + q;
}

/** 限定表名：PG 用 schema.table，MySQL 用 db.table，SQLite 裸名。 */
export function qualifiedTable(
  quoteChar: string,
  database: string | null,
  schema: string | null,
  name: string,
): string {
  if (schema) return `${quoteIdent(schema, quoteChar)}.${quoteIdent(name, quoteChar)}`;
  if (database) return `${quoteIdent(database, quoteChar)}.${quoteIdent(name, quoteChar)}`;
  return quoteIdent(name, quoteChar);
}
