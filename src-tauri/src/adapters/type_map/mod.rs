//! 类型映射专项（TDD §4.3，高风险区，独立可测）。
//!
//! 把各库的原始类型名映射到 [`Value`] 变体名（`value_kind`），供 `ColumnMeta` 与前端渲染使用。
//! 仅做**类型名 → 变体名**的纯函数映射；具体取值（行解码）在各 adapter 内完成。

/// 将类型名规整为小写、去掉长度/精度括号，便于匹配。
fn base(type_name: &str) -> String {
    let lower = type_name.trim().to_ascii_lowercase();
    match lower.split('(').next() {
        Some(s) => s.trim().to_string(),
        None => lower,
    }
}

/// MySQL 类型 → value_kind。
///
/// 特例：`TINYINT(1)` → Bool（一期默认开启）；`DECIMAL` → Decimal；`BLOB/BINARY` → Bytes。
pub fn mysql_kind(type_name: &str) -> &'static str {
    let lower = type_name.trim().to_ascii_lowercase();
    if lower.starts_with("tinyint(1)") {
        return "Bool";
    }
    match base(type_name).as_str() {
        "bool" | "boolean" => "Bool",
        "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint" | "year" => "Int",
        "decimal" | "dec" | "numeric" | "fixed" => "Decimal",
        "float" | "double" | "real" => "Float",
        "date" => "Date",
        "time" => "Time",
        "datetime" | "timestamp" => "DateTime",
        "json" => "Json",
        "binary" | "varbinary" | "tinyblob" | "blob" | "mediumblob" | "longblob" | "bit" => "Bytes",
        "char" | "varchar" | "tinytext" | "text" | "mediumtext" | "longtext" | "enum" | "set" => {
            "Text"
        }
        _ => "Text",
    }
}

/// PostgreSQL 类型 → value_kind。
///
/// 特例：`jsonb/json` → Json；`numeric` → Decimal；数组（`_` 前缀或 `[]` 后缀）→ Array；
/// `bytea` → Bytes；`uuid`/枚举 → Text。
pub fn postgres_kind(type_name: &str) -> &'static str {
    let lower = type_name.trim().to_ascii_lowercase();
    // 数组：pg_type 内部名以 `_` 前缀（如 `_int4`），或显示名带 `[]`。
    if lower.ends_with("[]") || lower.starts_with('_') {
        return "Array";
    }
    match base(&lower).as_str() {
        "bool" | "boolean" => "Bool",
        "int2" | "smallint" | "int4" | "int" | "integer" | "int8" | "bigint" | "serial"
        | "bigserial" | "oid" => "Int",
        "numeric" | "decimal" | "money" => "Decimal",
        "float4" | "real" | "float8" | "double precision" => "Float",
        "json" | "jsonb" => "Json",
        "bytea" => "Bytes",
        "date" => "Date",
        "time" | "timetz" => "Time",
        "timestamp" | "timestamptz" => "DateTime",
        "uuid" | "text" | "varchar" | "char" | "bpchar" | "name" | "citext" | "inet" | "cidr"
        | "macaddr" => "Text",
        _ => "Text",
    }
}

/// SQLite 类型 → value_kind（动态类型，按声明类型的亲和性规则映射）。
///
/// 遵循 SQLite type affinity：含 INT→Int；含 CHAR/CLOB/TEXT→Text；含 BLOB 或空→Bytes/Text；
/// 含 REAL/FLOA/DOUB→Float；含 NUMERIC/DECIMAL→Decimal。
pub fn sqlite_kind(type_name: &str) -> &'static str {
    let t = type_name.trim().to_ascii_uppercase();
    if t.is_empty() {
        return "Text";
    }
    if t.contains("INT") {
        return "Int";
    }
    if t.contains("CHAR") || t.contains("CLOB") || t.contains("TEXT") {
        return "Text";
    }
    if t.contains("BLOB") {
        return "Bytes";
    }
    if t.contains("REAL") || t.contains("FLOA") || t.contains("DOUB") {
        return "Float";
    }
    if t.contains("DEC") || t.contains("NUMERIC") {
        return "Decimal";
    }
    if t.contains("BOOL") {
        return "Bool";
    }
    if t == "DATE" {
        return "Date";
    }
    if t.contains("DATETIME") || t.contains("TIMESTAMP") {
        return "DateTime";
    }
    "Text"
}

/// 零日期判定（MySQL `0000-00-00` / `0000-00-00 00:00:00`）：保留原样字符串 + 标注。
pub fn is_mysql_zero_date(s: &str) -> bool {
    let t = s.trim();
    t.starts_with("0000-00-00")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mysql_tinyint1_is_bool() {
        assert_eq!(mysql_kind("tinyint(1)"), "Bool");
        assert_eq!(mysql_kind("TINYINT(1)"), "Bool");
        // 其它宽度仍是 Int
        assert_eq!(mysql_kind("tinyint(4)"), "Int");
        assert_eq!(mysql_kind("int(11)"), "Int");
    }

    #[test]
    fn mysql_decimal_and_blob() {
        assert_eq!(mysql_kind("decimal(10,2)"), "Decimal");
        assert_eq!(mysql_kind("DECIMAL"), "Decimal");
        assert_eq!(mysql_kind("blob"), "Bytes");
        assert_eq!(mysql_kind("varbinary(16)"), "Bytes");
        assert_eq!(mysql_kind("datetime"), "DateTime");
        assert_eq!(mysql_kind("json"), "Json");
    }

    #[test]
    fn pg_json_numeric_array_bytea() {
        assert_eq!(postgres_kind("jsonb"), "Json");
        assert_eq!(postgres_kind("json"), "Json");
        assert_eq!(postgres_kind("numeric"), "Decimal");
        assert_eq!(postgres_kind("numeric(12,4)"), "Decimal");
        assert_eq!(postgres_kind("text[]"), "Array");
        assert_eq!(postgres_kind("_int4"), "Array");
        assert_eq!(postgres_kind("bytea"), "Bytes");
        assert_eq!(postgres_kind("uuid"), "Text");
        assert_eq!(postgres_kind("timestamptz"), "DateTime");
    }

    #[test]
    fn sqlite_affinity() {
        assert_eq!(sqlite_kind("INTEGER"), "Int");
        assert_eq!(sqlite_kind("INT"), "Int");
        assert_eq!(sqlite_kind("VARCHAR(255)"), "Text");
        assert_eq!(sqlite_kind("TEXT"), "Text");
        assert_eq!(sqlite_kind("BLOB"), "Bytes");
        assert_eq!(sqlite_kind("REAL"), "Float");
        assert_eq!(sqlite_kind("DOUBLE"), "Float");
        assert_eq!(sqlite_kind("NUMERIC"), "Decimal");
        assert_eq!(sqlite_kind("DECIMAL(10,5)"), "Decimal");
        assert_eq!(sqlite_kind(""), "Text");
    }

    #[test]
    fn zero_date_detection() {
        assert!(is_mysql_zero_date("0000-00-00"));
        assert!(is_mysql_zero_date("0000-00-00 00:00:00"));
        assert!(!is_mysql_zero_date("2024-01-01"));
    }
}
