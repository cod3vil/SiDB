//! 轻量语句切分 tokenizer（TDD §6.2 step 1）。
//!
//! **不做完整 SQL 解析**，只负责按分号把脚本切成多条语句，正确处理：
//! - 单引号 / 双引号字符串（含连续两个引号的转义 `''`）
//! - 反引号标识符（MySQL）
//! - 行注释 `-- ...` 与块注释 `/* ... */`
//! - PostgreSQL dollar-quoted 块 `$$ ... $$` / `$tag$ ... $tag$`
//!
//! 也提供 [`first_keyword`]，供 QueryService 判断是否表浏览/事务语句、
//! 以及 AI 只读校验（TDD §7）使用。

/// 把脚本切分为多条语句（去除尾随分号；保留语句内部空白；丢弃纯空白/纯注释段）。
pub fn split_statements(sql: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = sql.as_bytes();
    let mut i = 0;
    let n = bytes.len();
    let mut start = 0usize;

    while i < n {
        let c = bytes[i];
        match c {
            b'\'' | b'"' | b'`' => {
                i = skip_quoted(bytes, i, c);
            }
            b'-' if i + 1 < n && bytes[i + 1] == b'-' => {
                i = skip_line_comment(bytes, i);
            }
            b'/' if i + 1 < n && bytes[i + 1] == b'*' => {
                i = skip_block_comment(bytes, i);
            }
            b'$' => {
                if let Some((tag_len, next)) = dollar_tag(bytes, i) {
                    i = skip_dollar_block(bytes, i, tag_len, next);
                } else {
                    i += 1;
                }
            }
            b';' => {
                let stmt = sql[start..i].trim();
                if !is_blank_or_comment(stmt) {
                    out.push(stmt.to_string());
                }
                i += 1;
                start = i;
            }
            _ => i += 1,
        }
    }

    let tail = sql[start..].trim();
    if !is_blank_or_comment(tail) {
        out.push(tail.to_string());
    }
    out
}

/// 返回语句的首个关键字（大写）。跳过前导注释/空白。空语句返回空串。
pub fn first_keyword(sql: &str) -> String {
    let bytes = sql.as_bytes();
    let mut i = 0;
    let n = bytes.len();
    loop {
        // skip whitespace
        while i < n && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i + 1 < n && bytes[i] == b'-' && bytes[i + 1] == b'-' {
            i = skip_line_comment(bytes, i);
            continue;
        }
        if i + 1 < n && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            i = skip_block_comment(bytes, i);
            continue;
        }
        break;
    }
    let kw_start = i;
    while i < n && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
        i += 1;
    }
    sql[kw_start..i].to_ascii_uppercase()
}

/// 该语句是否为只读首关键字（AI RunReadQuery 强校验用，TDD §7）。
pub fn is_read_only_keyword(kw: &str) -> bool {
    matches!(kw, "SELECT" | "WITH" | "EXPLAIN" | "SHOW" | "PRAGMA")
}

/// 事务控制关键字识别（QueryService tx 状态追踪用，TDD §6.2）。
pub fn is_tx_begin(kw: &str) -> bool {
    matches!(kw, "BEGIN" | "START")
}
pub fn is_tx_end(kw: &str) -> bool {
    matches!(kw, "COMMIT" | "ROLLBACK" | "END")
}

// ---------------------------------------------------------------------------
// 内部扫描器
// ---------------------------------------------------------------------------

/// 从开引号位置 `i` 起，返回闭引号之后的位置。处理 `''` / `""` / ` `` ` 自转义。
fn skip_quoted(b: &[u8], i: usize, q: u8) -> usize {
    let n = b.len();
    let mut j = i + 1;
    while j < n {
        if b[j] == q {
            // 连续两个相同引号 = 转义，跳过
            if j + 1 < n && b[j + 1] == q {
                j += 2;
                continue;
            }
            return j + 1;
        }
        // 反斜杠转义（MySQL 字符串）
        if b[j] == b'\\' && q != b'`' && j + 1 < n {
            j += 2;
            continue;
        }
        j += 1;
    }
    n
}

fn skip_line_comment(b: &[u8], i: usize) -> usize {
    let n = b.len();
    let mut j = i + 2;
    while j < n && b[j] != b'\n' {
        j += 1;
    }
    j
}

fn skip_block_comment(b: &[u8], i: usize) -> usize {
    let n = b.len();
    let mut j = i + 2;
    while j + 1 < n {
        if b[j] == b'*' && b[j + 1] == b'/' {
            return j + 2;
        }
        j += 1;
    }
    n
}

/// 若位置 `i` 处是 dollar-quote 起始标记，返回 (tag 总长度含两个 `$`, tag 内容结束后位置)。
/// 形如 `$$` -> tag_len=2；`$tag$` -> tag_len=5。
fn dollar_tag(b: &[u8], i: usize) -> Option<(usize, usize)> {
    let n = b.len();
    debug_assert_eq!(b[i], b'$');
    let mut j = i + 1;
    while j < n && (b[j].is_ascii_alphanumeric() || b[j] == b'_') {
        j += 1;
    }
    if j < n && b[j] == b'$' {
        // tag = b[i..=j]
        Some((j - i + 1, j + 1))
    } else {
        None
    }
}

fn skip_dollar_block(b: &[u8], i: usize, tag_len: usize, body_start: usize) -> usize {
    let n = b.len();
    let tag = &b[i..i + tag_len];
    let mut j = body_start;
    while j + tag_len <= n {
        if &b[j..j + tag_len] == tag {
            return j + tag_len;
        }
        j += 1;
    }
    n
}

fn is_blank_or_comment(s: &str) -> bool {
    first_keyword(s).is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_basic() {
        let v = split_statements("SELECT 1; SELECT 2;");
        assert_eq!(v, vec!["SELECT 1", "SELECT 2"]);
    }

    #[test]
    fn trailing_no_semicolon() {
        let v = split_statements("SELECT 1; SELECT 2");
        assert_eq!(v, vec!["SELECT 1", "SELECT 2"]);
    }

    #[test]
    fn semicolon_inside_string_ignored() {
        let v = split_statements("INSERT INTO t VALUES ('a;b'); SELECT 1");
        assert_eq!(v, vec!["INSERT INTO t VALUES ('a;b')", "SELECT 1"]);
    }

    #[test]
    fn escaped_quote_in_string() {
        let v = split_statements("SELECT 'it''s; ok'; SELECT 2");
        assert_eq!(v, vec!["SELECT 'it''s; ok'", "SELECT 2"]);
    }

    #[test]
    fn backslash_escape_in_string() {
        let v = split_statements(r#"SELECT 'a\'; b'; SELECT 2"#);
        assert_eq!(v, vec![r#"SELECT 'a\'; b'"#, "SELECT 2"]);
    }

    #[test]
    fn backtick_identifier_with_semicolon() {
        let v = split_statements("SELECT `we;ird` FROM t; SELECT 2");
        assert_eq!(v, vec!["SELECT `we;ird` FROM t", "SELECT 2"]);
    }

    #[test]
    fn line_comment_ignored() {
        let v = split_statements("SELECT 1; -- comment; still\nSELECT 2");
        assert_eq!(v, vec!["SELECT 1", "-- comment; still\nSELECT 2"]);
    }

    #[test]
    fn block_comment_with_semicolon() {
        let v = split_statements("SELECT 1 /* ; not a split */; SELECT 2");
        assert_eq!(v, vec!["SELECT 1 /* ; not a split */", "SELECT 2"]);
    }

    #[test]
    fn dollar_quoted_block() {
        let sql = "CREATE FUNCTION f() RETURNS int AS $$ BEGIN; RETURN 1; END; $$ LANGUAGE plpgsql; SELECT 2";
        let v = split_statements(sql);
        assert_eq!(v.len(), 2);
        assert!(v[0].contains("$$"));
        assert_eq!(v[1], "SELECT 2");
    }

    #[test]
    fn tagged_dollar_quoted_block() {
        let sql = "SELECT $tag$ a; b; $tag$; SELECT 2";
        let v = split_statements(sql);
        assert_eq!(v.len(), 2);
        assert_eq!(v[1], "SELECT 2");
    }

    #[test]
    fn blank_and_comment_only_dropped() {
        let v = split_statements("   ;  -- nothing\n ; /* x */ ;");
        assert!(v.is_empty(), "{v:?}");
    }

    #[test]
    fn first_keyword_skips_comments() {
        assert_eq!(first_keyword("  -- c\n  /* x */ select 1"), "SELECT");
        assert_eq!(first_keyword("WITH t AS (...) SELECT"), "WITH");
        assert_eq!(first_keyword("   "), "");
    }

    #[test]
    fn read_only_and_tx_classification() {
        assert!(is_read_only_keyword("SELECT"));
        assert!(is_read_only_keyword("PRAGMA"));
        assert!(!is_read_only_keyword("INSERT"));
        assert!(is_tx_begin("BEGIN"));
        assert!(is_tx_begin("START"));
        assert!(is_tx_end("COMMIT"));
        assert!(is_tx_end("ROLLBACK"));
    }
}
