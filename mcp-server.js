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
async function resolveAssignee(name) {
  const rows = await api(`/rest/v1/profiles?select=id,full_name&full_name=ilike.*${encodeURIComponent(name)}*&limit=3`);
  if (!rows.length) throw new Error(`No teammate matching "${name}".`);
  if (rows.length > 1) throw new Error(`"${name}" matches several people (${rows.map((r) => r.full_name).join(", ")}) — be more specific.`);
  return rows[0];
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
    description: "Create a task in a mission. priority p1/p2/p3; due_date YYYY-MM-DD; assignee is a teammate's name (matched fuzzily); tags is an array of strings.",
    schema: { type: "object", properties: { mission_key: { type: "string" }, title: { type: "string" }, priority: { type: "string", enum: ["p1", "p2", "p3"] }, due_date: { type: "string" }, assignee: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, required: ["mission_key", "title"] },
    run: async (a) => {
      const m = await resolveMission(a.mission_key); const conf = loadConf();
      const body = { mission_id: m.id, title: a.title, priority: a.priority || "p2", tags: a.tags || [], status: "todo", source: "manual", is_client_visible: false, created_by: conf.user_id };
      if (a.due_date) body.due_date = a.due_date;
      let who = ""; if (a.assignee) { const p = await resolveAssignee(a.assignee); body.assignee_id = p.id; who = ` → ${p.full_name}`; }
      const [t] = await api(`/rest/v1/tasks`, { method: "POST", body: JSON.stringify(body) });
      return `Created ${m.key}-${t.number}: ${a.title}${a.due_date ? " (due " + a.due_date + ")" : ""}${who}`;
    },
  },
  update_task: {
    description: "Edit an existing task by reference (e.g. TEL-12). Set any of: due_date (YYYY-MM-DD, or null to clear), priority (p1/p2/p3), title, assignee (teammate name). Only the fields you pass are changed.",
    schema: { type: "object", properties: { task_ref: { type: "string" }, due_date: { type: ["string", "null"] }, priority: { type: "string", enum: ["p1", "p2", "p3"] }, title: { type: "string" }, assignee: { type: "string" } }, required: ["task_ref"] },
    run: async (a) => {
      const t = await resolveTask(a.task_ref); const patch = {}; const changed = [];
      if (a.due_date !== undefined) { patch.due_date = a.due_date; changed.push(a.due_date ? "due " + a.due_date : "due date cleared"); }
      if (a.priority) { patch.priority = a.priority; changed.push(a.priority); }
      if (a.title) { patch.title = a.title; changed.push("renamed"); }
      if (a.assignee) { const p = await resolveAssignee(a.assignee); patch.assignee_id = p.id; changed.push("→ " + p.full_name); }
      if (!changed.length) return "Nothing to change — pass at least one field (due_date, priority, title, assignee).";
      await api(`/rest/v1/tasks?id=eq.${t.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      return `Updated ${t.mission.key}-${t.number}: ${changed.join(", ")}`;
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

  calendar: {
    description: "Your Google Calendar events for the next N days (default 7). Shows time, title, and attendee count.",
    schema: { type: "object", properties: { days: { type: "number", description: "how many days ahead (default 7)" } } },
    run: async (a) => {
      const days = a.days || 7; const now = new Date(); const end = new Date(now.getTime() + days * 864e5);
      const out = await api(`/functions/v1/gcal-events`, { method: "POST", body: JSON.stringify({ start: now.toISOString(), end: end.toISOString() }) });
      const events = (out && out.events) || out || [];
      if (!events.length) return `No calendar events in the next ${days} days.`;
      const byDay = {};
      for (const e of events) { const d = new Date(e.start).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }); (byDay[d] = byDay[d] || []).push(e); }
      return Object.entries(byDay).map(([d, evs]) => d + "\n" + evs.map((e) => {
        const t = e.all_day ? "all day" : new Date(e.start).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
        return `  ${t}  ${e.title}${e.attendee_count ? ` (${e.attendee_count} guests)` : ""}`;
      }).join("\n")).join("\n\n");
    },
  },
  upcoming_meetings: {
    description: "Your upcoming meetings (calendar events that have other attendees) for the next N days (default 3).",
    schema: { type: "object", properties: { days: { type: "number", description: "how many days ahead (default 3)" } } },
    run: async (a) => {
      const days = a.days || 3; const now = new Date(); const end = new Date(now.getTime() + days * 864e5);
      const out = await api(`/functions/v1/gcal-events`, { method: "POST", body: JSON.stringify({ start: now.toISOString(), end: end.toISOString() }) });
      const events = ((out && out.events) || out || []).filter((e) => !e.all_day && (e.attendee_count || 0) > 0 && new Date(e.start) >= now);
      if (!events.length) return `No meetings in the next ${days} days.`;
      return `Upcoming meetings:\n` + events.map((e) => {
        const when = new Date(e.start).toLocaleString("fr-FR", { weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
        return `  ${when}  ${e.title} (${e.attendee_count} guests)`;
      }).join("\n");
    },
  },
  inbox: {
    description: "Your triage inbox: pending client requests and open questions awaiting a decision, with their urgency.",
    schema: { type: "object", properties: {} },
    run: async () => {
      const reqs = await api(`/rest/v1/tasks?select=number,title,urgency,triage_status,missions!inner(key)&source=eq.client&triage_status=in.(pending,postponed)&order=urgency.desc,created_at.asc`);
      const qs = await api(`/rest/v1/tasks?select=number,title,missions!inner(key)&kind=eq.question&status=neq.done&order=created_at.asc`);
      const lines = [];
      if (reqs.length) lines.push("CLIENTS (à trier):\n" + reqs.map((t) => `  ${t.missions.key}-${t.number}  [${t.urgency || "normale"}${t.triage_status === "postponed" ? ", reporté" : ""}] ${t.title}`).join("\n"));
      if (qs.length) lines.push("QUESTIONS:\n" + qs.map((t) => `  ${t.missions.key}-${t.number}  ${t.title}`).join("\n"));
      return lines.length ? lines.join("\n\n") : "Inbox empty — nothing to triage.";
    },
  },
  list_comments: {
    description: "Read the comments/discussion thread on a task by its reference (e.g. TEL-12).",
    schema: { type: "object", properties: { task_ref: { type: "string" } }, required: ["task_ref"] },
    run: async (a) => {
      const t = await resolveTask(a.task_ref);
      const rows = await api(`/rest/v1/comments?select=body,is_question,created_at,resolved_at,author:profiles!comments_author_id_fkey(full_name)&task_id=eq.${t.id}&order=created_at.asc`);
      if (!rows.length) return `${t.mission.key}-${t.number}: no comments.`;
      return `${t.mission.key}-${t.number} — ${t.title}\n` + rows.map((c) => `  ${(c.author && c.author.full_name) || "?"}${c.is_question ? " [Q" + (c.resolved_at ? ", répondu" : "") + "]" : ""}: ${c.body}`).join("\n");
    },
  },
  accept_request: {
    description: "Accept a client request from the inbox (task ref). Optionally set priority (p1/p2/p3) and a due date (YYYY-MM-DD).",
    schema: { type: "object", properties: { task_ref: { type: "string" }, priority: { type: "string", enum: ["p1", "p2", "p3"] }, due_date: { type: "string" } }, required: ["task_ref"] },
    run: async (a) => {
      const t = await resolveTask(a.task_ref); const patch = { triage_status: "accepted", triage_at: new Date().toISOString() };
      if (a.priority) patch.priority = a.priority; if (a.due_date) patch.due_date = a.due_date;
      await api(`/rest/v1/tasks?id=eq.${t.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      return `Accepted ${t.mission.key}-${t.number}${a.due_date ? " (due " + a.due_date + ")" : ""}.`;
    },
  },
  postpone_request: {
    description: "Postpone a client request with a written reason and a resurface date (when: +Nd, monday, or YYYY-MM-DD). The reason is shown to the client.",
    schema: { type: "object", properties: { task_ref: { type: "string" }, when: { type: "string" }, reason: { type: "string" } }, required: ["task_ref", "when", "reason"] },
    run: async (a) => {
      const t = await resolveTask(a.task_ref); let tgt; const rel = String(a.when).match(/^\+(\d+)d$/);
      if (rel) { const d = new Date(); d.setDate(d.getDate() + +rel[1]); tgt = d.toISOString().slice(0, 10); }
      else if (/^\d{4}-\d{2}-\d{2}$/.test(a.when)) tgt = a.when;
      else if (a.when === "monday") { const d = new Date(); d.setDate(d.getDate() + (((1 - d.getDay() + 7) % 7) || 7)); tgt = d.toISOString().slice(0, 10); }
      else throw new Error("when must be +Nd, monday, or YYYY-MM-DD");
      await api(`/rest/v1/tasks?id=eq.${t.id}`, { method: "PATCH", body: JSON.stringify({ triage_status: "postponed", triage_reason: a.reason, triage_at: new Date().toISOString(), due_date: tgt }) });
      return `Postponed ${t.mission.key}-${t.number} to ${tgt} — reason recorded.`;
    },
  },
  decline_request: {
    description: "Decline a client request. Reason is optional (e.g. 'Doublon'). Shown to the client if given.",
    schema: { type: "object", properties: { task_ref: { type: "string" }, reason: { type: "string" } }, required: ["task_ref"] },
    run: async (a) => {
      const t = await resolveTask(a.task_ref);
      await api(`/rest/v1/tasks?id=eq.${t.id}`, { method: "PATCH", body: JSON.stringify({ triage_status: "declined", triage_reason: a.reason || null, triage_at: new Date().toISOString() }) });
      return `Declined ${t.mission.key}-${t.number}${a.reason ? " — " + a.reason : ""}.`;
    },
  },
  delete_task: {
    description: "Permanently delete a task (DESTRUCTIVE, no undo). ALWAYS confirm the exact task with the user first. Without confirm=true this returns a preview instead of deleting — never pass confirm=true unless the user has explicitly agreed to delete this specific task.",
    schema: { type: "object", properties: { task_ref: { type: "string" }, confirm: { type: "boolean" } }, required: ["task_ref"] },
    run: async (a) => {
      const t = await resolveTask(a.task_ref);
      if (a.confirm !== true) return `⚠️ About to permanently delete ${t.mission.key}-${t.number}: "${t.title}" (status: ${t.status}). This cannot be undone. Confirm with the user, then call delete_task again with confirm=true.`;
      await api(`/rest/v1/tasks?id=eq.${t.id}`, { method: "DELETE" });
      return `Deleted ${t.mission.key}-${t.number} — ${t.title}`;
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
