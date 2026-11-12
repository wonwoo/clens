import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import { applySchema } from "../src/indexer/schema.js";
import { formatStats, projectStats } from "../src/mcp/stats.js";
import { analyzeToolOutput } from "../src/analyzer/tool_output.js";
import { UTC_TIME, withTz } from "./tz.js";

function openMem(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function seed(db: Database.Database): void {
  db.exec(`
    INSERT INTO project (id, cwd) VALUES ('proj-a', '/a'), ('proj-b', '/b');
    INSERT INTO session (id, project_id, started_at) VALUES
      ('s1', 'proj-a', '2026-06-01T10:00:00Z'),
      ('s2', 'proj-a', '2026-06-15T10:00:00Z'),
      ('s3', 'proj-b', '2026-06-20T10:00:00Z');
    INSERT INTO event (uuid, session_id, ts, role, model) VALUES
      ('e1', 's1', '2026-06-01T10:00:00Z', 'user', NULL),
      ('e2', 's1', '2026-06-01T10:05:00Z', 'assistant', 'claude-sonnet-5'),
      ('e3', 's2', '2026-06-15T10:05:00Z', 'assistant', 'claude-sonnet-5'),
      ('e4', 's3', '2026-06-20T10:05:00Z', 'assistant', 'gpt-5');
    INSERT INTO tool_call (event_uuid, session_id, ts, name, is_error) VALUES
      ('e2', 's1', '2026-06-01T10:05:00Z', 'Edit', 0),
      ('e2', 's1', '2026-06-01T10:05:01Z', 'Bash', 1),
      ('e3', 's2', '2026-06-15T10:05:00Z', 'Read', 0),
      ('e4', 's3', '2026-06-20T10:05:00Z', 'Write', 0);
    INSERT INTO file_op (event_uuid, session_id, ts, tool, path) VALUES
      ('e2', 's1', '2026-06-01T10:05:00Z', 'Edit', 'src/a.ts'),
      ('e3', 's2', '2026-06-15T10:05:00Z', 'Read', 'src/b.ts'),
      ('e4', 's3', '2026-06-20T10:05:00Z', 'Write', 'other.ts');
    INSERT INTO skill_call (event_uuid, session_id, ts, skill) VALUES
      ('e2', 's1', '2026-06-01T10:05:00Z', 'code-review');
    INSERT INTO agent_call (event_uuid, session_id, ts, subagent_type) VALUES
      ('e2', 's1', '2026-06-01T10:05:00Z', 'code-reviewer');
  `);
}

describe("mcp/stats.ts — projectStats", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMem();
    seed(db);
  });

  it("aggregates tool/skill/agent/file stats scoped to a project, excluding other projects", () => {
    const stats = projectStats(db, { project_id: "proj-a" });

    expect(stats.sessions).toBe(2);
    expect(stats.tool_counts).toEqual({ Edit: 1, Bash: 1, Read: 1 });
    expect(stats.tool_counts.Write).toBeUndefined();
    expect(stats.tool_errors).toBe(1);
    expect(stats.tool_errors_by_name).toEqual({ Bash: 1 });
    const tools = formatStats(stats).split("\n");
    expect(tools).toContain("  Bash: 1 (1 failed)");
    expect(tools).toContain("  Edit: 1");

    expect(stats.skills).toEqual([{ name: "code-review", source: "claude", count: 1 }]);
    expect(stats.agents).toEqual([{ type: "code-reviewer", count: 1 }]);

    const paths = stats.files.map((f) => f.path);
    expect(paths).toContain("src/a.ts");
    expect(paths).toContain("src/b.ts");
    expect(paths).not.toContain("other.ts");
  });

  it("since narrows every dimension — sessions, tools, files, skills, agents, health — to events at or after the bound", () => {
    const stats = projectStats(db, { project_id: "proj-a", since: "2026-06-10T00:00:00Z" });

    // Only s2's event (2026-06-15) is at/after the bound; s1 (2026-06-01) drops out.
    expect(stats.sessions).toBe(1);
    expect(stats.tool_counts).toEqual({ Read: 1 });
    expect(stats.tool_errors).toBe(0); // s1's Bash error is before the bound
    expect(stats.files.map((f) => f.path)).toEqual(["src/b.ts"]);
    expect(stats.skills).toEqual([]); // s1's only skill_call is before the bound
    expect(stats.agents).toEqual([]); // s1's only agent_call is before the bound
  });

  it("a since bound after all activity returns zeroed facts, not stale totals", () => {
    const stats = projectStats(db, { project_id: "proj-a", since: "2099-01-01T00:00:00Z" });

    expect(stats.sessions).toBe(0);
    expect(stats.tool_counts).toEqual({});
    expect(stats.files).toEqual([]);
  });

  it("returns zeroed facts for a project with no data, not an error", () => {
    const stats = projectStats(db, { project_id: "proj-nonexistent" });

    expect(stats.sessions).toBe(0);
    expect(stats.tool_counts).toEqual({});
    expect(stats.files).toEqual([]);
    expect(stats.skills).toEqual([]);
    expect(stats.agents).toEqual([]);
  });

  it("session_id scopes every dimension to that single session and reports the session's actual project_id, regardless of what was passed", () => {
    // s1 actually belongs to proj-a; passing proj-b here must not leak into the result
    // or affect filtering — session mode scopes purely by session_id.
    const stats = projectStats(db, { project_id: "proj-b", session_id: "s1" });

    expect(stats.project_id).toBe("proj-a");
    expect(stats.sessions).toBe(1);
    expect(stats.tool_counts).toEqual({ Edit: 1, Bash: 1 });
    expect(stats.tool_counts.Read).toBeUndefined();
    expect(stats.tool_errors).toBe(1);
    expect(stats.skills).toEqual([{ name: "code-review", source: "claude", count: 1 }]);
    expect(stats.agents).toEqual([{ type: "code-reviewer", count: 1 }]);
    expect(stats.files.map((f) => f.path)).toEqual(["src/a.ts"]);
  });

  it("since is ignored once session_id is set — a since bound that would exclude everything still returns the session's data", () => {
    const stats = projectStats(db, { project_id: "proj-a", session_id: "s1", since: "2099-01-01T00:00:00Z" });

    expect(stats.sessions).toBe(1);
    expect(stats.tool_counts).toEqual({ Edit: 1, Bash: 1 });
  });

  it("a nonexistent session_id returns zeroed facts, not an error", () => {
    const stats = projectStats(db, { project_id: "proj-a", session_id: "s-nonexistent" });

    expect(stats.sessions).toBe(0);
    expect(stats.tool_counts).toEqual({});
    expect(stats.files).toEqual([]);
    expect(stats.skills).toEqual([]);
    expect(stats.agents).toEqual([]);
  });
});

function seedKinds(db: Database.Database): void {
  db.exec(`
    INSERT INTO project (id, cwd) VALUES ('proj-k', '/k'), ('proj-m', '/m');
    INSERT INTO session (id, project_id, kind, started_at) VALUES
      ('ki', 'proj-k', 'interactive', '2026-06-01T10:00:00Z'),
      ('ke', 'proj-k', 'exec', '2026-06-02T10:00:00Z'),
      ('kp', 'proj-k', 'pipeline', '2026-06-03T10:00:00Z'),
      ('mi', 'proj-m', 'interactive', '2026-06-20T10:00:00Z');
    INSERT INTO event (uuid, session_id, ts, role, model) VALUES
      ('k1', 'ki', '2026-06-01T10:05:00Z', 'assistant', 'claude-sonnet-5'),
      ('k2', 'ke', '2026-06-02T10:05:00Z', 'assistant', 'claude-sonnet-5'),
      ('k3', 'kp', '2026-06-03T10:05:00Z', 'assistant', 'claude-sonnet-5'),
      ('m1', 'mi', '2026-06-20T10:05:00Z', 'assistant', 'claude-sonnet-5');
    INSERT INTO tool_call (event_uuid, session_id, ts, name, is_error) VALUES
      ('k1', 'ki', '2026-06-01T10:05:00Z', 'Edit', 0),
      ('k2', 'ke', '2026-06-02T10:05:00Z', 'Bash', 0),
      ('k3', 'kp', '2026-06-03T10:05:00Z', 'Read', 0),
      ('m1', 'mi', '2026-06-20T10:05:00Z', 'Write', 0);
  `);
}

describe("mcp/stats.ts — scopes, session kinds and sections", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMem();
    seedKinds(db);
  });

  it("all-project stats sum every work session across projects and leave out exec and pipeline", () => {
    const stats = projectStats(db, {});
    expect(stats.scope).toBe("all");
    expect(stats.sessions).toBe(2);
    expect(stats.tool_counts).toEqual({ Edit: 1, Write: 1 });
  });

  it("project stats leave out exec and pipeline sessions", () => {
    const stats = projectStats(db, { project_id: "proj-k" });
    expect(stats.scope).toBe("project");
    expect(stats.sessions).toBe(1);
    expect(stats.tool_counts).toEqual({ Edit: 1 });
  });

  it("an explicit session_id of an exec session still returns its tool call", () => {
    const stats = projectStats(db, { session_id: "ke" });
    expect(stats.tool_counts).toEqual({ Bash: 1 });
  });

  it("since without project_id gives the since scope across projects", () => {
    const stats = projectStats(db, { since: "2026-06-10T00:00:00Z" });
    expect(stats.scope).toBe("all");
    expect(stats.sessions).toBe(1);
    expect(stats.tool_counts).toEqual({ Write: 1 });
  });

  it("sections limits the facts and the formatted text", () => {
    const stats = projectStats(db, { project_id: "proj-k", sections: ["tools"] });
    expect(stats.tool_counts).toEqual({ Edit: 1 });
    expect(stats.skills).toBeUndefined();
    expect(stats.agents).toBeUndefined();
    expect(stats.health).toBeUndefined();
    expect(stats.timeline).toBeUndefined();
    expect(stats.files).toBeUndefined();
    const text = formatStats(stats);
    expect(text).toContain("Tool usage:");
    expect(text).not.toContain("Files touched");
  });

  it("project and all-project stats also leave out the subagents of exec and pipeline sessions, and theirs", () => {
    db.exec(`
      INSERT INTO session (id, project_id, kind, parent_id, started_at) VALUES
        ('agent-x', 'proj-k', 'subagent', 'ke', '2026-06-02T10:06:00Z'),
        ('agent-y', 'proj-k', 'subagent', 'kp', '2026-06-03T10:06:00Z'),
        ('agent-x2', 'proj-k', 'subagent', 'agent-x', '2026-06-02T10:07:00Z');
      INSERT INTO event (uuid, session_id, ts, role) VALUES
        ('x1', 'agent-x', '2026-06-02T10:06:00Z', 'assistant'),
        ('y1', 'agent-y', '2026-06-03T10:06:00Z', 'assistant'),
        ('x2', 'agent-x2', '2026-06-02T10:07:00Z', 'assistant');
      INSERT INTO tool_call (event_uuid, session_id, ts, name, is_error) VALUES
        ('x1', 'agent-x', '2026-06-02T10:06:00Z', 'Grep', 0),
        ('y1', 'agent-y', '2026-06-03T10:06:00Z', 'Glob', 0),
        ('x2', 'agent-x2', '2026-06-02T10:07:00Z', 'Read', 0);
    `);
    const all = projectStats(db, {});
    expect(all.sessions).toBe(2);
    expect(all.tool_counts).toEqual({ Edit: 1, Write: 1 });
    const project = projectStats(db, { project_id: "proj-k" });
    expect(project.sessions).toBe(1);
    expect(project.tool_counts).toEqual({ Edit: 1 });
  });

  it("the scope line is followed by the left-out note in project and all-project scope only", () => {
    expect(formatStats(projectStats(db, {})).split("\n")[1]).toBe("Leaves out one-shot exec/SDK runs and clens judge (pipeline) sessions.");
    expect(formatStats(projectStats(db, { project_id: "proj-k" })).split("\n")[1]).toBe("Leaves out one-shot exec/SDK runs and clens judge (pipeline) sessions.");
    expect(formatStats(projectStats(db, { session_id: "ki" }))).not.toContain("Leaves out");
  });

  it("each scope has its own no-data message", () => {
    expect(formatStats(projectStats(db, { session_id: "nope" }))).toBe("No data found for session nope. Check the session_id.");
    expect(formatStats(projectStats(db, { since: "2099-01-01T00:00:00Z" }))).toBe(
      "No data found in any project (one-shot exec/SDK runs and clens judge sessions are left out). Widen or remove the since filter.",
    );
    expect(formatStats(projectStats(db, { project_id: "proj-none" }))).toBe(
      "No data found for project proj-none (one-shot exec/SDK runs and clens judge sessions are left out). Check the project_id/session_id derivation or widen/remove the since filter.",
    );
  });

  it("a parent session's stats leave out its subagent session's tool calls", () => {
    db.exec(`
      INSERT INTO session (id, project_id, kind, parent_id, started_at) VALUES
        ('agent-a1', 'proj-k', 'subagent', 'ki', '2026-06-01T10:06:00Z');
      INSERT INTO event (uuid, session_id, ts, role) VALUES ('a1', 'agent-a1', '2026-06-01T10:06:00Z', 'assistant');
      INSERT INTO tool_call (event_uuid, session_id, ts, name, is_error) VALUES ('a1', 'agent-a1', '2026-06-01T10:06:00Z', 'Grep', 0);
    `);
    const stats = projectStats(db, { session_id: "ki" });
    expect(stats.tool_counts).toEqual({ Edit: 1 });
  });

  it("project and all-project stats count a subagent as part of the session that started it", () => {
    db.exec(`
      INSERT INTO session (id, project_id, kind, parent_id, started_at) VALUES
        ('agent-a1', 'proj-k', 'subagent', 'ki', '2026-06-01T10:06:00Z'),
        ('agent-o1', 'proj-k', 'subagent', 'gone', '2026-06-01T11:00:00Z'),
        ('agent-o2', 'proj-k', 'subagent', 'gone', '2026-06-01T11:10:00Z'),
        ('agent-a2', 'proj-k', 'subagent', 'agent-a1', '2026-06-01T10:07:00Z'),
        ('agent-o3', 'proj-k', 'subagent', 'agent-o1', '2026-06-01T11:20:00Z');
      INSERT INTO event (uuid, session_id, ts, role) VALUES
        ('a1', 'agent-a1', '2026-06-01T10:06:00Z', 'assistant'),
        ('o1', 'agent-o1', '2026-06-01T11:00:00Z', 'assistant'),
        ('o2', 'agent-o2', '2026-06-01T11:10:00Z', 'assistant'),
        ('a2', 'agent-a2', '2026-06-01T10:07:00Z', 'assistant'),
        ('o3', 'agent-o3', '2026-06-01T11:20:00Z', 'assistant');
    `);
    // ki with agent-a1 and the subagent agent-a1 started, and the subagents
    // of the unindexed session "gone", one started by another.
    expect(projectStats(db, { project_id: "proj-k" }).sessions).toBe(2);
    expect(projectStats(db, { project_id: "proj-k", since: "2026-06-01T10:30:00Z" }).sessions).toBe(1);
    expect(projectStats(db, {}).sessions).toBe(3);
    expect(projectStats(db, { since: "2026-06-01T10:30:00Z" }).sessions).toBe(2);
  });

  it("the timeline counts a subagent's time once, within the session that started it", () => {
    db.exec(`
      INSERT INTO project (id, cwd) VALUES ('proj-t', '/t');
      INSERT INTO session (id, project_id, kind, parent_id, started_at) VALUES
        ('tp', 'proj-t', 'interactive', NULL, '2026-07-01T00:00:00Z'),
        ('agent-t1', 'proj-t', 'subagent', 'tp', '2026-07-01T00:01:00Z'),
        ('agent-t2', 'proj-t', 'subagent', 'agent-t1', '2026-07-01T00:02:00Z');
      INSERT INTO event (uuid, session_id, ts, role) VALUES
        ('t1', 'tp', '2026-07-01T00:00:00Z', 'assistant'),
        ('t2', 'tp', '2026-07-01T00:10:00Z', 'assistant'),
        ('t3', 'agent-t1', '2026-07-01T00:01:00Z', 'assistant'),
        ('t4', 'agent-t1', '2026-07-01T00:05:00Z', 'assistant'),
        ('t5', 'agent-t1', '2026-07-01T00:09:00Z', 'assistant'),
        ('t6', 'agent-t2', '2026-07-01T00:02:00Z', 'assistant'),
        ('t7', 'agent-t2', '2026-07-01T00:08:00Z', 'assistant');
    `);
    // The parent waits 10 minutes on the subagent, which works throughout,
    // part of it waiting on a subagent of its own.
    const project = projectStats(db, { project_id: "proj-t" }).timeline;
    expect(project).toEqual({ active_min: 10, think_min: 10, idle_min: 0 });
    expect(formatStats(projectStats(db, { project_id: "proj-t" })).split("\n")).toContain("Timeline: active 10min (think 10min), idle 0min");
    // One session's stats leave out its subagents.
    expect(projectStats(db, { session_id: "tp" }).timeline).toEqual({ active_min: 0, think_min: 0, idle_min: 10 });
  });
});

describe("mcp/stats.ts — formatStats scope lines and list caps", () => {
  it("prints the scope line for all projects, one project and one session", () => {
    const db = openMem();
    seed(db);
    expect(formatStats(projectStats(db, {})).split("\n")[0]).toBe("Scope: all projects");
    expect(formatStats(projectStats(db, { project_id: "proj-a" })).split("\n")[0]).toBe("Scope: project proj-a");
    expect(formatStats(projectStats(db, { session_id: "s1" })).split("\n")[0]).toBe("Scope: session s1 in project proj-a");
  });

  function seedLists(db: Database.Database, paths: number, tools: number, skills = 0): void {
    db.exec(`
      INSERT INTO project (id, cwd) VALUES ('proj-c', '/c');
      INSERT INTO session (id, project_id, kind, started_at) VALUES ('c1', 'proj-c', 'interactive', '2026-06-01T10:00:00Z');
      INSERT INTO event (uuid, session_id, ts, role) VALUES ('c-e', 'c1', '2026-06-01T10:00:00Z', 'assistant');
    `);
    const op = db.prepare("INSERT INTO file_op (event_uuid, session_id, ts, tool, path) VALUES ('c-e', 'c1', '2026-06-01T10:00:00Z', 'Edit', ?)");
    for (let i = 0; i < paths; i++) op.run(`src/f${String(i).padStart(2, "0")}.ts`);
    const call = db.prepare("INSERT INTO tool_call (event_uuid, session_id, ts, name, is_error) VALUES ('c-e', 'c1', '2026-06-01T10:00:00Z', ?, 0)");
    for (let i = 0; i < tools; i++) call.run(`tool${String(i).padStart(2, "0")}`);
    const skill = db.prepare("INSERT INTO skill_call (event_uuid, session_id, ts, skill) VALUES ('c-e', 'c1', '2026-06-01T10:00:00Z', ?)");
    const slash = db.prepare("INSERT INTO slash_command (event_uuid, session_id, ts, name) VALUES ('c-e', 'c1', '2026-06-01T10:00:00Z', ?)");
    // Inserted in reverse name order, so only a name tie-break puts them back in order.
    for (let i = skills - 1; i >= 0; i--) {
      skill.run(`skill${String(i).padStart(2, "0")}`);
      slash.run(`cmd${String(i).padStart(2, "0")}`);
    }
  }

  function linesUnder(text: string, heading: string): string[] {
    const lines = text.split("\n");
    const start = lines.findIndex((l) => l.startsWith(heading));
    const out: string[] = [];
    for (const l of lines.slice(start + 1)) {
      if (!l.startsWith("  ")) break;
      out.push(l);
    }
    return out;
  }

  it("cuts a 25-path file list to 20 with (+5 more)", () => {
    const db = openMem();
    seedLists(db, 25, 1);
    const text = formatStats(projectStats(db, { project_id: "proj-c" }));
    expect(text).toContain("Files touched (top 20 paths):");
    const files = linesUnder(text, "Files touched");
    expect(files).toHaveLength(21);
    expect(files[20]).toBe("  (+5 more)");
  });

  it("does not add the top-20 note to a file list that was not cut", () => {
    const db = openMem();
    seedLists(db, 3, 1);
    const text = formatStats(projectStats(db, { project_id: "proj-c" }));
    expect(text).toContain("Files touched:");
    expect(text).not.toContain("top 20 paths");
  });

  it("cuts the skill and slash-command lists to 20 each, ties by name, and says which list was cut", () => {
    const db = openMem();
    seedLists(db, 1, 1, 25);
    const lines = linesUnder(formatStats(projectStats(db, { project_id: "proj-c" })), "Skills & slash commands:");
    expect(lines).toHaveLength(42);
    expect(lines[0]).toBe("  skill00 (claude): 1");
    expect(lines[19]).toBe("  skill19 (claude): 1");
    expect(lines[20]).toBe("  (+5 more skills)");
    expect(lines[21]).toBe("  cmd00: 1");
    expect(lines[41]).toBe("  (+5 more slash commands)");
  });

  it("name keeps only the skills, slash commands and agent types whose name holds it, in any case", () => {
    const db = openMem();
    seedLists(db, 1, 1, 25);
    db.exec(`
      INSERT INTO skill_call (event_uuid, session_id, ts, skill) VALUES
        ('c-e', 'c1', '2026-06-01T10:00:00Z', 'ecc:plan'), ('c-e', 'c1', '2026-06-01T10:00:00Z', 'ecc:plan');
      INSERT INTO slash_command (event_uuid, session_id, ts, name) VALUES ('c-e', 'c1', '2026-06-01T10:00:00Z', 'ECC:review');
      INSERT INTO agent_call (event_uuid, session_id, ts, subagent_type) VALUES
        ('c-e', 'c1', '2026-06-01T10:00:00Z', 'ecc:security-reviewer'), ('c-e', 'c1', '2026-06-01T10:00:00Z', 'code-reviewer');
    `);
    const stats = projectStats(db, { project_id: "proj-c", name: "ecc:" });
    expect(stats.skills).toEqual([{ name: "ecc:plan", source: "claude", count: 2 }]);
    expect(stats.slash_commands).toEqual([{ name: "ECC:review", count: 1 }]);
    expect(stats.agents).toEqual([{ type: "ecc:security-reviewer", count: 1 }]);
    expect(stats.tool_counts).toEqual(projectStats(db, { project_id: "proj-c" }).tool_counts);
    expect(formatStats(stats).split("\n")).toContain('Name filter: "ecc:" (skills, slash commands and agents only)');
  });

  it("orders files with equal counts by path", () => {
    const db = openMem();
    seedLists(db, 0, 1);
    const op = db.prepare("INSERT INTO file_op (event_uuid, session_id, ts, tool, path) VALUES ('c-e', 'c1', '2026-06-01T10:00:00Z', 'Edit', ?)");
    for (const path of ["src/c.ts", "src/a.ts", "src/b.ts"]) op.run(path);
    expect(projectStats(db, { project_id: "proj-c" }).files!.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("says the file list stops at the top 50 when the analyzer returned its full 50 rows", () => {
    const db = openMem();
    seedLists(db, 60, 1);
    const files = linesUnder(formatStats(projectStats(db, { project_id: "proj-c" })), "Files touched");
    expect(files).toHaveLength(21);
    expect(files[20]).toBe("  (+30 more of the top 50)");
  });

  it("cuts a 35-tool list to 30 with (+5 more)", () => {
    const db = openMem();
    seedLists(db, 1, 35);
    const tools = linesUnder(formatStats(projectStats(db, { project_id: "proj-c" })), "Tool usage:");
    expect(tools).toHaveLength(31);
    expect(tools[30]).toBe("  (+5 more)");
  });
});

describe("mcp/stats.ts — hook blocks and tool output", () => {
  let db: Database.Database;

  // proj-h holds two work sessions and one exec session; proj-o is another project.
  beforeEach(() => {
    db = openMem();
    db.exec(`
      INSERT INTO project (id, cwd) VALUES ('proj-h', '/h'), ('proj-o', '/o');
      INSERT INTO session (id, project_id, kind, started_at) VALUES
        ('h1', 'proj-h', 'interactive', '2026-06-01T10:00:00Z'),
        ('h2', 'proj-h', 'interactive', '2026-06-02T10:00:00Z'),
        ('hx', 'proj-h', 'exec', '2026-06-03T10:00:00Z'),
        ('o1', 'proj-o', 'interactive', '2026-06-04T10:00:00Z');
      INSERT INTO event (uuid, session_id, ts, role) VALUES
        ('eh1', 'h1', '2026-06-01T10:00:00Z', 'assistant'),
        ('eh2', 'h2', '2026-06-02T10:00:00Z', 'assistant'),
        ('ehx', 'hx', '2026-06-03T10:00:00Z', 'assistant'),
        ('eo1', 'o1', '2026-06-04T10:00:00Z', 'assistant');
      INSERT INTO hook_block (event_uuid, session_id, ts, hook_event, tool, call_id, reason) VALUES
        ('eh1', 'h1', '2026-06-01T10:00:01Z', 'PreToolUse', 'Bash', 'c1', 'oldest'),
        ('eh1', 'h1', '2026-06-01T10:00:02Z', 'PreToolUse', 'Bash', 'c2', '${"x".repeat(200)}' || char(10) || 'more'),
        ('eh1', 'h1', '2026-06-01T10:00:03Z', 'PreToolUse', 'Bash', 'c3', 'first line' || char(10) || 'second line'),
        ('eh2', 'h2', '2026-06-02T10:00:04Z', 'PreToolUse', 'WebFetch', 'c4', 'fetch blocked'),
        ('eh2', 'h2', '2026-06-02T10:00:05Z', 'PreToolUse', 'WebFetch', 'c5', 'fetch blocked again'),
        ('eh2', 'h2', '2026-06-02T10:00:06Z', 'Stop', NULL, NULL, NULL),
        ('ehx', 'hx', '2026-06-03T10:00:07Z', 'Stop', NULL, NULL, 'exec stop'),
        ('eo1', 'o1', '2026-06-04T10:00:08Z', 'PreToolUse', 'Bash', 'co', 'other project');
      INSERT INTO tool_call (event_uuid, session_id, ts, name, is_error, result_chars) VALUES
        ('eh1', 'h1', '2026-06-01T10:00:01Z', 'Bash', 0, 10),
        ('eh1', 'h1', '2026-06-01T10:00:02Z', 'Bash', 1, 20),
        ('eh1', 'h1', '2026-06-01T10:00:03Z', 'Bash', 0, 31),
        ('eh1', 'h1', '2026-06-01T10:00:04Z', 'Read', 0, 7),
        ('eh1', 'h1', '2026-06-01T10:00:05Z', 'Grep', 0, NULL),
        ('eh2', 'h2', '2026-06-02T10:00:01Z', 'Read', 0, 8),
        ('ehx', 'hx', '2026-06-03T10:00:01Z', 'Bash', 0, 1000),
        ('eo1', 'o1', '2026-06-04T10:00:01Z', 'Write', 0, 50);
    `);
  });

  it("groups hook blocks by hook and tool, most first, and lists the five newest", () => {
    const hb = projectStats(db, { project_id: "proj-h" }).hook_blocks!;
    expect(hb.total).toBe(6);
    expect(hb.by_hook).toEqual([
      { hook_event: "PreToolUse", tool: "Bash", count: 3 },
      { hook_event: "PreToolUse", tool: "WebFetch", count: 2 },
      { hook_event: "Stop", tool: null, count: 1 },
    ]);
    expect(hb.recent.map((r) => r.ts)).toEqual([
      "2026-06-02T10:00:06Z", "2026-06-02T10:00:05Z", "2026-06-02T10:00:04Z",
      "2026-06-01T10:00:03Z", "2026-06-01T10:00:02Z",
    ]);
    expect(hb.recent[0]).toEqual({ session_id: "h2", ts: "2026-06-02T10:00:06Z", hook_event: "Stop", tool: null, reason_line: null });
    expect(hb.recent[3]!.reason_line).toBe("first line");
    expect(hb.recent[4]!.reason_line).toBe("x".repeat(150) + "…");
  });

  it("sums measured result sizes per tool, rounds the average, and skips unmeasured calls", () => {
    const to = projectStats(db, { project_id: "proj-h" }).tool_output!;
    expect(to.measured_calls).toBe(5);
    expect(to.total_chars).toBe(76);
    expect(to.by_tool).toEqual([
      { name: "Bash", calls: 3, total_chars: 61, avg_chars: 20, max_chars: 31 },
      { name: "Read", calls: 2, total_chars: 15, avg_chars: 8, max_chars: 8 },
    ]);
  });

  it("leaves an exec session's blocks and output out of project scope, and shows them for that session", () => {
    const project = projectStats(db, { project_id: "proj-h" });
    expect(project.hook_blocks!.recent.some((r) => r.session_id === "hx")).toBe(false);
    expect(project.tool_output!.by_tool.find((t) => t.name === "Bash")!.total_chars).toBe(61);
    const session = projectStats(db, { session_id: "hx" });
    expect(session.hook_blocks!.total).toBe(1);
    expect(session.hook_blocks!.recent[0]!.reason_line).toBe("exec stop");
    expect(session.tool_output!.by_tool).toEqual([
      { name: "Bash", calls: 1, total_chars: 1000, avg_chars: 1000, max_chars: 1000 },
    ]);
  });

  it("covers every project when project_id is left out", () => {
    const all = projectStats(db, {});
    expect(all.hook_blocks!.total).toBe(7);
    expect(all.tool_output!.by_tool.map((t) => t.name)).toEqual(["Bash", "Write", "Read"]);
  });

  it("computes neither section when sections leaves them out", () => {
    const stats = projectStats(db, { project_id: "proj-h", sections: ["tools"] });
    expect(stats.hook_blocks).toBeUndefined();
    expect(stats.tool_output).toBeUndefined();
    const text = formatStats(stats);
    expect(text).not.toContain("Hook blocks");
    expect(text).not.toContain("Tool output");
  });

  it("prints both sections after Files touched, a block without a reason without the trailing part", () => {
    const text = formatStats(projectStats(db, { project_id: "proj-h" }));
    const lines = text.split("\n");
    expect(lines.findIndex((l) => l.startsWith("Files touched"))).toBeLessThan(lines.indexOf("Hook blocks: 6"));
    const hooks = lines.slice(lines.indexOf("Hook blocks: 6"));
    expect(hooks.slice(0, 6)).toEqual([
      "Hook blocks: 6",
      "  PreToolUse Bash: 3",
      "  PreToolUse WebFetch: 2",
      "  Stop: 1",
      "  Recent:",
      "    2026-06-02T10:00:06Z session:h2 Stop",
    ]);
    expect(hooks[6]).toBe("    2026-06-02T10:00:05Z session:h2 PreToolUse WebFetch: fetch blocked again");
    expect(lines).toContain("Tool output (characters of tool results, text only): 5 calls, 76 chars");
    expect(lines).toContain("  Bash: 3 calls, total 61, avg 20, max 31");
    expect(lines).toContain("  Read: 2 calls, total 15, avg 8, max 8");
  });

  it("prints the session span, the context-bloat turn and hook blocks in the server's zone", () => {
    // Four assistant turns with tokens, so the context-bloat detail has a max.
    db.exec(`
      UPDATE event SET in_tok = 100 WHERE uuid = 'eh1';
      UPDATE event SET in_tok = 200 WHERE uuid = 'eh2';
      INSERT INTO event (uuid, session_id, ts, role, in_tok) VALUES
        ('eh3', 'h1', '2026-06-01T10:30:00Z', 'assistant', 300),
        ('eh4', 'h2', '2026-06-02T11:00:00Z', 'assistant', 1000);
    `);
    const out = withTz("Asia/Seoul", () => formatStats(projectStats(db, { project_id: "proj-h" })));
    const lines = out.split("\n");
    expect(lines).toContain("Sessions: 2 (2026-06-01T19:00:00+09:00 to 2026-06-02T20:00:00+09:00)");
    expect(lines).toContain("    max_ctx: 1000 (session:h2 at 2026-06-02T20:00:00+09:00), median_ctx: 300, sample_size: 4");
    expect(lines).toContain("    2026-06-02T19:00:06+09:00 session:h2 Stop");
    expect(out).not.toMatch(UTC_TIME);
  });

  it("prints the empty forms when there is nothing to report", () => {
    const empty = openMem();
    seed(empty);
    const text = formatStats(projectStats(empty, { project_id: "proj-a" }));
    expect(text).toContain("Hook blocks: 0");
    expect(text).not.toContain("Recent:");
    expect(text).toContain("Tool output: (none measured)");
  });

  it("cuts a 17-tool output list to 15 with (+2 more), while the analyzer returns all 17", () => {
    const call = db.prepare("INSERT INTO tool_call (event_uuid, session_id, ts, name, is_error, result_chars) VALUES ('eo1', 'o1', '2026-06-04T10:00:02Z', ?, 0, ?)");
    for (let i = 0; i < 16; i++) call.run(`tool${String(i).padStart(2, "0")}`, 100 - i);
    expect(analyzeToolOutput(db, { mode: "session", params: { session_id: "o1" } }).by_tool).toHaveLength(17);
    const stats = projectStats(db, { session_id: "o1" });
    expect(stats.tool_output!.by_tool).toHaveLength(17);
    const lines = formatStats(stats).split("\n");
    const start = lines.findIndex((l) => l.startsWith("Tool output"));
    const listed: string[] = [];
    for (const l of lines.slice(start + 1)) {
      if (!l.startsWith("  ")) break;
      listed.push(l);
    }
    expect(listed).toHaveLength(16);
    expect(listed[0]).toBe("  tool00: 1 calls, total 100, avg 100, max 100");
    expect(listed[15]).toBe("  (+2 more)");
  });
});

describe("mcp/stats.ts — an index from before hook blocks and tool output", () => {
  it("reports both sections as not indexed yet and every other section as usual", () => {
    // What a v4 index looks like to the read-only server until the new build indexes once.
    const db = openMem();
    seed(db);
    db.exec("DROP TABLE hook_block; ALTER TABLE tool_call DROP COLUMN result_chars;");
    const stats = projectStats(db, { project_id: "proj-a" });
    expect(stats.tool_counts).toEqual({ Edit: 1, Bash: 1, Read: 1 });
    expect(stats.hook_blocks).toBeUndefined();
    expect(stats.tool_output).toBeUndefined();
    expect(stats.not_indexed).toEqual(["hook_blocks", "tool_output"]);
    const lines = formatStats(stats).split("\n");
    expect(lines).toContain("Hook blocks: not indexed yet (the index predates this clens version; run clens index)");
    expect(lines).toContain("Tool output: not indexed yet (the index predates this clens version; run clens index)");
  });
});
