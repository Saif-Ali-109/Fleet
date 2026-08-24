import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import {
  ToolInputError,
  asOptionalNumber,
  asRecord,
  asString,
  resolveExistingInside,
  resolveInside,
  type ToolImpl,
  type ToolResult,
} from "./common.ts";

export const READ_LINE_CAP = 2000;

function fail(err: unknown): ToolResult {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

function inputError(err: unknown): boolean {
  return err instanceof ToolInputError;
}

export const readTool: ToolImpl = {
  schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "file path inside the worktree" },
      offset: { type: "number", description: "1-based start line (default 1)" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async exec(input, ctx): Promise<ToolResult> {
    let path: string;
    let offset: number | undefined;
    try {
      const record = asRecord(input);
      path = asString(record, "path");
      offset = asOptionalNumber(record, "offset");
    } catch (err) {
      if (!inputError(err)) throw err;
      return fail(err);
    }
    try {
      const file = resolveExistingInside(ctx.worktreeDir, path);
      const lines = readFileSync(file, "utf8").split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      const start = Math.max(1, Math.floor(offset ?? 1));
      const sliced = lines.slice(start - 1, start - 1 + READ_LINE_CAP);
      const numbered = sliced.map((line, i) => `${start + i}: ${line}`);
      const truncated = lines.length > start - 1 + READ_LINE_CAP;
      return {
        ok: true,
        content:
          numbered.join("\n") + (truncated ? "\n[truncated at 2000 lines]" : ""),
      };
    } catch (err) {
      if (!inputError(err)) return fail(err);
      throw err;
    }
  },
};

export const writeTool: ToolImpl = {
  schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "file path inside the worktree" },
      content: { type: "string", description: "full file content to write" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  async exec(input, ctx): Promise<ToolResult> {
    let path: string;
    let content: string;
    try {
      const record = asRecord(input);
      path = asString(record, "path");
      content = asString(record, "content");
    } catch (err) {
      if (!inputError(err)) throw err;
      return fail(err);
    }
    try {
      const file = resolveInside(ctx.worktreeDir, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content, "utf8");
      return {
        ok: true,
        content: `wrote ${Buffer.byteLength(content)} bytes to ${relative(ctx.worktreeDir, file) || file}`,
      };
    } catch (err) {
      if (!inputError(err)) return fail(err);
      throw err;
    }
  },
};

export const editTool: ToolImpl = {
  schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "file path inside the worktree" },
      old_string: { type: "string", description: "exact text to replace" },
      new_string: { type: "string", description: "replacement text" },
    },
    required: ["path", "old_string", "new_string"],
    additionalProperties: false,
  },
  async exec(input, ctx): Promise<ToolResult> {
    let path: string;
    let oldString: string;
    let newString: string;
    try {
      const record = asRecord(input);
      path = asString(record, "path");
      oldString = asString(record, "old_string");
      newString = asString(record, "new_string");
    } catch (err) {
      if (!inputError(err)) throw err;
      return fail(err);
    }
    try {
      const file = resolveExistingInside(ctx.worktreeDir, path);
      const text = readFileSync(file, "utf8");
      const matches = oldString ? text.split(oldString).length - 1 : 0;
      if (matches === 0) {
        return {
          ok: false,
          error: `edit failed: old_string not found in ${path}`,
        };
      }
      if (matches > 1) {
        return {
          ok: false,
          error: `edit failed: old_string matches ${matches} times in ${path}; make it unique`,
        };
      }
      const idx = text.indexOf(oldString);
      const updated =
        text.slice(0, idx) + newString + text.slice(idx + oldString.length);
      writeFileSync(file, updated, "utf8");
      return { ok: true, content: `edited ${path}` };
    } catch (err) {
      if (!inputError(err)) return fail(err);
      throw err;
    }
  },
};
