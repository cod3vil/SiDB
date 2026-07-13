import { describe, it, expect } from "vitest";
import { renderValue, parseValue, editText } from "./value";

describe("renderValue", () => {
  it("marks NULL distinctly", () => {
    const r = renderValue({ t: "Null" });
    expect(r.isNull).toBe(true);
    expect(r.text).toBe("NULL");
  });

  it("renders bytes as blob summary", () => {
    const r = renderValue({ t: "Bytes", v: { len: 12, preview_hex: "00ff" } });
    expect(r.isBytes).toBe(true);
    expect(r.text).toContain("12 bytes");
  });

  it("stringifies json", () => {
    const r = renderValue({ t: "Json", v: { a: 1 } });
    expect(r.isJson).toBe(true);
    expect(r.text).toBe('{"a":1}');
  });

  it("renders empty text distinct from null", () => {
    const r = renderValue({ t: "Text", v: "" });
    expect(r.isNull).toBe(false);
    expect(r.text).toBe("");
  });
});

describe("parseValue", () => {
  it("parses int by column kind", () => {
    expect(parseValue("42", "Int")).toEqual({ t: "Int", v: 42 });
  });
  it("falls back to text", () => {
    expect(parseValue("hi", "Text")).toEqual({ t: "Text", v: "hi" });
  });
  it("emits temporal variants so PG binds the right type (not text)", () => {
    expect(parseValue("2026-06-18 14:08:04", "DateTime")).toEqual({
      t: "DateTime",
      v: "2026-06-18 14:08:04",
    });
    expect(parseValue("2026-06-18", "Date")).toEqual({ t: "Date", v: "2026-06-18" });
    expect(parseValue("14:08:04", "Time")).toEqual({ t: "Time", v: "14:08:04" });
  });
  it("parses bool case-insensitively (True/T/yes → true)", () => {
    for (const s of ["true", "True", "TRUE", "1", "t", "yes", "y", "on", " true "]) {
      expect(parseValue(s, "Bool")).toEqual({ t: "Bool", v: true });
    }
    for (const s of ["false", "False", "0", "f", "no", ""]) {
      expect(parseValue(s, "Bool")).toEqual({ t: "Bool", v: false });
    }
  });
});

describe("editText", () => {
  it("bool edits round-trip through parseValue (shows true/false, not 1/0)", () => {
    expect(editText({ t: "Bool", v: true })).toBe("true");
    expect(editText({ t: "Bool", v: false })).toBe("false");
    expect(parseValue(editText({ t: "Bool", v: true }), "Bool")).toEqual({ t: "Bool", v: true });
  });
});
