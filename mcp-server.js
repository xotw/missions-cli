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
// Accepts YYYY-MM-DD, +Nd, today/tomorrow (FR/EN), or a weekday name (FR/EN). Returns YYYY-MM-DD or throws.
function parseDate(s) {
  const t = String(s).trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const d = new Date();
  if (t === "today" || t === "aujourd'hui") return d.toISOString().slice(0, 10);
  if (t === "tomorrow" || t === "demain") { d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); }
  const rel = t.match(/^\+\s*(\d+)\s*d/); if (rel) { d.setDate(d.getDate() + +rel[1]); return d.toISOString().slice(0, 10); }
  const days = { sunday: 0, dimanche: 0, monday: 1, lundi: 1, tuesday: 2, mardi: 2, wednesday: 3, mercredi: 3, thursday: 4, jeudi: 4, friday: 5, vendredi: 5, saturday: 6, samedi: 6 };
  const wd = days[t.replace(/^(next|prochain|le)\s+/, "")];
  if (wd !== undefined) { const diff = ((wd - d.getDay() + 7) % 7) || 7; d.setDate(d.getDate() + diff); return d.toISOString().slice(0, 10); }
  throw new Error(`Couldn't read the date "${s}" — use YYYY-MM-DD, +Nd, today/tomorrow, or a weekday.`);
}
const fmtTask = (t, withKey) => `${withKey && t.missions ? t.missions.key + "-" + t.number + " " : ""}[${t.status}]${t.priority ? " " + t.priority : ""} ${t.title}${t.due_date ? " (due " + t.due_date + ")" : ""}`;
// Indented description/note block for list views — carries the context behind a task (esp. head/customer requests).
const fmtNotes = (t) => {
  const out = [];
  if (t.description && t.description.trim()) out.push("      " + t.description.trim().replace(/\n/g, "\n      "));
  if (t.note && t.note.trim()) out.push("      (" + t.note.trim().replace(/\n/g, " ") + ")");
  return out.length ? "\n" + out.join("\n") : "";
};

// ── mission tools (Gantt / RACI) helpers ──
const uuid = () => require("crypto").randomUUID();
async function resolveMissionTool(mission_key, title, kind) {
  const m = await resolveMission(mission_key);
  const rows = await api(`/rest/v1/mission_tools?select=id,kind,title,data,visible_to_client,editable_by_head&mission_id=eq.${m.id}&title=ilike.*${encodeURIComponent(title)}*${kind ? "&kind=eq." + kind : ""}`);
  if (!rows.length) throw new Error(`No ${kind || "tool"} matching "${title}" in ${m.key}.`);
  return { ...rows[0], mission: m };
}
function renderRaci(t, flags) {
  const d = t.data || {}; const cols = d.columns || []; const rows = d.rows || [];
  if (!rows.length && !cols.length) return `${t.title} (RACI) ${flags}\n  (empty — add deliverables and people)`;
  const dW = Math.max("Livrable".length, ...rows.map((r) => (r.deliverable || "").length), 1);
  const cW = cols.map((c) => Math.max((c.name || "").length, 1));
  const line = (cells) => "  " + String(cells[0]).padEnd(dW) + cells.slice(1).map((v, i) => "  " + String(v).padEnd(cW[i])).join("");
  const out = [`${t.title} (RACI) ${flags}`, line(["Livrable", ...cols.map((c) => c.name)])];
  for (const r of rows) out.push(line([r.deliverable, ...cols.map((c) => r.cells[c.id] || "·")]));
  return out.join("\n");
}
function renderGantt(t, flags) {
  const bars = (t.data && t.data.bars) || [];
  if (!bars.length) return `${t.title} (GANTT) ${flags}\n  (empty — add tasks)`;
  const byId = Object.fromEntries(bars.map((b) => [b.id, b.label]));
  const sorted = [...bars].sort((a, b) => (a.start || "").localeCompare(b.start || ""));
  const lW = Math.max(...sorted.map((b) => (b.label || "").length), 4);
  return `${t.title} (GANTT) ${flags}\n` + sorted.map((b) => `  ${(b.label || "").padEnd(lW)}  ${b.start} → ${b.end}  ${String(b.progress || 0).padStart(3)}%${b.deps && b.deps.length ? "  after " + b.deps.map((id) => byId[id] || "?").join(", ") : ""}`).join("\n");
}

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
      const rows = await api(`/rest/v1/tasks?select=number,title,status,due_date,priority,note,description&mission_id=eq.${m.id}${a.include_done ? "" : "&status=neq.done"}&order=status.desc,number.asc&limit=200`);
      if (!rows.length) return `${m.key} — ${m.name}: no ${a.include_done ? "" : "open "}tasks.`;
      return `${m.key} — ${m.name}\n` + rows.map((t) => `  ${m.key}-${t.number}  ${fmtTask(t)}${fmtNotes(t)}`).join("\n");
    },
  },
  today: {
    description: "MY tasks due today or overdue (assigned to me). To see a whole mission's tasks incl. others' or unassigned work, use list_tasks by mission name.",
    schema: { type: "object", properties: {} },
    run: async () => {
      const conf = loadConf(); const today = new Date().toISOString().slice(0, 10);
      const rows = await api(`/rest/v1/tasks?select=number,title,status,due_date,priority,note,description,missions!inner(key)&status=neq.done&due_date=lte.${today}&assignee_id=eq.${conf.user_id}&order=due_date.asc`);
      if (!rows.length) return "Nothing assigned to you due today. (To see a mission's full board incl. unassigned work, ask for it by name.)";
      return `Your day (${rows.length} due/overdue):\n` + rows.map((t) => "  " + fmtTask({ ...t, missions: t.missions }, true) + fmtNotes(t)).join("\n");
    },
  },
  my_tasks: {
    description: "Open tasks assigned to the current user, across all their missions.",
    schema: { type: "object", properties: {} },
    run: async () => {
      const conf = loadConf();
      const rows = await api(`/rest/v1/tasks?select=number,title,status,due_date,priority,note,description,missions!inner(key)&assignee_id=eq.${conf.user_id}&status=neq.done&order=due_date.asc.nullslast`);
      if (!rows.length) return "No tasks assigned to you.";
      return `Assigned to me (${rows.length}):\n` + rows.map((t) => "  " + fmtTask({ ...t, missions: t.missions }, true) + fmtNotes(t)).join("\n");
    },
  },
  add_task: {
    description: "Create a task in a mission. priority p1/p2/p3; due_date (YYYY-MM-DD, +Nd, today/tomorrow, or a weekday like Friday); assignee is a teammate's name (matched fuzzily); tags is an array of strings.",
    schema: { type: "object", properties: { mission_key: { type: "string" }, title: { type: "string" }, priority: { type: "string", enum: ["p1", "p2", "p3"] }, due_date: { type: "string" }, assignee: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, required: ["mission_key", "title"] },
    run: async (a) => {
      const m = await resolveMission(a.mission_key); const conf = loadConf();
      const body = { mission_id: m.id, title: a.title, priority: a.priority || "p2", tags: a.tags || [], status: "todo", source: "manual", is_client_visible: false, created_by: conf.user_id };
      if (a.due_date) body.due_date = parseDate(a.due_date);
      let who = ""; if (a.assignee) { const p = await resolveAssignee(a.assignee); body.assignee_id = p.id; who = ` → ${p.full_name}`; }
      const [t] = await api(`/rest/v1/tasks`, { method: "POST", body: JSON.stringify(body) });
      return `Created ${m.key}-${t.number}: ${a.title}${a.due_date ? " (due " + a.due_date + ")" : ""}${who}`;
    },
  },
  update_task: {
    description: "Edit an existing task by reference (e.g. TEL-12). Set any of: due_date (YYYY-MM-DD / +Nd / today / tomorrow / weekday, or null to clear), priority (p1/p2/p3), title, assignee (teammate name). Only the fields you pass are changed.",
    schema: { type: "object", properties: { task_ref: { type: "string" }, due_date: { type: ["string", "null"] }, priority: { type: "string", enum: ["p1", "p2", "p3"] }, title: { type: "string" }, assignee: { type: "string" } }, required: ["task_ref"] },
    run: async (a) => {
      const t = await resolveTask(a.task_ref); const patch = {}; const changed = [];
      if (a.due_date !== undefined) { patch.due_date = a.due_date === null ? null : parseDate(a.due_date); changed.push(patch.due_date ? "due " + patch.due_date : "due date cleared"); }
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
      const slug = a.name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || key.toLowerCase();
      const colors = ["#DDFF56", "#7DD3FC", "#F0ABFC", "#FCA5A5", "#FDBA74"];
      const payload = { name: a.name, slug, key, kind: a.kind, color: colors[a.name.length % colors.length], status: "active", visibility: a.kind === "team" ? "team" : "private" };
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
      await api(`/rest/v1/time_entries`, { method: "POST", body: JSON.stringify({ profile_id: conf.user_id, entry_date: new Date().toISOString().slice(0, 10), hours: a.hours, mission_id, note: a.note || null, source: "manual" }) });
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
      const reqs = await api(`/rest/v1/tasks?select=number,title,urgency,triage_status,requester:profiles!created_by(full_name),missions!inner(key)&source=eq.client&triage_status=in.(pending,postponed)&order=urgency.desc,created_at.asc`);
      const heads = await api(`/rest/v1/head_asks?select=kind,title,when_text,missions:missions!head_asks_mission_id_fkey(key),head:profiles!head_asks_from_head_id_fkey(full_name)&status=eq.open&order=created_at.asc`).catch(() => []);
      const lines = [];
      if (reqs.length) lines.push("CLIENTS (à trier):\n" + reqs.map((t) => `  ${t.missions.key}-${t.number}  [${t.urgency || "normale"}${t.triage_status === "postponed" ? ", reporté" : ""}] ${t.title}${t.requester && t.requester.full_name ? "  (" + t.requester.full_name + ")" : ""}`).join("\n"));
      if (heads.length) lines.push("HEADS (demandes):\n" + heads.map((h) => `  ${h.missions ? h.missions.key : "?"}  [${h.kind}] ${h.title}${h.when_text ? " — " + h.when_text : ""}  (${h.head ? h.head.full_name : "?"})`).join("\n"));
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
  show_task: {
    description: "Show one task in full — its description/notes, status, priority, urgency, due date, assignee, provenance (source) and the comment thread. Use this to read the context behind a task, especially head-of-mission and customer requests.",
    schema: { type: "object", properties: { task_ref: { type: "string" } }, required: ["task_ref"] },
    run: async (a) => {
      const t = await resolveTask(a.task_ref);
      const rows = await api(`/rest/v1/tasks?select=number,title,status,priority,urgency,due_date,source,triage_status,triage_reason,is_client_visible,note,description,assignee_id,requester:profiles!created_by(full_name)&id=eq.${t.id}`);
      const d = rows[0] || {};
      let assignee = "—";
      if (d.assignee_id) { const p = await api(`/rest/v1/profiles?select=full_name&id=eq.${d.assignee_id}`).catch(() => []); if (p[0]) assignee = p[0].full_name; }
      const comments = await api(`/rest/v1/comments?select=body,is_question,resolved_at,author:profiles!comments_author_id_fkey(full_name)&task_id=eq.${t.id}&order=created_at.asc`).catch(() => []);
      const meta = [
        `status: ${d.status}${d.priority ? " · " + d.priority : ""}${d.urgency && d.urgency !== "normale" ? " · urgence " + d.urgency : ""}`,
        d.due_date ? `due: ${d.due_date}` : null,
        `assignee: ${assignee}`,
        d.requester && d.requester.full_name ? `requested by: ${d.requester.full_name}${d.source === "client" ? " (client)" : ""}` : null,
        d.source ? `source: ${d.source}` : null,
        d.triage_status && d.triage_status !== "pending" ? `triage: ${d.triage_status}${d.triage_reason ? " (" + d.triage_reason + ")" : ""}` : null,
        d.is_client_visible ? "visible to client" : null,
      ].filter(Boolean).map((x) => "  " + x).join("\n");
      const body = d.description && d.description.trim() ? `\n\nDescription:\n${d.description.trim()}` : "";
      const provenance = d.note && d.note.trim() ? `\n\nNote: ${d.note.trim()}` : "";
      const thread = comments.length ? "\n\nComments:\n" + comments.map((c) => `  ${(c.author && c.author.full_name) || "?"}${c.is_question ? " [Q" + (c.resolved_at ? ", répondu" : "") + "]" : ""}: ${c.body}`).join("\n") : "";
      return `${t.mission.key}-${d.number} — ${d.title}\n${meta}${body}${provenance}${thread}`;
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

  set_urgency: {
    description: "Set a task's urgency: normale, haute, or critique.",
    schema: { type: "object", properties: { task_ref: { type: "string" }, urgency: { type: "string", enum: ["normale", "haute", "critique"] } }, required: ["task_ref", "urgency"] },
    run: async (a) => { const t = await resolveTask(a.task_ref); await api(`/rest/v1/rpc/set_task_urgency`, { method: "POST", body: JSON.stringify({ _task_id: t.id, _urgency: a.urgency }) }); return `${t.mission.key}-${t.number} urgency → ${a.urgency}`; },
  },

  // ── task relations ──
  link_tasks: {
    description: "Create a relation between two tasks. type 'blocks' means task_ref blocks other_ref; type 'related' links them.",
    schema: { type: "object", properties: { task_ref: { type: "string" }, type: { type: "string", enum: ["blocks", "related"] }, other_ref: { type: "string" } }, required: ["task_ref", "type", "other_ref"] },
    run: async (a) => { const t = await resolveTask(a.task_ref); const o = await resolveTask(a.other_ref); await api(`/rest/v1/task_relations`, { method: "POST", body: JSON.stringify({ task_id: t.id, related_task_id: o.id, type: a.type }) }); return `${t.mission.key}-${t.number} ${a.type === "blocks" ? "blocks" : "related to"} ${o.mission.key}-${o.number}`; },
  },
  show_relations: {
    description: "Show what a task blocks, what blocks it, and related tasks.",
    schema: { type: "object", properties: { task_ref: { type: "string" } }, required: ["task_ref"] },
    run: async (a) => {
      const t = await resolveTask(a.task_ref);
      const out = await api(`/rest/v1/task_relations?select=type,task_id,related_task_id,task:tasks!task_relations_task_id_fkey(number,title,status,missions(key)),related:tasks!task_relations_related_task_id_fkey(number,title,status,missions(key))&or=(task_id.eq.${t.id},related_task_id.eq.${t.id})`);
      if (!out.length) return `${t.mission.key}-${t.number}: no relations.`;
      const fmt = (x) => x && x.missions ? `${x.missions.key}-${x.number} [${x.status}] ${x.title}` : "?";
      const blocks = out.filter((r) => r.type === "blocks" && r.task_id === t.id).map((r) => "  blocks → " + fmt(r.related));
      const blockedBy = out.filter((r) => r.type === "blocks" && r.related_task_id === t.id).map((r) => "  blocked by ← " + fmt(r.task));
      const rel = out.filter((r) => r.type === "related").map((r) => "  related · " + fmt(r.task_id === t.id ? r.related : r.task));
      return `${t.mission.key}-${t.number} — ${t.title}\n` + [...blockedBy, ...blocks, ...rel].join("\n");
    },
  },

  // ── mission detail + notes ──
  show_mission: {
    description: "Full detail of one mission by key: client, head, dates, goal, status, links, team members, and task counts.",
    schema: { type: "object", properties: { mission_key: { type: "string" } }, required: ["mission_key"] },
    run: async (a) => {
      const rows = await api(`/rest/v1/missions?select=id,key,name,kind,mission_type,status,phase,client_company,head_name,goal,start_date,end_date,notion_url,slack_url,dashboard_url&key=ilike.${encodeURIComponent(a.mission_key)}`);
      if (!rows.length) throw new Error(`No mission "${a.mission_key.toUpperCase()}".`);
      const m = rows[0];
      const members = await api(`/rest/v1/mission_members?select=role_on_mission,profiles(full_name)&mission_id=eq.${m.id}`);
      const counts = await api(`/rest/v1/tasks?select=status&mission_id=eq.${m.id}`);
      const c = { todo: 0, doing: 0, done: 0 }; for (const t of counts) c[t.status] = (c[t.status] || 0) + 1;
      const links = [m.notion_url && "Notion", m.slack_url && "Slack", m.dashboard_url && "Dashboard"].filter(Boolean).join(", ") || "—";
      return `${m.key} — ${m.name}  [${m.kind}${m.mission_type ? "/" + m.mission_type : ""}, ${m.status}${m.phase ? ", " + m.phase : ""}]
  Client: ${m.client_company || "—"}   Head: ${m.head_name || "—"}
  Window: ${m.start_date || "—"} → ${m.end_date || "∞"}
  Goal: ${m.goal || "—"}
  Team: ${members.map((x) => `${x.profiles ? x.profiles.full_name : "?"} (${x.role_on_mission})`).join(", ") || "—"}
  Tasks: ${c.todo} todo · ${c.doing} doing · ${c.done} done
  Links: ${links}`;
    },
  },
  list_notes: {
    description: "List the notes on a mission (by key).",
    schema: { type: "object", properties: { mission_key: { type: "string" } }, required: ["mission_key"] },
    run: async (a) => {
      const m = await resolveMission(a.mission_key);
      const rows = await api(`/rest/v1/mission_notes?select=title,content,is_client_visible,updated_at&mission_id=eq.${m.id}&order=updated_at.desc`);
      if (!rows.length) return `${m.key}: no notes.`;
      return `${m.key} — notes\n` + rows.map((n) => `  • ${n.title}${n.is_client_visible ? " (client-visible)" : ""}\n    ${(n.content || "").slice(0, 200)}`).join("\n");
    },
  },
  add_note: {
    description: "Add a note to a mission. client_visible defaults false (internal).",
    schema: { type: "object", properties: { mission_key: { type: "string" }, title: { type: "string" }, content: { type: "string" }, client_visible: { type: "boolean" } }, required: ["mission_key", "title", "content"] },
    run: async (a) => {
      const m = await resolveMission(a.mission_key); const conf = loadConf();
      await api(`/rest/v1/mission_notes`, { method: "POST", body: JSON.stringify({ mission_id: m.id, title: a.title, content: a.content, is_client_visible: !!a.client_visible, created_by: conf.user_id }) });
      return `Note added to ${m.key}: ${a.title}`;
    },
  },

  // ── mission files ──
  list_files: {
    description: "List the files attached to a mission (by key): filename, size, type, and who can see them (head/client).",
    schema: { type: "object", properties: { mission_key: { type: "string" } }, required: ["mission_key"] },
    run: async (a) => {
      const m = await resolveMission(a.mission_key);
      const rows = await api(`/rest/v1/mission_files?select=filename,size_bytes,content_type,visible_to_head,visible_to_client,created_at&mission_id=eq.${m.id}&order=created_at.desc`);
      if (!rows.length) return `${m.key}: no files.`;
      return `${m.key} — files (${rows.length})\n` + rows.map((f) => {
        const vis = [f.visible_to_head && "head", f.visible_to_client && "client"].filter(Boolean).join("+") || "internal";
        return `  ${f.filename}  (${Math.max(1, Math.round(f.size_bytes / 1024))}KB · ${vis})`;
      }).join("\n");
    },
  },
  get_file: {
    description: "Get a temporary download link for a mission file, matched by filename (fuzzy). The link expires in 5 minutes.",
    schema: { type: "object", properties: { mission_key: { type: "string" }, filename: { type: "string" } }, required: ["mission_key", "filename"] },
    run: async (a) => {
      const m = await resolveMission(a.mission_key);
      const rows = await api(`/rest/v1/mission_files?select=filename,storage_path&mission_id=eq.${m.id}&filename=ilike.*${encodeURIComponent(a.filename)}*`);
      if (!rows.length) throw new Error(`No file matching "${a.filename}" on ${m.key}.`);
      if (rows.length > 1) throw new Error(`Several match: ${rows.map((r) => r.filename).join(", ")} — be more specific.`);
      const f = rows[0];
      const encPath = f.storage_path.split("/").map(encodeURIComponent).join("/");
      const signed = await api(`/storage/v1/object/sign/mission-files/${encPath}`, { method: "POST", body: JSON.stringify({ expiresIn: 300 }) });
      const url = signed && signed.signedURL ? `${URL_}/storage/v1${signed.signedURL}` : null;
      if (!url) throw new Error("Could not create a download link.");
      return `${f.filename} (expires in 5 min):\n${url}`;
    },
  },

  upload_file: {
    description: "Upload a local file to a mission. file_path is a path on the user's machine. By default the file is internal; set visible_to_head / visible_to_client to share it. Confirm the path with the user if unsure.",
    schema: { type: "object", properties: { mission_key: { type: "string" }, file_path: { type: "string" }, visible_to_head: { type: "boolean" }, visible_to_client: { type: "boolean" } }, required: ["mission_key", "file_path"] },
    run: async (a) => {
      const m = await resolveMission(a.mission_key); const conf = loadConf();
      let fp = a.file_path; if (fp.startsWith("~/")) fp = path.join(os.homedir(), fp.slice(2));
      let buf; try { buf = fs.readFileSync(fp); } catch { throw new Error(`Can't read file at "${a.file_path}".`); }
      const filename = path.basename(fp);
      const safe = filename.replace(/[^\w.\-]+/g, "_").slice(0, 120);
      const uniq = ((globalThis.crypto && globalThis.crypto.randomUUID && globalThis.crypto.randomUUID()) || String(Date.now())) + "-" + safe;
      const spath = `${m.id}/${uniq}`;
      const ext = (filename.split(".").pop() || "").toLowerCase();
      const CT = { csv: "text/csv", json: "application/json", pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", txt: "text/plain", md: "text/markdown", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", zip: "application/zip" };
      const contentType = CT[ext] || "application/octet-stream";
      const doUpload = async (tok) => fetch(`${URL_}/storage/v1/object/mission-files/${spath.split("/").map(encodeURIComponent).join("/")}`, { method: "POST", headers: { apikey: ANON, Authorization: `Bearer ${tok}`, "Content-Type": contentType, "x-upsert": "false" }, body: buf });
      let up = await doUpload(conf.access_token);
      if (up.status === 401 && conf.refresh_token && await refresh(conf)) up = await doUpload(loadConf().access_token);
      if (!up.ok) { let d = ""; try { d = (await up.json()).message || ""; } catch {} throw new Error(`Upload failed (HTTP ${up.status})${d ? ": " + d : ""}`); }
      try {
        await api(`/rest/v1/mission_files`, { method: "POST", body: JSON.stringify({ mission_id: m.id, filename, storage_path: spath, size_bytes: buf.length, content_type: contentType, uploaded_by: conf.user_id, visible_to_head: !!a.visible_to_head, visible_to_client: !!a.visible_to_client }) });
      } catch (e) { await fetch(`${URL_}/storage/v1/object/mission-files/${encodeURIComponent(spath)}`, { method: "DELETE", headers: { apikey: ANON, Authorization: `Bearer ${loadConf().access_token}` } }).catch(() => {}); throw e; }
      const vis = [a.visible_to_head && "head", a.visible_to_client && "client"].filter(Boolean).join("+") || "internal";
      return `Uploaded ${filename} to ${m.key} (${Math.max(1, Math.round(buf.length / 1024))}KB · ${vis}).`;
    },
  },

  // ── mission members ──
  add_collaborator: {
    description: "Add a teammate (by name) as a collaborator on a mission. Owner/admin only (enforced by permissions).",
    schema: { type: "object", properties: { mission_key: { type: "string" }, name: { type: "string" } }, required: ["mission_key", "name"] },
    run: async (a) => { const m = await resolveMission(a.mission_key); const p = await resolveAssignee(a.name); await api(`/rest/v1/mission_members`, { method: "POST", body: JSON.stringify({ mission_id: m.id, profile_id: p.id, role_on_mission: "collaborator" }) }); return `Added ${p.full_name} to ${m.key} as collaborator.`; },
  },
  request_access: {
    description: "Request access to a mission you're not a member of (by key). Notifies the owner.",
    schema: { type: "object", properties: { mission_key: { type: "string" } }, required: ["mission_key"] },
    run: async (a) => { const m = await resolveMission(a.mission_key); const conf = loadConf(); await api(`/rest/v1/mission_access_requests`, { method: "POST", body: JSON.stringify({ mission_id: m.id, requester_id: conf.user_id, status: "pending" }) }); return `Access requested for ${m.key}.`; },
  },

  // ── head requests (heads ask, admin/engineers see & reply) ──
  create_request: {
    description: "Create a request to the mission's engineer (used by heads of mission). kind: 'task' (do this), 'question', or 'meeting'. 'when' is free text like 'demain' or 'avant vendredi'. Lands in the engineer's inbox.",
    schema: { type: "object", properties: { mission_key: { type: "string" }, kind: { type: "string", enum: ["task", "question", "meeting"] }, title: { type: "string" }, body: { type: "string" }, when: { type: "string" } }, required: ["mission_key", "title"] },
    run: async (a) => {
      const m = await resolveMission(a.mission_key); const conf = loadConf();
      await api(`/rest/v1/head_asks`, { method: "POST", body: JSON.stringify({ mission_id: m.id, from_head_id: conf.user_id, kind: a.kind || "task", title: a.title, body: a.body || null, when_text: a.when || null }) });
      return `Request sent on ${m.key}: ${a.title}`;
    },
  },
  reply_request: {
    description: "Reply to an open head request on a mission, matched by a phrase in its title.",
    schema: { type: "object", properties: { mission_key: { type: "string" }, title_contains: { type: "string" }, text: { type: "string" } }, required: ["mission_key", "title_contains", "text"] },
    run: async (a) => {
      const m = await resolveMission(a.mission_key); const conf = loadConf();
      const asks = await api(`/rest/v1/head_asks?select=id,title&mission_id=eq.${m.id}&status=eq.open&title=ilike.*${encodeURIComponent(a.title_contains)}*`);
      if (!asks.length) throw new Error(`No open request on ${m.key} matching "${a.title_contains}".`);
      if (asks.length > 1) throw new Error(`Several match: ${asks.map((x) => x.title).join(" / ")}. Be more specific.`);
      await api(`/rest/v1/head_ask_replies`, { method: "POST", body: JSON.stringify({ ask_id: asks[0].id, author_id: conf.user_id, body: a.text }) });
      return `Replied to "${asks[0].title}".`;
    },
  },
  resolve_request: {
    description: "Mark an open head request resolved (matched by a phrase in its title).",
    schema: { type: "object", properties: { mission_key: { type: "string" }, title_contains: { type: "string" } }, required: ["mission_key", "title_contains"] },
    run: async (a) => {
      const m = await resolveMission(a.mission_key);
      const asks = await api(`/rest/v1/head_asks?select=id,title&mission_id=eq.${m.id}&status=eq.open&title=ilike.*${encodeURIComponent(a.title_contains)}*`);
      if (!asks.length) throw new Error(`No open request matching "${a.title_contains}".`);
      if (asks.length > 1) throw new Error(`Several match — be more specific.`);
      await api(`/rest/v1/head_asks?id=eq.${asks[0].id}`, { method: "PATCH", body: JSON.stringify({ status: "resolved", resolved_at: new Date().toISOString() }) });
      return `Resolved "${asks[0].title}".`;
    },
  },

  // ── time summary ──
  time_summary: {
    description: "This week's time: meeting hours (from calendar) vs production, extra hours logged, and the production ratio (target ≥ 66%).",
    schema: { type: "object", properties: {} },
    run: async () => {
      const conf = loadConf();
      const now = new Date(); const day = now.getDay() || 7; const mon = new Date(now); mon.setDate(now.getDate() - (day - 1)); mon.setHours(0, 0, 0, 0);
      const sun = new Date(mon); sun.setDate(mon.getDate() + 7);
      const cal = await api(`/functions/v1/gcal-events`, { method: "POST", body: JSON.stringify({ start: mon.toISOString(), end: sun.toISOString() }) });
      const events = (cal && cal.events) || cal || [];
      let meetingH = 0; for (const e of events) if (!e.all_day && (e.attendee_count || 0) > 0) meetingH += (new Date(e.end) - new Date(e.start)) / 36e5;
      meetingH = Math.round(meetingH * 2) / 2;
      const extras = await api(`/rest/v1/time_entries?select=hours&profile_id=eq.${conf.user_id}&source=eq.extra&entry_date=gte.${mon.toISOString().slice(0, 10)}`);
      const extraH = extras.reduce((s, e) => s + Number(e.hours), 0);
      const contract = 35; const prod = Math.max(0, contract - meetingH) + extraH;
      const ratio = Math.round((prod / (prod + meetingH)) * 100);
      return `This week: ${meetingH}h meetings · ${prod}h production${extraH ? " (incl. " + extraH + "h extra)" : ""}\n  ${ratio}% production ${ratio >= 66 ? "✓" : "(target ≥ 66%)"}`;
    },
  },

  // ── playbooks ──
  list_playbooks: {
    description: "List available playbooks (methodologies).",
    schema: { type: "object", properties: {} },
    run: async () => { const rows = await api(`/rest/v1/playbooks?select=title,description&order=title.asc`); return rows.length ? rows.map((p) => `  • ${p.title}${p.description ? " — " + p.description : ""}`).join("\n") : "No playbooks."; },
  },
  show_playbook: {
    description: "Show a playbook's steps by title (fuzzy match).",
    schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    run: async (a) => {
      const pbs = await api(`/rest/v1/playbooks?select=id,title,description&title=ilike.*${encodeURIComponent(a.title)}*`);
      if (!pbs.length) throw new Error(`No playbook matching "${a.title}".`);
      const p = pbs[0];
      const steps = await api(`/rest/v1/playbook_steps?select=position,title,tips&playbook_id=eq.${p.id}&order=position.asc`);
      return `${p.title}${p.description ? " — " + p.description : ""}\n` + steps.map((s, i) => `  ${i + 1}. ${s.title}${s.tips ? "  (tip: " + s.tips + ")" : ""}`).join("\n");
    },
  },
  apply_playbook: {
    description: "Apply a playbook to a mission — creates its steps as tasks in that mission. playbook by title (fuzzy), mission by key.",
    schema: { type: "object", properties: { playbook_title: { type: "string" }, mission_key: { type: "string" } }, required: ["playbook_title", "mission_key"] },
    run: async (a) => {
      const pbs = await api(`/rest/v1/playbooks?select=id,title&title=ilike.*${encodeURIComponent(a.playbook_title)}*`);
      if (!pbs.length) throw new Error(`No playbook matching "${a.playbook_title}".`);
      const p = pbs[0]; const m = await resolveMission(a.mission_key); const conf = loadConf();
      const steps = await api(`/rest/v1/playbook_steps?select=id,title,description,tips&playbook_id=eq.${p.id}&order=position.asc`);
      if (!steps.length) return `"${p.title}" has no steps.`;
      const reqs = await api(`/rest/v1/step_requirements?select=step_id,type,label,note&step_id=in.(${steps.map((s) => s.id).join(",")})`);
      const byStep = {}; for (const r of reqs) (byStep[r.step_id] = byStep[r.step_id] || []).push(r);
      const rows = steps.map((s) => {
        let desc = s.description || "";
        if (s.tips) desc += (desc ? "\n\n" : "") + "**Tips**\n" + s.tips;
        const rs = byStep[s.id] || []; if (rs.length) desc += (desc ? "\n\n" : "") + "**Prérequis**\n" + rs.map((r) => `- [${r.type}] ${r.label}${r.note ? " — " + r.note : ""}`).join("\n");
        return { mission_id: m.id, title: s.title, description: desc || null, status: "todo", source: "manual", is_client_visible: false, created_by: conf.user_id, tags: [`playbook:${p.id}`], playbook_step_id: s.id };
      });
      await api(`/rest/v1/tasks`, { method: "POST", body: JSON.stringify(rows) });
      return `Applied "${p.title}" to ${m.key} — created ${rows.length} tasks.`;
    },
  },

  // ── stack (tool registry) ──
  list_stack: {
    description: "List a tool stack, grouped by category. No argument → the global team stack (Bulldozer's own tools). With mission_key → that mission's customer stack (the tools the client uses).",
    schema: { type: "object", properties: { mission_key: { type: "string" } } },
    run: async (a) => {
      let filter = "mission_id=is.null", scope = "TEAM STACK", mission = false;
      if (a.mission_key) { const m = await resolveMission(a.mission_key); filter = `mission_id=eq.${m.id}`; scope = `${m.key} — ${m.name} · CUSTOMER STACK`; mission = true; }
      const rows = await api(`/rest/v1/stack_tools?select=id,name,category,description,visible_to_head,visible_to_client,monthly_cost,currency,billing_cycle&${filter}&order=category.asc,name.asc`);
      if (!rows.length) return `${scope}: empty.`;
      const credsByTool = {};
      if (a.with_credentials) {
        const cr = await api(`/rest/v1/stack_credentials?select=tool_id,label,kind,value,filled_at,url&tool_id=in.(${rows.map((t) => t.id).join(",")})&order=position.asc`).catch(() => []);
        for (const c of cr) (credsByTool[c.tool_id] = credsByTool[c.tool_id] || []).push(c);
      }
      const vis = (t) => { const v = []; if (t.visible_to_head) v.push("head"); if (t.visible_to_client) v.push("client"); return v.length ? ` [visible: ${v.join("+")}]` : ""; };
      const cost = (t) => (!mission && t.monthly_cost != null) ? ` — ${t.monthly_cost} ${t.currency || "EUR"}${t.billing_cycle ? "/" + t.billing_cycle : ""}` : "";
      const credLine = (c) => { const filled = c.value != null && String(c.value).trim() !== ""; return `      ${c.label} (${c.kind}): ${filled ? c.value + (c.url ? " [" + c.url + "]" : "") : "⏳ en attente client"}`; };
      const byCat = {}; for (const t of rows) (byCat[t.category] = byCat[t.category] || []).push(t);
      return `${scope}\n` + Object.entries(byCat).map(([c, ts]) => c.toUpperCase() + "\n" + ts.map((t) => `  • ${t.name}${mission ? vis(t) : cost(t)}${t.description ? " — " + t.description : ""}` + (a.with_credentials && credsByTool[t.id] ? "\n" + credsByTool[t.id].map(credLine).join("\n") : "")).join("\n")).join("\n\n");
    },
  },
  show_tool: {
    description: "Show a stack tool's full detail + credentials by name (fuzzy). No mission_key → global team stack; with mission_key → that mission's customer stack. Shows head/client visibility, who uses it, and each credential's fill status (filled value vs awaiting the client). Credentials are returned only if your role allows it (RLS: admin, or engineer assigned to that mission).",
    schema: { type: "object", properties: { name: { type: "string" }, mission_key: { type: "string" } }, required: ["name"] },
    run: async (a) => {
      let filter = "mission_id=is.null", scope = "team stack";
      if (a.mission_key) { const m = await resolveMission(a.mission_key); filter = `mission_id=eq.${m.id}`; scope = `${m.key} stack`; }
      const tools = await api(`/rest/v1/stack_tools?select=id,name,category,description,how_to_use,url,docs_url,visible_to_head,visible_to_client&name=ilike.*${encodeURIComponent(a.name)}*&${filter}`);
      if (!tools.length) throw new Error(`No tool matching "${a.name}" in the ${scope}.`);
      const t = tools[0];
      const creds = await api(`/rest/v1/stack_credentials?select=label,kind,value,instructions,filled_at,url&tool_id=eq.${t.id}&order=position.asc`).catch(() => []);
      const users = await api(`/rest/v1/stack_tool_users?select=user:profiles!profile_id(full_name)&tool_id=eq.${t.id}`).catch(() => []);
      const vis = []; if (t.visible_to_head) vis.push("head"); if (t.visible_to_client) vis.push("client");
      const people = users.map((u) => u.user && u.user.full_name).filter(Boolean);
      const cred = (c) => {
        const filled = c.value != null && String(c.value).trim() !== "";
        if (filled) return `  ${c.label} (${c.kind}): ${c.value}${c.url ? " [" + c.url + "]" : ""}${c.filled_at ? "  — rempli " + String(c.filled_at).slice(0, 10) : ""}`;
        return `  ${c.label} (${c.kind}): ⏳ en attente client${c.instructions ? "  — " + c.instructions : ""}`;
      };
      return `${t.name} [${t.category}]`
        + (t.description ? "\n  " + t.description : "")
        + (t.url ? "\n  URL: " + t.url : "")
        + (t.docs_url ? "\n  Docs: " + t.docs_url : "")
        + (vis.length ? "\n  Visible to: " + vis.join(", ") : "")
        + (people.length ? "\n  Utilisé par: " + people.join(", ") : "")
        + (t.how_to_use ? "\n\nHow to use:\n" + t.how_to_use : "")
        + (creds.length ? "\n\nCredentials:\n" + creds.map(cred).join("\n") : "");
    },
  },
  add_stack_tool: {
    description: "Add a tool to a stack. No mission_key → the global team stack (Bulldozer's own tools — you can set monthly_cost/billing_cycle/currency). With mission_key → that mission's customer stack. category: enrichment/outbound/crm/infra/ai/other. Requires admin, or an engineer assigned to the mission.",
    schema: { type: "object", properties: { mission_key: { type: "string" }, name: { type: "string" }, category: { type: "string", enum: ["enrichment", "outbound", "crm", "infra", "ai", "other"] }, url: { type: "string" }, description: { type: "string" }, docs_url: { type: "string" }, how_to_use: { type: "string" }, monthly_cost: { type: "number" }, billing_cycle: { type: "string", enum: ["monthly", "yearly", "one_time", "free"] }, currency: { type: "string" } }, required: ["name", "category"] },
    run: async (a) => {
      const conf = loadConf();
      const payload = { name: a.name, category: a.category, created_by: conf.user_id };
      let where = "team stack";
      if (a.mission_key) { const m = await resolveMission(a.mission_key); payload.mission_id = m.id; where = `${m.key} stack`; }
      if (a.url) { payload.url = a.url; try { payload.favicon_url = `https://www.google.com/s2/favicons?domain=${new URL(a.url).hostname}&sz=64`; } catch {} }
      if (a.description) payload.description = a.description;
      if (a.docs_url) payload.docs_url = a.docs_url;
      if (a.how_to_use) payload.how_to_use = a.how_to_use;
      if (a.monthly_cost != null) payload.monthly_cost = a.monthly_cost;
      if (a.billing_cycle) payload.billing_cycle = a.billing_cycle;
      if (a.currency) payload.currency = a.currency;
      await api(`/rest/v1/stack_tools`, { method: "POST", body: JSON.stringify(payload) });
      return `Added ${a.name} [${a.category}] to ${where}.`;
    },
  },
  add_stack_credential: {
    description: "Add a credential to a stack tool (found by name). No mission_key → searches the global team stack; with mission_key → that mission's stack. kind is api_key/login/password/workspace_url/token/other. Leave value empty on a mission tool to create a client-fill slot — set instructions. Requires admin, or an engineer on the mission.",
    schema: { type: "object", properties: { mission_key: { type: "string" }, tool_name: { type: "string" }, label: { type: "string" }, kind: { type: "string", enum: ["api_key", "login", "password", "workspace_url", "token", "other"] }, value: { type: "string" }, instructions: { type: "string" }, url: { type: "string" } }, required: ["tool_name", "label", "kind"] },
    run: async (a) => {
      let filter = "mission_id=is.null", where = "team stack";
      if (a.mission_key) { const m = await resolveMission(a.mission_key); filter = `mission_id=eq.${m.id}`; where = `${m.key} stack`; }
      const tools = await api(`/rest/v1/stack_tools?select=id,name&${filter}&name=ilike.*${encodeURIComponent(a.tool_name)}*`);
      if (!tools.length) throw new Error(`No tool matching "${a.tool_name}" in the ${where}.`);
      const t = tools[0];
      const payload = { tool_id: t.id, label: a.label, kind: a.kind, value: a.value || "" };
      if (a.instructions) payload.instructions = a.instructions;
      if (a.url) payload.url = a.url;
      await api(`/rest/v1/stack_credentials`, { method: "POST", body: JSON.stringify(payload) });
      return `Added credential "${a.label}" (${a.kind}) to ${t.name} in the ${where}${a.value ? "" : " — awaiting fill"}.`;
    },
  },

  // ── activity ──
  activity: {
    description: "Recent activity across missions (tasks created/completed/postponed/deleted, triage decisions), grouped by mission — the source for a weekly recap. Optional mission_key to scope; days sets the window (default 7).",
    schema: { type: "object", properties: { mission_key: { type: "string" }, days: { type: "number" } } },
    run: async (a) => {
      const days = a.days || 7; const since = new Date(Date.now() - days * 864e5).toISOString();
      let f = "";
      if (a.mission_key) { const m = await resolveMission(a.mission_key); f = `&mission_id=eq.${m.id}`; }
      const rows = await api(`/rest/v1/activities?select=action,created_at,meta,actor:profiles!actor_id(full_name),missions(key,name)&created_at=gte.${since}${f}&order=created_at.desc&limit=200`);
      if (!rows.length) return `No activity in the last ${days} day(s).`;
      const byM = {};
      for (const r of rows) { const k = r.missions ? r.missions.key : "—"; (byM[k] = byM[k] || []).push(r); }
      const label = (r) => `${String(r.created_at).slice(0, 10)}  ${String(r.action).replace(/_/g, " ")}${r.actor && r.actor.full_name ? " · " + r.actor.full_name : ""}${r.meta && r.meta.title ? " — " + r.meta.title : ""}`;
      return `Activity — last ${days}d (${rows.length})\n` + Object.entries(byM).map(([k, rs]) => `${k}\n` + rs.map((r) => "  " + label(r)).join("\n")).join("\n\n");
    },
  },

  // ── mission tools: Gantt & RACI ──
  list_mission_tools: {
    description: "List a mission's Gantt charts and RACI tables (with their client/head visibility).",
    schema: { type: "object", properties: { mission_key: { type: "string" } }, required: ["mission_key"] },
    run: async (a) => {
      const m = await resolveMission(a.mission_key);
      const rows = await api(`/rest/v1/mission_tools?select=kind,title,visible_to_client,editable_by_head&mission_id=eq.${m.id}&order=kind.asc,created_at.asc`);
      if (!rows.length) return `${m.key} — no Gantt/RACI tools yet. Create one with add_mission_tool.`;
      return `${m.key} — Outils\n` + rows.map((t) => `  [${t.kind.toUpperCase()}] ${t.title}${t.visible_to_client ? " · client" : ""}${t.editable_by_head ? " · head-edit" : ""}`).join("\n");
    },
  },
  show_mission_tool: {
    description: "Show a mission's Gantt or RACI by title (fuzzy) — renders the full matrix / timeline.",
    schema: { type: "object", properties: { mission_key: { type: "string" }, title: { type: "string" } }, required: ["mission_key", "title"] },
    run: async (a) => {
      const t = await resolveMissionTool(a.mission_key, a.title);
      const flags = `[${t.visible_to_client ? "client" : "internal"}${t.editable_by_head ? " · head-edit" : ""}]`;
      return t.kind === "raci" ? renderRaci(t, flags) : renderGantt(t, flags);
    },
  },
  add_mission_tool: {
    description: "Create a new Gantt chart or RACI table on a mission. kind is 'gantt' or 'raci'.",
    schema: { type: "object", properties: { mission_key: { type: "string" }, kind: { type: "string", enum: ["gantt", "raci"] }, title: { type: "string" } }, required: ["mission_key", "kind", "title"] },
    run: async (a) => {
      const m = await resolveMission(a.mission_key); const conf = loadConf();
      const data = a.kind === "raci" ? { columns: [], rows: [] } : { bars: [] };
      await api(`/rest/v1/mission_tools`, { method: "POST", body: JSON.stringify({ mission_id: m.id, kind: a.kind, title: a.title, data, created_by: conf.user_id }) });
      return `Created ${a.kind.toUpperCase()} "${a.title}" on ${m.key}.`;
    },
  },
  raci_set: {
    description: "Set a RACI cell: the role (R/A/C/I, or empty to clear) for a person on a deliverable. Auto-creates the deliverable row and/or the person column if missing — build the matrix incrementally by calling this repeatedly.",
    schema: { type: "object", properties: { mission_key: { type: "string" }, title: { type: "string" }, deliverable: { type: "string" }, person: { type: "string" }, role: { type: "string", enum: ["R", "A", "C", "I", ""] } }, required: ["mission_key", "title", "deliverable", "person", "role"] },
    run: async (a) => {
      const t = await resolveMissionTool(a.mission_key, a.title, "raci");
      const data = (t.data && t.data.columns) ? t.data : { columns: [], rows: [] };
      let col = data.columns.find((c) => (c.name || "").toLowerCase() === a.person.toLowerCase());
      if (!col) { col = { id: uuid(), name: a.person, role: "" }; data.columns.push(col); }
      let row = data.rows.find((r) => (r.deliverable || "").toLowerCase() === a.deliverable.toLowerCase());
      if (!row) { row = { id: uuid(), deliverable: a.deliverable, cells: {} }; data.rows.push(row); }
      if (a.role === "") delete row.cells[col.id]; else row.cells[col.id] = a.role;
      await api(`/rest/v1/mission_tools?id=eq.${t.id}`, { method: "PATCH", body: JSON.stringify({ data }) });
      return `${t.mission.key} · ${t.title}: ${a.deliverable} × ${a.person} = ${a.role || "(cleared)"}`;
    },
  },
  gantt_set_task: {
    description: "Add or update a Gantt task/bar by label. Dates YYYY-MM-DD; progress 0-100; depends_on is the label of another task in this chart (dependents auto-shift in the app UI).",
    schema: { type: "object", properties: { mission_key: { type: "string" }, title: { type: "string" }, label: { type: "string" }, start: { type: "string" }, end: { type: "string" }, progress: { type: "number" }, depends_on: { type: "string" } }, required: ["mission_key", "title", "label", "start", "end"] },
    run: async (a) => {
      const t = await resolveMissionTool(a.mission_key, a.title, "gantt");
      const data = (t.data && t.data.bars) ? t.data : { bars: [] };
      let bar = data.bars.find((b) => (b.label || "").toLowerCase() === a.label.toLowerCase());
      if (!bar) { bar = { id: uuid(), label: a.label, start: a.start, end: a.end, progress: a.progress || 0, deps: [] }; data.bars.push(bar); }
      else { bar.start = a.start; bar.end = a.end; if (a.progress != null) bar.progress = a.progress; }
      if (a.depends_on) { const dep = data.bars.find((b) => (b.label || "").toLowerCase() === a.depends_on.toLowerCase()); if (dep && dep.id !== bar.id && !bar.deps.includes(dep.id)) bar.deps.push(dep.id); }
      await api(`/rest/v1/mission_tools?id=eq.${t.id}`, { method: "PATCH", body: JSON.stringify({ data }) });
      return `${t.mission.key} · ${t.title}: ${a.label} ${a.start} → ${a.end} (${a.progress || 0}%)${a.depends_on ? " after " + a.depends_on : ""}`;
    },
  },
  set_tool_visibility: {
    description: "Toggle a mission tool's visibility: client (visible to the customer in the portal) and/or head_editable (the head of mission can edit it).",
    schema: { type: "object", properties: { mission_key: { type: "string" }, title: { type: "string" }, client: { type: "boolean" }, head_editable: { type: "boolean" } }, required: ["mission_key", "title"] },
    run: async (a) => {
      const t = await resolveMissionTool(a.mission_key, a.title);
      const patch = {}; if (a.client != null) patch.visible_to_client = a.client; if (a.head_editable != null) patch.editable_by_head = a.head_editable;
      if (!Object.keys(patch).length) throw new Error("Nothing to change — pass client and/or head_editable.");
      await api(`/rest/v1/mission_tools?id=eq.${t.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      return `${t.mission.key} · ${t.title}: ${Object.entries(patch).map(([k, v]) => k + "=" + v).join(", ")}`;
    },
  },
  delete_mission_tool: {
    description: "Delete a Gantt or RACI from a mission by title (fuzzy). Destructive — confirm the title with the user first.",
    schema: { type: "object", properties: { mission_key: { type: "string" }, title: { type: "string" } }, required: ["mission_key", "title"] },
    run: async (a) => {
      const t = await resolveMissionTool(a.mission_key, a.title);
      await api(`/rest/v1/mission_tools?id=eq.${t.id}`, { method: "DELETE" });
      return `Deleted ${t.kind.toUpperCase()} "${t.title}" from ${t.mission.key}.`;
    },
  },

  // ── improvements (internal idea log) ──
  log_improvement: {
    description: "Log an improvement idea / feedback for the tools or process.",
    schema: { type: "object", properties: { title: { type: "string" }, description: { type: "string" } }, required: ["title"] },
    run: async (a) => { const conf = loadConf(); await api(`/rest/v1/improvements`, { method: "POST", body: JSON.stringify({ author_id: conf.user_id, title: a.title, description: a.description || null, status: "open" }) }); return `Logged improvement: ${a.title}`; },
  },
  list_improvements: {
    description: "List logged improvement ideas.",
    schema: { type: "object", properties: {} },
    run: async () => { const rows = await api(`/rest/v1/improvements?select=title,status&order=created_at.desc&limit=30`); return rows.length ? rows.map((i) => `  [${i.status}] ${i.title}`).join("\n") : "No improvements logged."; },
  },

  // ── calendar write ──
  create_event: {
    description: "Create a Google Calendar event on your calendar. start/end are ISO datetimes (e.g. 2026-07-10T15:00:00). guests is an array of emails. Invitees are notified.",
    schema: { type: "object", properties: { title: { type: "string" }, start: { type: "string" }, end: { type: "string" }, guests: { type: "array", items: { type: "string" } }, description: { type: "string" }, meet: { type: "boolean" } }, required: ["title", "start", "end"] },
    run: async (a) => {
      const out = await api(`/functions/v1/gcal-write`, { method: "POST", body: JSON.stringify({ action: "create", title: a.title, start: a.start, end: a.end, guests: a.guests || [], description: a.description || "", meet: !!a.meet }) });
      return `Created event "${a.title}" (${a.start} → ${a.end})${a.guests && a.guests.length ? " with " + a.guests.length + " guests" : ""}.`;
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
      serverInfo: { name: "missions", version: "0.2.0" },
      instructions: [
        'This server ("missions") lets the user run their Bulldozer Missions app from the terminal — tasks, missions, inbox, calendar, playbooks, stack, time — everything scoped to the logged-in user\'s own permissions (row-level security; they can never do more than they can in the web app).',
        '',
        'MISSION CONTROL MODE — when the user says "let\'s work in mission control" (also "mission control", "on my missions", "travaillons dans mission control", "on bosse sur les missions"), in French or English:',
        '1. Open with a tight standup using the tools: open tasks due today or overdue (today), the pending inbox (inbox), and this week\'s meetings (upcoming_meetings). A few scannable lines — no preamble.',
        '2. Then act on whatever they ask, mapping plainly to the tools and confirming crisply. No command syntax — they just talk.',
        '3. Bulldozer energy: proactively flag overdue tasks, hot (critique) inbox items, and blocked tasks.',
        '',
        'Always reply in the user\'s language (French or English — match how they wrote). Destructive actions (delete_task) must always confirm the exact item with the user before executing.',
      ].join("\n"),
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
