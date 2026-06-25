// Redis (KV) 工作区 —— engine==redis 的连接打开后替换主区（Phase 1：浏览只读 + 命令台）。
//
// 左栏：DB 选择 + 模式过滤 + 键列表（SCAN 增量、加载更多）。
// 右栏：值面板（按类型只读渲染） / 命令台 两个标签。

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "@/ipc";
import type { RedisKeyMeta, RedisKeyDetail, RedisValue, RedisReply, RedisField } from "@/ipc/types";
import { toast } from "@/stores/toast";
import { errorMessage } from "@/lib/error";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { AiPanel } from "@/components/ai/AiPanel";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";

const SCAN_COUNT = 1000;
const VALUE_PAGE = 200;

const TYPE_ICON: Record<string, string> = {
  string: "ri-text",
  hash: "ri-hashtag",
  list: "ri-list-ordered-2",
  set: "ri-asterisk",
  zset: "ri-sort-desc",
  stream: "ri-flow-chart",
};

function ttlLabel(ms: number): string {
  if (ms === -1) return "∞";
  if (ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** 命令分词：支持双引号包裹的参数。 */
function tokenize(input: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) out.push(m[1] ?? m[2]);
  return out;
}

function Fld({ f }: { f: RedisField }) {
  return (
    <span className={cn(f.binary && "text-sky-400")} title={f.binary ? "binary (hex)" : undefined}>
      {f.text}
      {f.binary && <span className="ml-1 text-[10px] text-muted-foreground">hex</span>}
    </span>
  );
}

export function RedisWorkspace({ connId }: { connId: string }) {
  const { t } = useTranslation();
  const [dbCount, setDbCount] = useState(16);
  const [db, setDb] = useState(0);
  const [dbSize, setDbSize] = useState<number | null>(null);
  const [pattern, setPattern] = useState("");
  const [keys, setKeys] = useState<RedisKeyMeta[]>([]);
  const [cursor, setCursor] = useState("0");
  const [scanning, setScanning] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<RedisKeyDetail | null>(null);
  const [value, setValue] = useState<RedisValue | null>(null);
  const [loadingVal, setLoadingVal] = useState(false);
  const [tab, setTab] = useState<"value" | "console">("value");
  const [typeFilter, setTypeFilter] = useState("");
  const [aiOpen, setAiOpen] = useState(false);
  const [consoleLog, setConsoleLog] = useState<{ cmd: string; reply: RedisReply }[]>([]);
  const [consoleInput, setConsoleInput] = useState("");

  // 类型过滤为客户端过滤（SCAN 无按类型筛选）：只过滤已加载的键。
  const shownKeys = typeFilter ? keys.filter((k) => k.type === typeFilter) : keys;

  // 在命令台执行一行命令并追加到日志（AI「运行」也复用）。
  const runCommand = useCallback(
    async (line: string) => {
      const args = tokenize(line);
      if (args.length === 0) return;
      try {
        const reply = await ipc.redisCommand(connId, db, args);
        setConsoleLog((l) => [...l, { cmd: line, reply }]);
      } catch (e) {
        setConsoleLog((l) => [...l, { cmd: line, reply: { kind: "error", text: errorMessage(e) } }]);
      }
    },
    [connId, db],
  );

  const doExport = async () => {
    const path = await saveFileDialog({
      defaultPath: `redis-db${db}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (typeof path !== "string") return;
    try {
      const n = await ipc.redisExport(connId, db, pattern.trim() || "*", path);
      toast.success(t("redis.exported", { n }));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  // DB 数量（初次）。
  useEffect(() => {
    ipc.redisDbCount(connId).then(setDbCount).catch(() => undefined);
  }, [connId]);

  const runScan = useCallback(
    async (reset: boolean) => {
      setScanning(true);
      try {
        const cur = reset ? "0" : cursor;
        const page = await ipc.redisScan(connId, db, pattern.trim() || "*", cur, SCAN_COUNT);
        setKeys((prev) => (reset ? page.keys : [...prev, ...page.keys]));
        setCursor(page.cursor);
      } catch (e) {
        toast.error(errorMessage(e));
      } finally {
        setScanning(false);
      }
    },
    [connId, db, pattern, cursor],
  );

  // 切库 / 初次：刷新 dbsize + 重新扫描。
  useEffect(() => {
    setSelected(null);
    setDetail(null);
    setValue(null);
    setKeys([]);
    setCursor("0");
    setConsoleLog([]);
    ipc.redisDbsize(connId, db).then(setDbSize).catch(() => setDbSize(null));
    void runScan(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, db]);

  const openKey = async (key: string) => {
    setSelected(key);
    setTab("value");
    setLoadingVal(true);
    try {
      const [d, v] = await Promise.all([
        ipc.redisKeyDetail(connId, db, key),
        ipc.redisGetValue(connId, db, key, "0", VALUE_PAGE, 0, VALUE_PAGE - 1),
      ]);
      setDetail(d);
      setValue(v);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoadingVal(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1">
      {/* 左栏：DB + 过滤 + 键列表 */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-border bg-card/40">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2">
          <i className="ri-database-2-line text-muted-foreground" />
          <select
            value={db}
            onChange={(e) => setDb(Number(e.target.value))}
            className="h-7 rounded-md border border-border bg-background px-1.5 text-xs text-foreground outline-none"
          >
            {Array.from({ length: dbCount }, (_, i) => (
              <option key={i} value={i}>
                DB {i}
              </option>
            ))}
          </select>
          <span className="ml-auto text-[11px] text-muted-foreground">
            {dbSize != null ? t("redis.keysCount", { n: dbSize }) : ""}
          </span>
          <button
            onClick={doExport}
            title={t("redis.export")}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <i className="ri-download-2-line" />
          </button>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border p-2">
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            title={t("redis.typeFilter")}
            className="h-7 shrink-0 rounded-md border border-border bg-background px-1 text-xs text-foreground outline-none"
          >
            <option value="">{t("redis.allTypes")}</option>
            {["string", "list", "set", "zset", "hash", "stream"].map((tp) => (
              <option key={tp} value={tp}>
                {tp}
              </option>
            ))}
          </select>
          <input
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && runScan(true)}
            placeholder={t("redis.patternPlaceholder")}
            className="h-7 min-w-0 flex-1 rounded-md border border-border bg-muted px-2 text-xs text-foreground placeholder:text-muted-foreground/70 outline-none focus:border-primary"
          />
          <button
            onClick={() => runScan(true)}
            title={t("redis.scan")}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <i className="ri-search-line text-sm" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto py-1">
          {shownKeys.map((k) => (
            <button
              key={k.name}
              onClick={() => openKey(k.name)}
              className={cn(
                "flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs",
                selected === k.name ? "bg-accent text-foreground" : "text-foreground hover:bg-accent/60",
              )}
              title={k.name}
            >
              <i className={cn(TYPE_ICON[k.type] ?? "ri-question-line", "shrink-0 text-sm text-primary")} />
              <span className="min-w-0 flex-1 truncate font-mono">{k.name}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground">{ttlLabel(k.ttl_ms)}</span>
            </button>
          ))}
          {shownKeys.length === 0 && !scanning && (
            <div className="px-3 py-8 text-center text-xs text-muted-foreground/70">{t("redis.noKeys")}</div>
          )}
          {cursor !== "0" && (
            <button
              onClick={() => runScan(false)}
              disabled={scanning}
              className="mx-2 my-1.5 flex w-[calc(100%-1rem)] items-center justify-center gap-1 rounded-md border border-border py-1 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50"
            >
              {scanning ? <i className="ri-loader-4-line animate-spin" /> : <i className="ri-add-line" />}
              {t("redis.loadMore")}
            </button>
          )}
        </div>
      </aside>

      {/* 中栏：值面板 / 命令台 */}
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-stretch border-b border-border bg-card/40">
          <TabBtn active={tab === "value"} onClick={() => setTab("value")} icon="ri-eye-line" label={t("redis.valueTab")} />
          <TabBtn active={tab === "console"} onClick={() => setTab("console")} icon="ri-terminal-line" label={t("redis.consoleTab")} />
          <button
            onClick={() => setAiOpen((v) => !v)}
            title={t("ai.title")}
            className={cn(
              "ml-auto mr-2 my-1 flex items-center gap-1 rounded px-2 text-xs",
              aiOpen ? "bg-accent text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <i className="ri-sparkling-2-line" />
            AI
          </button>
        </div>
        {tab === "value" ? (
          <ValuePanel
            connId={connId}
            db={db}
            selected={selected}
            detail={detail}
            value={value}
            loading={loadingVal}
            onReload={() => selected && openKey(selected)}
            onKeyGone={() => {
              setSelected(null);
              setDetail(null);
              setValue(null);
              void runScan(true);
              ipc.redisDbsize(connId, db).then(setDbSize).catch(() => undefined);
            }}
          />
        ) : (
          <Console
            db={db}
            log={consoleLog}
            input={consoleInput}
            setInput={setConsoleInput}
            onSend={runCommand}
          />
        )}
      </main>

      {aiOpen && (
        <AiPanel
          width={360}
          connId={connId}
          database={String(db)}
          schema={null}
          table={selected}
          resultContext={null}
          onInsertSql={(cmd) => {
            setTab("console");
            setConsoleInput(cmd);
          }}
          onRunSql={(cmd) => {
            setTab("console");
            void runCommand(cmd);
          }}
          onConfirmWrite={async (id) => {
            await ipc.aiConfirmWrite(connId, id);
            if (selected) void openKey(selected);
            else void runScan(true);
          }}
          onClose={() => setAiOpen(false)}
        />
      )}
    </div>
  );
}

function TabBtn({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: string; label: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 border-b-2 px-3 text-xs",
        active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      <i className={icon} />
      {label}
    </button>
  );
}

/** 写命令封装：成功返回 true；出错弹 toast 返回 false。 */
type WriteFn = (args: string[]) => Promise<boolean>;

function ValuePanel({
  connId,
  db,
  selected,
  detail,
  value,
  loading,
  onReload,
  onKeyGone,
}: {
  connId: string;
  db: number;
  selected: string | null;
  detail: RedisKeyDetail | null;
  value: RedisValue | null;
  loading: boolean;
  onReload: () => void;
  onKeyGone: () => void;
}) {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState("");
  const [ttlInput, setTtlInput] = useState("");
  const [confirmDel, setConfirmDel] = useState(false);

  const write = useCallback<WriteFn>(
    async (args) => {
      const r = await ipc.redisCommand(connId, db, args);
      if (r.kind === "error") {
        toast.error(r.text);
        return false;
      }
      return true;
    },
    [connId, db],
  );

  if (!selected) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground/70">
        <div className="text-center">
          <i className="ri-key-2-line mb-2 block text-3xl text-muted-foreground/40" />
          {t("redis.selectKey")}
        </div>
      </div>
    );
  }

  const doRename = async () => {
    const nn = renameVal.trim();
    if (!nn || nn === selected) {
      setRenaming(false);
      return;
    }
    if (await write(["RENAME", selected, nn])) {
      setRenaming(false);
      onKeyGone();
    }
  };
  const setTtl = async () => {
    const s = parseInt(ttlInput, 10);
    if (isNaN(s)) return;
    if (await write(["EXPIRE", selected, String(s)])) {
      setTtlInput("");
      onReload();
    }
  };
  const persist = async () => {
    if (await write(["PERSIST", selected])) onReload();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* key 头部：第一行 key 名（或重命名输入 + 保存）；第二行类型/TTL/大小 + 操作 */}
      <div className="shrink-0 border-b border-border px-3 py-2">
        <div className="flex items-center gap-1.5">
          {renaming ? (
            <>
              <input
                autoFocus
                value={renameVal}
                onChange={(e) => setRenameVal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void doRename();
                  else if (e.key === "Escape") setRenaming(false);
                }}
                className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 font-mono text-sm text-foreground outline-none focus:border-primary"
              />
              <button
                onClick={() => void doRename()}
                className="flex h-7 shrink-0 items-center gap-1 rounded-md bg-primary px-2 text-xs text-primary-foreground hover:bg-primary/90"
              >
                <i className="ri-check-line" />
                {t("redis.save")}
              </button>
              <button
                onClick={() => setRenaming(false)}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <i className="ri-close-line" />
              </button>
            </>
          ) : (
            <span className="break-all font-mono text-sm text-foreground">{selected}</span>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          {detail && (
            <>
              <Badge>{detail.type}</Badge>
              <Badge>TTL {ttlLabel(detail.ttl_ms)}</Badge>
              <Badge>
                {t("redis.size")} {detail.size}
              </Badge>
              {detail.mem_bytes != null && <Badge>{detail.mem_bytes} B</Badge>}
            </>
          )}
          <div className="ml-auto flex items-center gap-1">
            <ToolBtn icon="ri-refresh-line" title={t("tree.refresh")} onClick={onReload} />
            <ToolBtn
              icon="ri-edit-line"
              title={t("redis.rename")}
              onClick={() => {
                setRenameVal(selected);
                setRenaming(true);
              }}
            />
            <ToolBtn icon="ri-delete-bin-line" title={t("redis.delKey")} danger onClick={() => setConfirmDel(true)} />
          </div>
        </div>
      </div>
      {/* TTL 行 */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
        <span>TTL</span>
        <input
          value={ttlInput}
          onChange={(e) => setTtlInput(e.target.value.replace(/[^0-9]/g, ""))}
          onKeyDown={(e) => e.key === "Enter" && setTtl()}
          placeholder={t("redis.seconds")}
          className="h-6 w-24 rounded border border-border bg-background px-1.5 text-foreground outline-none focus:border-primary"
        />
        <button onClick={setTtl} className="rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground">
          {t("redis.setTtl")}
        </button>
        <button onClick={persist} className="rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground">
          {t("redis.persist")}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs">
        {loading ? (
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <i className="ri-loader-4-line animate-spin" /> …
          </div>
        ) : value ? (
          <ValueBody value={value} keyName={selected} write={write} onReload={onReload} />
        ) : null}
      </div>

      {confirmDel && (
        <ConfirmDialog
          danger
          message={t("redis.delKeyConfirm", { key: selected })}
          onCancel={() => setConfirmDel(false)}
          onConfirm={async () => {
            setConfirmDel(false);
            if (await write(["DEL", selected])) onKeyGone();
          }}
        />
      )}
    </div>
  );
}

function ToolBtn({ icon, title, onClick, danger }: { icon: string; title: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground",
        danger && "hover:bg-destructive/10 hover:text-destructive",
      )}
    >
      <i className={icon} />
    </button>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{children}</span>
  );
}

function Total({ total, shown }: { total: number; shown: number }) {
  const { t } = useTranslation();
  if (shown >= total) return null;
  return <div className="mt-2 text-[11px] text-muted-foreground">{t("redis.partial", { shown, total })}</div>;
}

/** 行内可编辑值：变更后出现 ✓ 保存；binary 只读。 */
function EditableValue({ initial, binary, onSave }: { initial: string; binary: boolean; onSave: (v: string) => void }) {
  const [v, setV] = useState(initial);
  useEffect(() => setV(initial), [initial]);
  if (binary) {
    return (
      <span className="text-sky-400">
        {initial}
        <span className="ml-1 text-[10px] text-muted-foreground">hex 只读</span>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1">
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && v !== initial && onSave(v)}
        className="min-w-0 flex-1 rounded border border-border bg-background px-1 py-0.5 text-foreground outline-none focus:border-primary"
      />
      {v !== initial && (
        <button onClick={() => onSave(v)} className="shrink-0 text-primary" title="save">
          <i className="ri-check-line" />
        </button>
      )}
    </span>
  );
}

function DelBtn({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="shrink-0 text-muted-foreground hover:text-destructive" title="delete">
      <i className="ri-delete-bin-line" />
    </button>
  );
}

function ValueBody({ value, keyName, write, onReload }: { value: RedisValue; keyName: string; write: WriteFn; onReload: () => void }) {
  const { t } = useTranslation();
  const after = (ok: boolean) => {
    if (ok) onReload();
  };
  switch (value.type) {
    case "string":
      return <StringEditor f={value.value} keyName={keyName} write={write} onReload={onReload} />;
    case "hash":
      return (
        <div className="space-y-2">
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-left text-[11px] text-muted-foreground">
                <th className="border-b border-border px-2 py-1 font-medium">field</th>
                <th className="border-b border-border px-2 py-1 font-medium">value</th>
                <th className="w-8 border-b border-border" />
              </tr>
            </thead>
            <tbody>
              {value.fields.map(([f, v], i) => (
                <tr key={i} className="align-top">
                  <td className="border-b border-border/60 px-2 py-1 text-muted-foreground"><Fld f={f} /></td>
                  <td className="border-b border-border/60 px-2 py-1 text-foreground">
                    <EditableValue initial={v.text} binary={v.binary || f.binary} onSave={(nv) => write(["HSET", keyName, f.text, nv]).then(after)} />
                  </td>
                  <td className="border-b border-border/60 px-1 py-1">
                    <DelBtn onClick={() => write(["HDEL", keyName, f.text]).then(after)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <AddPair labels={["field", "value"]} onAdd={(a, b) => write(["HSET", keyName, a, b]).then(after)} />
          <Total total={value.total} shown={value.fields.length} />
        </div>
      );
    case "zset":
      return (
        <div className="space-y-2">
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-left text-[11px] text-muted-foreground">
                <th className="border-b border-border px-2 py-1 font-medium">member</th>
                <th className="border-b border-border px-2 py-1 font-medium">score</th>
                <th className="w-8 border-b border-border" />
              </tr>
            </thead>
            <tbody>
              {value.items.map(([m, s], i) => (
                <tr key={i} className="align-top">
                  <td className="border-b border-border/60 px-2 py-1 text-muted-foreground"><Fld f={m} /></td>
                  <td className="border-b border-border/60 px-2 py-1 text-foreground">
                    <EditableValue initial={String(s)} binary={m.binary} onSave={(nv) => write(["ZADD", keyName, nv, m.text]).then(after)} />
                  </td>
                  <td className="border-b border-border/60 px-1 py-1">
                    <DelBtn onClick={() => write(["ZREM", keyName, m.text]).then(after)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <AddPair labels={["member", "score"]} onAdd={(m, sc) => write(["ZADD", keyName, sc, m]).then(after)} />
          <Total total={value.total} shown={value.items.length} />
        </div>
      );
    case "list":
      return (
        <div className="space-y-2">
          <table className="w-full border-collapse">
            <tbody>
              {value.items.map((it, i) => {
                const idx = value.start + i;
                return (
                  <tr key={i} className="align-top">
                    <td className="w-12 border-b border-border/60 px-2 py-1 text-muted-foreground">{idx}</td>
                    <td className="border-b border-border/60 px-2 py-1 text-foreground">
                      <EditableValue initial={it.text} binary={it.binary} onSave={(nv) => write(["LSET", keyName, String(idx), nv]).then(after)} />
                    </td>
                    <td className="border-b border-border/60 px-1 py-1">
                      <DelBtn
                        onClick={async () => {
                          // 按索引删除：占位 + LREM（Redis 无按索引删除原语）。
                          const ph = `__sidb_del_${crypto.randomUUID()}`;
                          if (await write(["LSET", keyName, String(idx), ph])) {
                            await write(["LREM", keyName, "1", ph]);
                            onReload();
                          }
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <AddSingle label={t("redis.pushTail")} onAdd={(v) => write(["RPUSH", keyName, v]).then(after)} />
          <Total total={value.total} shown={value.items.length} />
        </div>
      );
    case "set":
      return (
        <div className="space-y-2">
          <table className="w-full border-collapse">
            <tbody>
              {value.members.map((m, i) => (
                <tr key={i} className="align-top">
                  <td className="border-b border-border/60 px-2 py-1 text-foreground break-all"><Fld f={m} /></td>
                  <td className="w-8 border-b border-border/60 px-1 py-1">
                    <DelBtn onClick={() => write(["SREM", keyName, m.text]).then(after)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <AddSingle label={t("redis.addMember")} onAdd={(v) => write(["SADD", keyName, v]).then(after)} />
          <Total total={value.total} shown={value.members.length} />
        </div>
      );
    case "stream":
      return (
        <div className="space-y-2">
          {value.entries.map((e) => (
            <div key={e.id} className="rounded border border-border">
              <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-2 py-1 text-[11px]">
                <span className="text-primary">{e.id}</span>
                <span className="ml-auto">
                  <DelBtn onClick={() => write(["XDEL", keyName, e.id]).then(after)} />
                </span>
              </div>
              <div className="p-2">
                <table className="w-full border-collapse">
                  <tbody>
                    {e.fields.map(([f, v], i) => (
                      <tr key={i} className="align-top">
                        <td className="border-b border-border/60 px-2 py-1 text-muted-foreground"><Fld f={f} /></td>
                        <td className="border-b border-border/60 px-2 py-1 text-foreground break-all"><Fld f={v} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
          <StreamAdd onAdd={(pairs) => write(["XADD", keyName, "*", ...pairs]).then(after)} />
          <Total total={value.total} shown={value.entries.length} />
        </div>
      );
    default:
      return <span className="text-muted-foreground">—</span>;
  }
}

function StringEditor({ f, keyName, write, onReload }: { f: RedisField; keyName: string; write: WriteFn; onReload: () => void }) {
  const { t } = useTranslation();
  const [v, setV] = useState(f.text);
  useEffect(() => setV(f.text), [f.text]);
  if (f.binary) {
    return (
      <div className="text-sky-400">
        {f.text}
        <div className="mt-1 text-[10px] text-muted-foreground">{t("redis.binaryReadonly")}</div>
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <textarea
        value={v}
        onChange={(e) => setV(e.target.value)}
        spellCheck={false}
        className="h-48 w-full resize-y rounded-md border border-border bg-background p-2 text-foreground outline-none focus:border-primary"
      />
      <button
        onClick={async () => {
          if (await write(["SET", keyName, v])) onReload();
        }}
        disabled={v === f.text}
        className="rounded-md bg-primary px-3 py-1 text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
      >
        {t("redis.save")}
      </button>
    </div>
  );
}

function AddSingle({ label, onAdd }: { label: string; onAdd: (v: string) => void }) {
  const [v, setV] = useState("");
  return (
    <div className="flex items-center gap-1.5">
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && v && (onAdd(v), setV(""))}
        placeholder={label}
        className="h-7 flex-1 rounded border border-border bg-background px-2 text-foreground outline-none focus:border-primary"
      />
      <button
        onClick={() => v && (onAdd(v), setV(""))}
        className="flex h-7 w-7 items-center justify-center rounded bg-primary text-primary-foreground hover:bg-primary/90"
      >
        <i className="ri-add-line" />
      </button>
    </div>
  );
}

function AddPair({ labels, onAdd }: { labels: [string, string]; onAdd: (a: string, b: string) => void }) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const submit = () => {
    if (!a) return;
    onAdd(a, b);
    setA("");
    setB("");
  };
  return (
    <div className="flex items-center gap-1.5">
      <input value={a} onChange={(e) => setA(e.target.value)} placeholder={labels[0]} className="h-7 flex-1 rounded border border-border bg-background px-2 text-foreground outline-none focus:border-primary" />
      <input value={b} onChange={(e) => setB(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} placeholder={labels[1]} className="h-7 flex-1 rounded border border-border bg-background px-2 text-foreground outline-none focus:border-primary" />
      <button onClick={submit} className="flex h-7 w-7 items-center justify-center rounded bg-primary text-primary-foreground hover:bg-primary/90">
        <i className="ri-add-line" />
      </button>
    </div>
  );
}

function StreamAdd({ onAdd }: { onAdd: (pairs: string[]) => void }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<{ f: string; v: string }[]>([{ f: "", v: "" }]);
  const submit = () => {
    const pairs: string[] = [];
    for (const r of rows) if (r.f) pairs.push(r.f, r.v);
    if (pairs.length === 0) return;
    onAdd(pairs);
    setRows([{ f: "", v: "" }]);
  };
  return (
    <div className="space-y-1.5 rounded border border-border p-2">
      <div className="text-[11px] text-muted-foreground">{t("redis.addEntry")}</div>
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input value={r.f} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, f: e.target.value } : x)))} placeholder="field" className="h-7 flex-1 rounded border border-border bg-background px-2 text-foreground outline-none focus:border-primary" />
          <input value={r.v} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} placeholder="value" className="h-7 flex-1 rounded border border-border bg-background px-2 text-foreground outline-none focus:border-primary" />
          {i === rows.length - 1 ? (
            <button onClick={() => setRows((rs) => [...rs, { f: "", v: "" }])} className="flex h-7 w-7 items-center justify-center rounded border border-border text-muted-foreground hover:bg-accent">
              <i className="ri-add-line" />
            </button>
          ) : (
            <button onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} className="flex h-7 w-7 items-center justify-center rounded border border-border text-muted-foreground hover:text-destructive">
              <i className="ri-subtract-line" />
            </button>
          )}
        </div>
      ))}
      <button onClick={submit} className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90">
        {t("redis.addEntry")}
      </button>
    </div>
  );
}

function Console({
  db,
  log,
  input,
  setInput,
  onSend,
}: {
  db: number;
  log: { cmd: string; reply: RedisReply }[];
  input: string;
  setInput: (v: string) => void;
  onSend: (line: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [log]);

  const send = async () => {
    const line = input.trim();
    if (!line || busy) return;
    setInput("");
    setBusy(true);
    try {
      await onSend(line);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs">
        {log.length === 0 && (
          <div className="text-muted-foreground/70">{t("redis.consoleHint")}</div>
        )}
        {log.map((e, i) => (
          <div key={i} className="mb-2">
            <div className="text-primary">
              <span className="text-muted-foreground">DB{db}&gt; </span>
              {e.cmd}
            </div>
            <div className="mt-0.5 whitespace-pre-wrap break-all text-foreground">
              <ReplyView reply={e.reply} />
            </div>
          </div>
        ))}
      </div>
      <div className="flex shrink-0 items-center gap-1.5 border-t border-border p-2">
        <span className="font-mono text-xs text-muted-foreground">DB{db}&gt;</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder={t("redis.consolePlaceholder")}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="h-8 flex-1 rounded-md border border-border bg-muted px-2 font-mono text-xs text-foreground placeholder:text-muted-foreground/70 outline-none focus:border-primary"
        />
        <button
          onClick={send}
          disabled={busy || !input.trim()}
          className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
        >
          <i className={cn("text-base", busy ? "ri-loader-4-line animate-spin" : "ri-corner-down-left-line")} />
        </button>
      </div>
    </div>
  );
}

function ReplyView({ reply, depth = 0 }: { reply: RedisReply; depth?: number }) {
  switch (reply.kind) {
    case "nil":
      return <span className="text-muted-foreground">(nil)</span>;
    case "int":
      return <span className="text-amber-500">(integer) {reply.value}</span>;
    case "double":
      return <span className="text-amber-500">(double) {reply.value}</span>;
    case "bool":
      return <span className="text-amber-500">{String(reply.value)}</span>;
    case "status":
      return <span className="text-emerald-500">{reply.text}</span>;
    case "error":
      return <span className="text-destructive">(error) {reply.text}</span>;
    case "str":
      return (
        <span className={cn(reply.binary && "text-sky-400")}>
          {reply.text}
          {reply.binary && <span className="ml-1 text-[10px] text-muted-foreground">hex</span>}
        </span>
      );
    case "array":
      if (reply.items.length === 0) return <span className="text-muted-foreground">(empty)</span>;
      return (
        <div className="space-y-0.5">
          {reply.items.map((it, i) => (
            <div key={i} className="flex gap-2" style={{ paddingLeft: depth * 12 }}>
              <span className="text-muted-foreground">{i + 1})</span>
              <ReplyView reply={it} depth={depth + 1} />
            </div>
          ))}
        </div>
      );
    case "map":
      return (
        <div className="space-y-0.5">
          {reply.items.map(([k, v], i) => (
            <div key={i} className="flex gap-2" style={{ paddingLeft: depth * 12 }}>
              <ReplyView reply={k} depth={depth + 1} />
              <span className="text-muted-foreground">=&gt;</span>
              <ReplyView reply={v} depth={depth + 1} />
            </div>
          ))}
        </div>
      );
    default:
      return <span className="text-muted-foreground">?</span>;
  }
}
