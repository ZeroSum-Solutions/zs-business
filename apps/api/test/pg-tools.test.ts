import { describe, expect, it } from "vitest";
import { resolvePgTool } from "../src/pg-tools.js";

const layout = (dirs: Record<string, string[]>, files: string[], pathMajor: number | null = null) => ({
  pathMajor: () => pathMajor,
  listDir: (path: string) => dirs[path] ?? [],
  fileExists: (path: string) => files.includes(path),
});

describe("resolvePgTool", () => {
  it("prefers the newest versioned install over PATH, so a v16 PATH cannot dump a v17 server", () => {
    const options = layout({ "/opt/homebrew/opt": ["postgresql@16", "postgresql@17", "postgresql", "openssl@3"] },
      ["/opt/homebrew/opt/postgresql@16/bin/pg_dump", "/opt/homebrew/opt/postgresql@17/bin/pg_dump"]);
    expect(resolvePgTool("pg_dump", options)).toBe("/opt/homebrew/opt/postgresql@17/bin/pg_dump");
  });
  it("orders majors numerically and covers Debian's layout", () => {
    const options = layout({ "/usr/lib/postgresql": ["9", "17", "100"] },
      ["/usr/lib/postgresql/9/bin/pg_restore", "/usr/lib/postgresql/17/bin/pg_restore"]);
    expect(resolvePgTool("pg_restore", options)).toBe("/usr/lib/postgresql/17/bin/pg_restore");
  });
  it("lets a newer PATH copy win over every versioned install, and a versioned install win a tie", () => {
    const dirs = { "/opt/homebrew/opt": ["postgresql@17"] };
    const files = ["/opt/homebrew/opt/postgresql@17/bin/pg_dump"];
    expect(resolvePgTool("pg_dump", layout(dirs, files, 18))).toBe("pg_dump");
    expect(resolvePgTool("pg_dump", layout(dirs, files, 17))).toBe("/opt/homebrew/opt/postgresql@17/bin/pg_dump");
    expect(resolvePgTool("pg_dump", layout(dirs, files, 16))).toBe("/opt/homebrew/opt/postgresql@17/bin/pg_dump");
  });
  it("lets an explicit path win, and falls back to PATH when nothing versioned is installed", () => {
    expect(resolvePgTool("pg_dump", { explicit: "/x/pg_dump", ...layout({}, []) })).toBe("/x/pg_dump");
    expect(resolvePgTool("pg_dump", layout({ "/opt/homebrew/opt": ["postgresql@17"] }, []))).toBe("pg_dump");
  });
});
