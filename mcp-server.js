#!/usr/bin/env node
/* missions-mcp — MCP server for the Missions app.
 * Zero deps, Node >= 18. Speaks MCP over stdio (newline-delimited JSON-RPC 2.0).
 * Reuses the msn CLI login (~/.config/msn/config.json); every call runs under
 * the logged-in user's Supabase JWT, so RLS applies exactly as in the web app.
 * Configure in Claude Code:  { "command": "node", "args": ["/path/to/mcp-server.js"] }
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const URL_ = "https://impdannmrwfcphkkgyaj.supabase.co";
const ANON = "sb_publishable_2Q-FEPM5qK-flJaqHzE8hg_CvG9I6LM";
const CONF = path.join(os.homedir(), ".config", "msn", "config.json");

const loadConf = () => { try { return JSON.parse(fs.readFileSync(CONF, "utf8")); } catch { return null; } };
const saveConf = (c) => fs.writeFileSync(CONF, JSON.stringify(c, null, 2), { mode: 0o600 });

async function refresh(conf) {
  const r = await fetch(`${URL_}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: conf.refresh_token }) });
  if (!r.ok) return false;
  const j = await r.json(); saveConf({ ...conf, access_token: j.access_token, refresh_token: j.refresh_token }); return true;
}
async function api(pathname, opts = {}, retry = true) {
  const conf = loadConf();
  if (!conf || !conf.access_token) throw new Error("Not logged in. Run `msn login` in a terminal first.");
  const r = await fetch(URL_ + pathname, { ...opts, headers: {
    apikey: ANON, Authorization: `Bearer ${conf.access_token}`, "Content-Type": "application/json",
    Prefer: opts.method === "POST" || opts.method === "PATCH" ? "return=representation" : undefined, ...(opts.headers || {}) } });
  if (r.status === 401 && retry && conf.refresh_token) { if (await refresh(conf)) return api(pathname, opts, false); throw new Error("Session expired — run `msn login`."); }
  if (!r.ok) { let d = ""; try { d = (await r.json()).message || ""; } catch {} throw new Error(`HTTP ${r.status}${d ? ": " + d : ""}`); }
  return r.status === 204 ? null : r.json();
}
async function resolveMission(key) {
  const rows = await api(`/rest/v1/missions?select=id,key,name,color,kind&key=ilike.${encodeURIComponent(key)}`);
  if (!rows.length) throw new Error(`No mission "${key.toUpperCase()}" (or no access).`); return rows[0];
}
async function resolveTask(ref) {
  const m = String(ref).match(/^([A-Za-z]{2,5})-(\d+)$/); if (!m) throw new Error(`Bad task ref "${ref}" — expected like TEL-12`);
  const mission = await resolveMission(m[1]);
  const rows = await api(`/rest/v1/tasks?select=id,number,title,status,due_date,postponed_count&mission_id=eq.${mission.id}&number=eq.${m[2]}`);
  if (!rows.length) throw new Error(`No task ${m[1].toUpperCase()}-${m[2]}.`); return { ...rows[0], mission };
}
const fmtTask = (t, withKey) => `${withKey && t.missions ? t.missions.key + "-" + t.number + " " : ""}[${t.status}]${t.priority ? " " + t.priority : ""} ${t.title}${t.due_date ? " (due " + t.due_date + ")" : ""}`;

// ── tools ───────────────────────────────────────────────────────────────────
const TOOLS = {
  list_missions: {
    description: "List all projects/missions the user can access, grouped by kind (client missions, internal builds, team projects).",
    schema: { type: "object", properties: {} },
    run: async () => {
      const rows = await api(`/rest/v1/missions?select=key,name,kind,status,mission_type&order=kind.asc,key.asc`);
      const g = { client: [], internal: [], team: [] };
      for (const m of rows) (g[m.kind] || g.client).push(`${m.key} — ${m.name}${m.kind === "client" && m.mission_type ? " (" + m.mission_type + ")" : ""}${m.status !== "active" ? " [" + m.status + "]" : ""}`);
      return [g.client.length ? "MISSIONS:\n" + g.client.map((x) => "  " + x).join("\n") : "",
        g.internal.length ? "INTERNE:\n" + g.internal.map((x) => "  " + x).join("\n") : "",
        g.team.length ? "ÉQUIPE:\n" + g.team.map((x) => "  " + x).join("\n") : ""].filter(Boolean).join("\n\n");
    },
  },
  list_tasks: {
    description: "List tasks of one mission by its key (e.g. TEL, MODJ). Set include_done to also show completed tasks.",
    schema: { type: "object", properties: { mission_key: { type: "string" }, include_done: { type: "boolean" } }, required: ["mission_key"] },
    run: async (a) => {
      const m = await resolveMission(a.mission_key);
      const rows = await api(`/rest/v1/tasks?select=number,title,status,due_date,priority&mission_id=eq.${m.id}${a.include_done ? "" : "&status=neq.done"}&order=status.desc,number.asc&limit=200`);
      if (!rows.length) return `${m.key} — ${m.name}: no ${a.include_done ? "" : "open "}tasks.`;
      return `${m.key} — ${m.name}\n` + rows.map((t) => `  ${m.key}-${t.number}  ${fmtTask(t)}`).join("\n");
    },
  },
  today: {
    description: "The user's open tasks due today or overdue, across all missions.",
    schema: { type: "object", properties: {} },
    run: async () => {
      const today = new Date().toISOString().slice(0, 10);
      const rows = await api(`/rest/v1/tasks?select=number,title,status,due_date,priority,missions!inner(key)&status=neq.done&due_date=lte.${today}&order=due_date.asc`);
      if (!rows.length) return "Nothing due today.";
      return `Today (${rows.length} open):\n` + rows.map((t) => "  " + fmtTask({ ...t, missions: t.missions }, true)).join("\n");
    },
  },
  my_tasks: {
    description: "Open tasks assigned to the current user, across all their missions.",
    schema: { type: "object", properties: {} },
    run: async () => {
      const conf = loadConf();
      const rows = await api(`/rest/v1/tasks?select=number,title,status,due_date,priority,missions!inner(key)&assignee_id=eq.${conf.user_id}&status=neq.done&order=due_date.asc.nullslast`);
      if (!rows.length) return "No tasks assigned to you.";
      return `Assigned to me (${rows.length}):\n` + rows.map((t) => "  " + fmtTask({ ...t, missions: t.missions }, true)).join("\n");
    },
  },
  add_task: {
    description: "Create a task in a mission. priority is p1 (high) / p2 / p3; tags is an array of strings.",
    schema: { type: "object", properties: { mission_key: { type: "string" }, title: { type: "string" }, priority: { type: "string", enum: ["p1", "p2", "p3"] }, tags: { type: "array", items: { type: "string" } } }, required: ["mission_key", "title"] },
    run: async (a) => {
      const m = await resolveMission(a.mission_key); const conf = loadConf();
      const [t] = await api(`/rest/v1/tasks`, { method: "POST", body: JSON.stringify({ mission_id: m.id, title: a.title, priority: a.priority || "p2", tags: a.tags || [], status: "todo", source: "manual", is_client_visible: false, created_by: conf.user_id }) });
      return `Created ${m.key}-${t.number}: ${a.title}`;
    },
  },
  complete_task: {
    description: "Mark a task done by its reference (e.g. TEL-12).",
    schema: { type: "object", properties: { task_ref: { type: "string" } }, required: ["task_ref"] },
    run: async (a) => { const t = await resolveTask(a.task_ref); await api(`/rest/v1/tasks?id=eq.${t.id}`, { method: "PATCH", body: JSON.stringify({ status: "done", done_at: new Date().toISOString() }) }); return `Done: ${t.mission.key}-${t.number} — ${t.title}`; },
  },
  start_task: {
    description: "Move a task to 'doing' by its reference (e.g. TEL-12).",
    schema: { type: "object", properties: { task_ref: { type: "string" } }, required: ["task_ref"] },
    run: async (a) => { const t = await resolveTask(a.task_ref); await api(`/rest/v1/tasks?id=eq.${t.id}`, { method: "PATCH", body: JSON.stringify({ status: "doing" }) }); return `Doing: ${t.mission.key}-${t.number} — ${t.title}`; },
  },
  postpone_task: {
    description: "Change a task's due date. 'when' is +Nd (e.g. +3d), 'monday', or a YYYY-MM-DD date. Increments the postpone count.",
    schema: { type: "object", properties: { task_ref: { type: "string" }, when: { type: "string" } }, required: ["task_ref", "when"] },
    run: async (a) => {
      const t = await resolveTask(a.task_ref); let tgt; const rel = String(a.when).match(/^\+(\d+)d$/);
      if (rel) { const d = new Date(); d.setDate(d.getDate() + +rel[1]); tgt = d.toISOString().slice(0, 10); }
      else if (/^\d{4}-\d{2}-\d{2}$/.test(a.when)) tgt = a.when;
      else if (a.when === "monday") { const d = new Date(); d.setDate(d.getDate() + (((1 - d.getDay() + 7) % 7) || 7)); tgt = d.toISOString().slice(0, 10); }
      else throw new Error("when must be +Nd, monday, or YYYY-MM-DD");
      await api(`/rest/v1/tasks?id=eq.${t.id}`, { method: "PATCH", body: JSON.stringify({ due_date: tgt, postponed_count: (t.postponed_count || 0) + 1 }) });
      return `Postponed ${t.mission.key}-${t.number} to ${tgt}`;
    },
  },
  comment_task: {
    description: "Add a comment to a task. Set is_question true to flag it as a question (routes to the admin inbox with attribution).",
    schema: { type: "object", properties: { task_ref: { type: "string" }, text: { type: "string" }, is_question: { type: "boolean" } }, required: ["task_ref", "text"] },
    run: async (a) => { const t = await resolveTask(a.task_ref); const conf = loadConf(); await api(`/rest/v1/comments`, { method: "POST", body: JSON.stringify({ task_id: t.id, body: a.text, author_id: conf.user_id, is_question: !!a.is_question }) }); return `${a.is_question ? "Question" : "Comment"} added to ${t.mission.key}-${t.number}`; },
  },
  new_mission: {
    description: "Create a new project. kind is 'client' (client mission), 'internal' (internal build), or 'team' (shared team project). key is an optional 3-letter uppercase code.",
    schema: { type: "object", properties: { kind: { type: "string", enum: ["client", "internal", "team"] }, name: { type: "string" }, key: { type: "string" } }, required: ["kind", "name"] },
    run: async (a) => {
      const key = (a.key || a.name.replace(/[^a-zA-Z]/g, "").slice(0, 3)).toUpperCase();
      const colors = ["#DDFF56", "#7DD3FC", "#F0ABFC", "#FCA5A5", "#FDBA74"];
      const payload = { name: a.name, key, kind: a.kind, color: colors[a.name.length % colors.length], status: "active", visibility: a.kind === "team" ? "team" : "private" };
      if (a.kind === "client") payload.mission_type = "custom_build";
      const out = await api(`/rest/v1/rpc/create_mission`, { method: "POST", body: JSON.stringify({ _payload: payload }) });
      const m = Array.isArray(out) ? out[0] : out;
      return `Created ${(m && m.key) || key} — ${a.name} (${a.kind})`;
    },
  },
  log_extra_hours: {
    description: "Log extra work hours (evenings/weekends — always counted as production). Optionally attribute to a mission key.",
    schema: { type: "object", properties: { hours: { type: "number" }, mission_key: { type: "string" }, note: { type: "string" } }, required: ["hours"] },
    run: async (a) => {
      let mission_id = null; if (a.mission_key) { try { mission_id = (await resolveMission(a.mission_key)).id; } catch {} }
      const conf = loadConf();
      await api(`/rest/v1/time_entries`, { method: "POST", body: JSON.stringify({ profile_id: conf.user_id, entry_date: new Date().toISOString().slice(0, 10), hours: a.hours, mission_id, note: a.note || null, source: "extra" }) });
      return `Logged ${a.hours}h extra${a.mission_key ? " on " + a.mission_key.toUpperCase() : ""} (production).`;
    },
  },
};

// ── MCP stdio transport (newline-delimited JSON-RPC 2.0) ─────────────────────
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const errReply = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: (params && params.protocolVersion) || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "missions", version: "0.1.0" },
    });
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return; // no response
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") {
    return reply(id, { tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.schema })) });
  }
  if (method === "tools/call") {
    const name = params && params.name; const tool = TOOLS[name];
    if (!tool) return reply(id, { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true });
    try {
      const text = await tool.run((params && params.arguments) || {});
      return reply(id, { content: [{ type: "text", text: String(text) }] });
    } catch (e) {
      return reply(id, { content: [{ type: "text", text: "Error: " + (e.message || String(e)) }], isError: true });
    }
  }
  if (id !== undefined) errReply(id, -32601, `Method not found: ${method}`);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    handle(msg).catch((e) => { if (msg && msg.id !== undefined) errReply(msg.id, -32603, e.message || String(e)); });
  }
});
process.stdin.on("end", () => process.exit(0));
