//! 导出服务（TDD §6.4）。
//!
//! - 纯编码函数（CSV / JSON / SQL 字面量，可测）。
//! - 后台导出驱动 `run_result_export` / `run_structure_export`：**逐页拉取、逐行写盘**
//!   （铁律 #5，不全量入内存；XLSX 因格式所限需累积后落盘），每页回调进度、可取消。
//!   每页只在取数据时短暂持有 adapter 锁，写文件时不持锁，避免阻塞同连接其它查询。

use crate::models::*;
use crate::services::connection::Session;
use crate::services::query::{self, Page};
use rust_xlsxwriter::Workbook;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::sync::atomic::{AtomicBool, Ordering};

fn io_err(e: std::io::Error) -> AppError {
    AppError::Internal(format!("io: {e}"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportFormat {
    Csv,
    Json,
    Sql,
    Xlsx,
}

impl ExportFormat {
    pub fn parse(s: &str) -> Result<Self> {
        match s.to_ascii_lowercase().as_str() {
            "csv" => Ok(Self::Csv),
            "json" => Ok(Self::Json),
            "sql" => Ok(Self::Sql),
            "xlsx" => Ok(Self::Xlsx),
            other => Err(AppError::Internal(format!(
                "unknown export format: {other}"
            ))),
        }
    }
}

// ---------------------------------------------------------------------------
// CSV / JSON 纯编码
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// SQL 字面量（INSERT 导出）
// ---------------------------------------------------------------------------

/// 把一个值渲染为目标方言的 SQL 字面量。
pub fn sql_literal(v: &Value, d: &SqlDialect) -> String {
    match v {
        Value::Null => "NULL".to_string(),
        Value::Bool(b) => {
            if d.bool_keywords {
                if *b { "TRUE" } else { "FALSE" }.to_string()
            } else {
                if *b { "1" } else { "0" }.to_string()
            }
        }
        Value::Int(n) => n.to_string(),
        Value::UInt(n) => n.to_string(),
        Value::Float(f) => {
            if f.is_finite() {
                f.to_string()
            } else {
                "NULL".to_string()
            }
        }
        Value::Decimal(s) => {
            if s.is_empty() {
                "NULL".to_string()
            } else {
                s.clone()
            }
        }
        Value::Text(s)
        | Value::Unknown(s)
        | Value::Date(s)
        | Value::Time(s)
        | Value::DateTime(s) => quote_str(s, d),
        Value::Json(j) => quote_str(&j.to_string(), d),
        Value::Array(_) => quote_str(&serde_json::to_string(v).unwrap_or_default(), d),
        Value::Bytes { preview_hex, .. } => match d.bytes {
            BytesLiteral::XQuote => format!("x'{preview_hex}'"),
            BytesLiteral::PgHex => format!("'\\x{preview_hex}'"),
        },
    }
}

fn quote_str(s: &str, d: &SqlDialect) -> String {
    let esc = if d.backslash_strings {
        s.replace('\\', "\\\\").replace('\'', "\\'")
    } else {
        s.replace('\'', "''")
    };
    format!("'{esc}'")
}

fn quote_ident(name: &str, q: char) -> String {
    format!("{q}{}{q}", name.replace(q, ""))
}

/// `(col1, col2, ...)` 列名子句。
fn cols_clause(columns: &[ColumnMeta], q: char) -> String {
    let parts: Vec<String> = columns.iter().map(|c| quote_ident(&c.name, q)).collect();
    format!("({})", parts.join(", "))
}

/// 单行 INSERT 语句（含分号与换行）。
fn insert_line(table_q: &str, cols: &str, row: &[Value], d: &SqlDialect) -> String {
    let vals: Vec<String> = row.iter().map(|v| sql_literal(v, d)).collect();
    format!(
        "INSERT INTO {table_q} {cols} VALUES ({});\n",
        vals.join(", ")
    )
}

/// XLSX 单元格文本（非数值类型）。
fn xlsx_text(v: &Value) -> String {
    match v {
        Value::Decimal(s) | Value::Text(s) | Value::Unknown(s) => s.clone(),
        Value::Date(s) | Value::Time(s) | Value::DateTime(s) => s.clone(),
        Value::Json(j) => j.to_string(),
        Value::Bytes { len, .. } => format!("(BLOB {len} bytes)"),
        Value::Array(_) => serde_json::to_string(v).unwrap_or_default(),
        _ => String::new(),
    }
}

// ---------------------------------------------------------------------------
// 统一行写出器：CSV / SQL 流式写盘；XLSX 累积后落盘
// ---------------------------------------------------------------------------

enum Sink {
    Csv(BufWriter<File>),
    Sql {
        w: BufWriter<File>,
        table_q: String,
        cols: String,
        dialect: SqlDialect,
    },
    Xlsx {
        path: String,
        headers: Vec<String>,
        rows: Vec<Vec<Value>>,
    },
}

impl Sink {
    fn new(
        format: ExportFormat,
        path: &str,
        table_name: &str,
        dialect: SqlDialect,
    ) -> Result<Self> {
        match format {
            ExportFormat::Csv | ExportFormat::Json => {
                let f = File::create(path).map_err(io_err)?;
                Ok(Sink::Csv(BufWriter::new(f)))
            }
            ExportFormat::Sql => {
                let f = File::create(path).map_err(io_err)?;
                Ok(Sink::Sql {
                    w: BufWriter::new(f),
                    table_q: quote_ident(table_name, dialect.quote_char),
                    cols: String::new(),
                    dialect,
                })
            }
            ExportFormat::Xlsx => Ok(Sink::Xlsx {
                path: path.to_string(),
                headers: Vec::new(),
                rows: Vec::new(),
            }),
        }
    }

    fn header(&mut self, columns: &[ColumnMeta]) -> Result<()> {
        match self {
            Sink::Csv(w) => {
                let cells: Vec<String> = columns.iter().map(|c| escape_csv(&c.name)).collect();
                let line = format!("{}\r\n", cells.join(","));
                w.write_all(line.as_bytes()).map_err(io_err)
            }
            Sink::Sql { cols, dialect, .. } => {
                *cols = cols_clause(columns, dialect.quote_char);
                Ok(())
            }
            Sink::Xlsx { headers, .. } => {
                *headers = columns.iter().map(|c| c.name.clone()).collect();
                Ok(())
            }
        }
    }

    fn row(&mut self, values: &[Value]) -> Result<()> {
        match self {
            Sink::Csv(w) => w
                .write_all(csv_row(values.iter(), None).as_bytes())
                .map_err(io_err),
            Sink::Sql {
                w,
                table_q,
                cols,
                dialect,
            } => w
                .write_all(insert_line(table_q, cols, values, dialect).as_bytes())
                .map_err(io_err),
            Sink::Xlsx { rows, .. } => {
                rows.push(values.to_vec());
                Ok(())
            }
        }
    }

    fn finish(self) -> Result<()> {
        match self {
            Sink::Csv(mut w) => w.flush().map_err(io_err),
            Sink::Sql { mut w, .. } => w.flush().map_err(io_err),
            Sink::Xlsx {
                path,
                headers,
                rows,
            } => write_xlsx(&path, &headers, &rows),
        }
    }
}

fn write_xlsx(path: &str, headers: &[String], rows: &[Vec<Value>]) -> Result<()> {
    let xerr = |e: rust_xlsxwriter::XlsxError| AppError::Internal(format!("xlsx: {e}"));
    let mut wb = Workbook::new();
    let ws = wb.add_worksheet();
    for (c, h) in headers.iter().enumerate() {
        ws.write_string(0, c as u16, h).map_err(xerr)?;
    }
    for (r, row) in rows.iter().enumerate() {
        let rr = (r + 1) as u32;
        for (c, v) in row.iter().enumerate() {
            let cc = c as u16;
            match v {
                Value::Null => {}
                Value::Bool(b) => {
                    ws.write_boolean(rr, cc, *b).map_err(xerr)?;
                }
                Value::Int(n) => {
                    ws.write_number(rr, cc, *n as f64).map_err(xerr)?;
                }
                Value::UInt(n) => {
                    ws.write_number(rr, cc, *n as f64).map_err(xerr)?;
                }
                Value::Float(f) => {
                    ws.write_number(rr, cc, *f).map_err(xerr)?;
                }
                other => {
                    ws.write_string(rr, cc, xlsx_text(other)).map_err(xerr)?;
                }
            }
        }
    }
    wb.save(path).map_err(xerr)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 后台导出驱动
// ---------------------------------------------------------------------------

/// 进度回调载荷。
pub struct ExportTick {
    pub written: u64,
    pub total: Option<u64>,
    pub message: Option<String>,
}

/// 导出结果。
pub struct ExportOutcome {
    pub written: u64,
    pub cancelled: bool,
}

/// 数据来源：表浏览或自定义查询。
pub enum ExportSource {
    Table(TableRef),
    Query(String),
}

/// 导出范围。
pub enum ExportScope {
    All,
    /// 仅导出某一页（0 基）。
    Page(u64),
    /// 最多导出 N 行。
    Rows(u64),
}

/// 导出结果集（CSV / XLSX / SQL）。逐页拉取、逐行写出。
#[allow(clippy::too_many_arguments)]
pub async fn run_result_export(
    session: &Session,
    source: ExportSource,
    format: ExportFormat,
    scope: ExportScope,
    page_size: u64,
    path: &str,
    sql_table_name: &str,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(ExportTick),
) -> Result<ExportOutcome> {
    let dialect = session.adapter.lock().await.sql_dialect();
    let total: Option<u64> = match (&source, &scope) {
        (_, ExportScope::Page(_)) => Some(page_size),
        (_, ExportScope::Rows(n)) => Some(*n),
        (ExportSource::Table(t), ExportScope::All) => {
            let a = session.adapter.lock().await;
            query::count_table(&**a, &session.caps, t, session.read_timeout).await
        }
        (ExportSource::Query(_), ExportScope::All) => None,
    };
    on_progress(ExportTick {
        written: 0,
        total,
        message: None,
    });

    let mut sink = Sink::new(format, path, sql_table_name, dialect)?;
    let (start, max_rows, single) = match scope {
        ExportScope::All => (0u64, None, false),
        ExportScope::Page(p) => (p, Some(page_size), true),
        ExportScope::Rows(n) => (0u64, Some(n), false),
    };

    let mut written = 0u64;
    let mut cur = start;
    let mut first = true;
    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = sink.finish();
            return Ok(ExportOutcome {
                written,
                cancelled: true,
            });
        }
        let pg = Page {
            page: cur,
            page_size,
        };
        let sql = match &source {
            ExportSource::Table(t) => query::browse_sql(&session.caps, t, pg, None)?,
            ExportSource::Query(q) => query::wrap_pagination(q, pg),
        };
        let raw = {
            let a = session.adapter.lock().await;
            query::with_timeout(session.read_timeout, a.query("__export__", &sql, &[])).await?
        };
        if first {
            sink.header(&raw.columns)?;
            first = false;
        }
        let n = raw.rows.len() as u64;
        for row in &raw.rows {
            if max_rows.map(|m| written >= m).unwrap_or(false) {
                break;
            }
            sink.row(row)?;
            written += 1;
        }
        on_progress(ExportTick {
            written,
            total,
            message: None,
        });
        let reached = max_rows.map(|m| written >= m).unwrap_or(false);
        if single || reached || n < page_size {
            break;
        }
        cur += 1;
    }
    sink.finish()?;
    Ok(ExportOutcome {
        written,
        cancelled: false,
    })
}

/// 一张待转存的表。
pub struct DumpTable {
    pub tref: TableRef,
    /// 是否转存数据（视图或仅结构时为 false）。
    pub with_data: bool,
}

/// 转存结构（+可选数据）为 .sql 文件。逐表 DDL，再逐页 INSERT。
pub async fn run_structure_export(
    session: &Session,
    tables: Vec<DumpTable>,
    page_size: u64,
    path: &str,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(ExportTick),
) -> Result<ExportOutcome> {
    let dialect = session.adapter.lock().await.sql_dialect();
    let f = File::create(path).map_err(io_err)?;
    let mut w = BufWriter::new(f);
    let mut written = 0u64;

    for dt in &tables {
        if cancel.load(Ordering::Relaxed) {
            w.flush().map_err(io_err)?;
            return Ok(ExportOutcome {
                written,
                cancelled: true,
            });
        }
        let ddl = {
            let a = session.adapter.lock().await;
            a.table_ddl(&dt.tref).await?
        };
        let header = format!(
            "-- ----------------------------\n-- {}\n-- ----------------------------\n",
            dt.tref.name
        );
        w.write_all(header.as_bytes()).map_err(io_err)?;
        w.write_all(ddl.trim_end().as_bytes()).map_err(io_err)?;
        if !ddl.trim_end().ends_with(';') {
            w.write_all(b";").map_err(io_err)?;
        }
        w.write_all(b"\n\n").map_err(io_err)?;
        on_progress(ExportTick {
            written,
            total: None,
            message: Some(dt.tref.name.clone()),
        });

        if !dt.with_data {
            continue;
        }
        let table_q = quote_ident(&dt.tref.name, dialect.quote_char);
        let mut cols = String::new();
        let mut cur = 0u64;
        loop {
            if cancel.load(Ordering::Relaxed) {
                w.flush().map_err(io_err)?;
                return Ok(ExportOutcome {
                    written,
                    cancelled: true,
                });
            }
            let pg = Page {
                page: cur,
                page_size,
            };
            let sql = query::browse_sql(&session.caps, &dt.tref, pg, None)?;
            let raw = {
                let a = session.adapter.lock().await;
                query::with_timeout(session.read_timeout, a.query("__export__", &sql, &[])).await?
            };
            if cols.is_empty() && !raw.columns.is_empty() {
                cols = cols_clause(&raw.columns, dialect.quote_char);
            }
            let n = raw.rows.len() as u64;
            for row in &raw.rows {
                w.write_all(insert_line(&table_q, &cols, row, &dialect).as_bytes())
                    .map_err(io_err)?;
                written += 1;
            }
            on_progress(ExportTick {
                written,
                total: None,
                message: Some(dt.tref.name.clone()),
            });
            if n < page_size {
                break;
            }
            cur += 1;
        }
        w.write_all(b"\n").map_err(io_err)?;
    }
    w.flush().map_err(io_err)?;
    Ok(ExportOutcome {
        written,
        cancelled: false,
    })
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

    fn mysql_dialect() -> SqlDialect {
        SqlDialect {
            quote_char: '`',
            bool_keywords: false,
            backslash_strings: true,
            bytes: BytesLiteral::XQuote,
        }
    }

    fn pg_dialect() -> SqlDialect {
        SqlDialect {
            quote_char: '"',
            bool_keywords: true,
            backslash_strings: false,
            bytes: BytesLiteral::PgHex,
        }
    }

    #[test]
    fn sql_literal_basic() {
        let m = mysql_dialect();
        assert_eq!(sql_literal(&Value::Null, &m), "NULL");
        assert_eq!(sql_literal(&Value::Int(42), &m), "42");
        assert_eq!(sql_literal(&Value::Bool(true), &m), "1");
        assert_eq!(sql_literal(&Value::Text("a'b".into()), &m), "'a\\'b'");
        let p = pg_dialect();
        assert_eq!(sql_literal(&Value::Bool(true), &p), "TRUE");
        assert_eq!(sql_literal(&Value::Text("a'b".into()), &p), "'a''b'");
        assert_eq!(
            sql_literal(
                &Value::Bytes {
                    len: 1,
                    preview_hex: "ab".into()
                },
                &p
            ),
            "'\\xab'"
        );
    }

    #[test]
    fn insert_line_shape() {
        let m = mysql_dialect();
        let cols = "(`id`, `name`)";
        let row = [Value::Int(1), Value::Text("x".into())];
        assert_eq!(
            insert_line("`t`", cols, &row, &m),
            "INSERT INTO `t` (`id`, `name`) VALUES (1, 'x');\n"
        );
    }
}
