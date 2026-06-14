//! 导出服务（TDD §6.4）。流式编码 CSV / JSON。
//!
//! 此处提供**纯编码函数**（可测）；流式写文件 + 进度事件由 commands 层串联分页拉取。

use crate::models::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportFormat {
    Csv,
    Json,
}

/// CSV 字段转义（RFC 4180）。NULL 输出为空（可选 NULL 字面量由调用方决定）。
pub fn csv_field(v: &Value, null_literal: Option<&str>) -> String {
    let raw = match v {
        Value::Null => return null_literal.unwrap_or("").to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Int(n) => n.to_string(),
        Value::UInt(n) => n.to_string(),
        Value::Float(f) => f.to_string(),
        Value::Decimal(s) | Value::Text(s) | Value::Unknown(s) => s.clone(),
        Value::Date(s) | Value::Time(s) | Value::DateTime(s) => s.clone(),
        Value::Json(j) => j.to_string(),
        Value::Bytes { len, .. } => format!("(BLOB {len} bytes)"),
        Value::Array(_) => serde_json::to_string(v).unwrap_or_default(),
    };
    escape_csv(&raw)
}

fn escape_csv(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// 编码一行 CSV（含换行）。
pub fn csv_row<'a>(
    values: impl IntoIterator<Item = &'a Value>,
    null_literal: Option<&str>,
) -> String {
    let cells: Vec<String> = values
        .into_iter()
        .map(|v| csv_field(v, null_literal))
        .collect();
    let mut line = cells.join(",");
    line.push_str("\r\n");
    line
}

/// 把一行编码为 JSON 对象（列名 → 值）。
pub fn json_row(columns: &[String], values: &[Value]) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    for (c, v) in columns.iter().zip(values) {
        map.insert(c.clone(), value_to_json(v));
    }
    serde_json::Value::Object(map)
}

fn value_to_json(v: &Value) -> serde_json::Value {
    use serde_json::Value as J;
    match v {
        Value::Null => J::Null,
        Value::Bool(b) => J::Bool(*b),
        Value::Int(n) => J::from(*n),
        Value::UInt(n) => J::from(*n),
        Value::Float(f) => serde_json::Number::from_f64(*f)
            .map(J::Number)
            .unwrap_or(J::Null),
        Value::Decimal(s) | Value::Text(s) | Value::Unknown(s) => J::String(s.clone()),
        Value::Date(s) | Value::Time(s) | Value::DateTime(s) => J::String(s.clone()),
        Value::Json(j) => j.clone(),
        Value::Bytes { len, preview_hex } => {
            serde_json::json!({ "_bytes": len, "preview_hex": preview_hex })
        }
        Value::Array(items) => J::Array(items.iter().map(value_to_json).collect()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_escaping() {
        assert_eq!(csv_field(&Value::Text("plain".into()), None), "plain");
        assert_eq!(csv_field(&Value::Text("a,b".into()), None), "\"a,b\"");
        assert_eq!(csv_field(&Value::Text("a\"b".into()), None), "\"a\"\"b\"");
        assert_eq!(csv_field(&Value::Null, None), "");
        assert_eq!(csv_field(&Value::Null, Some("NULL")), "NULL");
    }

    #[test]
    fn csv_row_crlf() {
        let vals = [Value::Int(1), Value::Text("x,y".into())];
        assert_eq!(csv_row(vals.iter(), None), "1,\"x,y\"\r\n");
    }

    #[test]
    fn json_row_shape() {
        let cols = vec!["id".to_string(), "name".to_string()];
        let vals = vec![Value::Int(1), Value::Null];
        let j = json_row(&cols, &vals);
        assert_eq!(j["id"], serde_json::json!(1));
        assert_eq!(j["name"], serde_json::Value::Null);
    }
}
