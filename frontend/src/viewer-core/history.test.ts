import { describe, expect, it } from "vitest";
import { History, type Command } from "./history";

function cmd(log: string[], name: string, fail = false): Command {
  return {
    label: name,
    undo: async () => {
      if (fail) throw new Error("boom");
      log.push(`undo ${name}`);
    },
    redo: async () => {
      log.push(`redo ${name}`);
    },
  };
}

describe("History", () => {
  it("undoes and redoes in order and a new edit ends the redo chain", async () => {
    const log: string[] = [];
    const h = new History();
    h.push(cmd(log, "a"));
    h.push(cmd(log, "b"));
    await h.undo();
    await h.undo();
    expect(log).toEqual(["undo b", "undo a"]);
    expect(h.canUndo).toBe(false);
    expect(h.redoLabel).toBe("a");
    await h.redo();
    expect(log.at(-1)).toBe("redo a");
    h.push(cmd(log, "c"));
    expect(h.canRedo).toBe(false);
    expect(h.undoLabel).toBe("c");
  });
  it("runs overlapping requests one after the other", async () => {
    const log: string[] = [];
    const h = new History();
    h.push(cmd(log, "a"));
    h.push(cmd(log, "b"));
    await Promise.all([h.undo(), h.undo(), h.undo()]); // the third has nothing to do
    expect(log).toEqual(["undo b", "undo a"]);
  });
  it("a failing undo keeps the command and reports the error", async () => {
    const h = new History();
    h.push(cmd([], "x", true));
    await expect(h.undo()).rejects.toThrow("boom");
    expect(h.canUndo).toBe(true);
    expect(h.canRedo).toBe(false);
  });
  it("is bounded", () => {
    const h = new History(2);
    for (const n of "abc") h.push(cmd([], n));
    expect(h.undoLabel).toBe("c");
    expect([h.canUndo]).toEqual([true]);
  });

  it("a group of edits is one undo step that undoes in reverse and redoes in order", async () => {
    const h = new History();
    const log: string[] = [];
    const cmd = (n: string) => ({ label: n, undo: async () => void log.push(`undo ${n}`), redo: async () => void log.push(`redo ${n}`) });
    await h.group("three", async () => {
      h.push(cmd("a"));
      h.push(cmd("b"));
      h.push(cmd("c"));
    });
    expect(h.undoLabel).toBe("three");
    await h.undo();
    expect(log).toEqual(["undo c", "undo b", "undo a"]);
    expect(h.canUndo).toBe(false);
    await h.redo();
    expect(log.slice(3)).toEqual(["redo a", "redo b", "redo c"]);
  });

  it("an empty group leaves no step", async () => {
    const h = new History();
    await h.group("nothing", async () => undefined);
    expect(h.canUndo).toBe(false);
  });
});
