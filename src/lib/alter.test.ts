import { describe, it, expect } from "vitest";
import { buildAlterStatements, type ColEdit } from "./alter";
import type { TableRef } from "@/ipc/types";

const col = (p: Partial<ColEdit> & { name: string; origName: string | null }): ColEdit => ({
  type: "INT",
  length: "",
  notNull: false,
  def: "",
  ...p,
});

const mysqlTable: TableRef = { database: "app", schema: null, name: "users" };
const pgTable: TableRef = { database: null, schema: "public", name: "users" };
const sqliteTable: TableRef = { database: null, schema: null, name: "users" };

describe("buildAlterStatements", () => {
  it("无变更时不产出语句", () => {
    const c = col({ name: "id", origName: "id" });
    expect(buildAlterStatements("mysql", "`", mysqlTable, [c], [c])).toEqual([]);
  });

  it("新增列（三库 ADD COLUMN）", () => {
    const orig = [col({ name: "id", origName: "id" })];
    const next = [
      orig[0],
      col({ name: "age", origName: null, type: "INT", notNull: true, def: "0" }),
    ];
    expect(buildAlterStatements("mysql", "`", mysqlTable, orig, next)).toEqual([
      "ALTER TABLE `app`.`users` ADD COLUMN `age` INT NOT NULL DEFAULT 0;",
    ]);
  });

  it("删除列", () => {
    const orig = [col({ name: "id", origName: "id" }), col({ name: "tmp", origName: "tmp" })];
    const next = [orig[0]];
    expect(buildAlterStatements("postgres", '"', pgTable, orig, next)).toEqual([
      'ALTER TABLE "public"."users" DROP COLUMN "tmp";',
    ]);
  });

  it("MySQL 改名用 CHANGE 合并重定义", () => {
    const orig = [col({ name: "name", origName: "name", type: "VARCHAR", length: "50" })];
    const next = [col({ name: "full_name", origName: "name", type: "VARCHAR", length: "100", notNull: true })];
    expect(buildAlterStatements("mysql", "`", mysqlTable, orig, next)).toEqual([
      "ALTER TABLE `app`.`users` CHANGE COLUMN `name` `full_name` VARCHAR(100) NOT NULL;",
    ]);
  });

  it("MySQL 仅改类型用 MODIFY", () => {
    const orig = [col({ name: "age", origName: "age", type: "INT" })];
    const next = [col({ name: "age", origName: "age", type: "BIGINT" })];
    expect(buildAlterStatements("mysql", "`", mysqlTable, orig, next)).toEqual([
      "ALTER TABLE `app`.`users` MODIFY COLUMN `age` BIGINT;",
    ]);
  });

  it("PG 改名 + 改类型 + 非空 + 默认拆成独立语句（改名后用新名）", () => {
    const orig = [col({ name: "name", origName: "name", type: "text", notNull: false, def: "" })];
    const next = [
      col({ name: "title", origName: "name", type: "varchar", length: "200", notNull: true, def: "'x'" }),
    ];
    expect(buildAlterStatements("postgres", '"', pgTable, orig, next)).toEqual([
      'ALTER TABLE "public"."users" RENAME COLUMN "name" TO "title";',
      'ALTER TABLE "public"."users" ALTER COLUMN "title" TYPE varchar(200);',
      'ALTER TABLE "public"."users" ALTER COLUMN "title" SET NOT NULL;',
      `ALTER TABLE "public"."users" ALTER COLUMN "title" SET DEFAULT 'x';`,
    ]);
  });

  it("PG 去掉非空与默认", () => {
    const orig = [col({ name: "n", origName: "n", type: "int", notNull: true, def: "0" })];
    const next = [col({ name: "n", origName: "n", type: "int", notNull: false, def: "" })];
    expect(buildAlterStatements("postgres", '"', pgTable, orig, next)).toEqual([
      'ALTER TABLE "public"."users" ALTER COLUMN "n" DROP NOT NULL;',
      'ALTER TABLE "public"."users" ALTER COLUMN "n" DROP DEFAULT;',
    ]);
  });

  it("SQLite 只产出 add / rename / drop，忽略类型与约束变更", () => {
    const orig = [
      col({ name: "id", origName: "id", type: "INTEGER" }),
      col({ name: "old", origName: "old", type: "TEXT" }),
      col({ name: "gone", origName: "gone", type: "TEXT" }),
    ];
    const next = [
      orig[0],
      // 改名 + 试图改类型（类型变更应被忽略）
      col({ name: "renamed", origName: "old", type: "INTEGER" }),
      // 新增列
      col({ name: "extra", origName: null, type: "TEXT" }),
    ];
    expect(buildAlterStatements("sqlite", '"', sqliteTable, orig, next)).toEqual([
      'ALTER TABLE "users" DROP COLUMN "gone";',
      'ALTER TABLE "users" RENAME COLUMN "old" TO "renamed";',
      'ALTER TABLE "users" ADD COLUMN "extra" TEXT;',
    ]);
  });
});
