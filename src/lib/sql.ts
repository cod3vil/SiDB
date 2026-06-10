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

/** 设计器类型下拉候选（建表 / 改表共用）。 */
export const TYPES: Record<string, string[]> = {
  mysql: ["INT", "BIGINT", "TINYINT", "SMALLINT", "DECIMAL", "FLOAT", "DOUBLE", "VARCHAR", "CHAR", "TEXT", "LONGTEXT", "DATE", "DATETIME", "TIMESTAMP", "TIME", "BOOLEAN", "JSON", "BLOB"],
  postgres: ["integer", "bigint", "smallint", "serial", "bigserial", "numeric", "real", "double precision", "varchar", "char", "text", "date", "timestamp", "timestamptz", "time", "boolean", "jsonb", "uuid", "bytea"],
  sqlite: ["INTEGER", "TEXT", "REAL", "NUMERIC", "BLOB"],
};

/** 把元数据里的 db_type 拆成「基础类型」和「长度/精度」。
 *  例：`varchar(255)` → { type: "varchar", length: "255" }；
 *      `decimal(10,2)` → { type: "decimal", length: "10,2" }；
 *      `int unsigned` → { type: "int unsigned", length: "" }（无括号则整串作类型）。 */
export function parseDbType(dbType: string): { type: string; length: string } {
  const open = dbType.indexOf("(");
  if (open === -1 || !dbType.trimEnd().endsWith(")")) return { type: dbType.trim(), length: "" };
  return {
    type: dbType.slice(0, open).trim(),
    length: dbType.slice(open + 1, dbType.lastIndexOf(")")).trim(),
  };
}
