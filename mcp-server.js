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
    description: "MY tasks due today or overdue (assigned to me). To see a whole mission's tasks incl. others' or unassigned work, use list_tasks by mission name.",
    schema: { type: "object", properties: {} },
    run: async () => {
      const conf = loadConf(); const today = new Date().toISOString().slice(0, 10);
      const rows = await api(`/rest/v1/tasks?select=number,title,status,due_date,priority,missions!inner(key)&status=neq.done&due_date=lte.${today}&assignee_id=eq.${conf.user_id}&order=due_date.asc`);
      if (!rows.length) return "Nothing assigned to you due today. (To see a mission's full board incl. unassigned work, ask for it by name.)";
      return `Your day (${rows.length} due/overdue):\n` + rows.map((t) => "  " + fmtTask({ ...t, missions: t.missions }, true)).join("\n");
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
      const heads = await api(`/rest/v1/head_asks?select=kind,title,when_text,missions:missions!head_asks_mission_id_fkey(key),head:profiles!head_asks_from_head_id_fkey(full_name)&status=eq.open&order=created_at.asc`).catch(() => []);
      const lines = [];
      if (reqs.length) lines.push("CLIENTS (à trier):\n" + reqs.map((t) => `  ${t.missions.key}-${t.number}  [${t.urgency || "normale"}${t.triage_status === "postponed" ? ", reporté" : ""}] ${t.title}`).join("\n"));
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
    description: "List the team's tool stack, grouped by category.",
    schema: { type: "object", properties: {} },
    run: async () => {
      const rows = await api(`/rest/v1/stack_tools?select=name,category,description&order=category.asc,name.asc`);
      if (!rows.length) return "Stack is empty.";
      const byCat = {}; for (const t of rows) (byCat[t.category] = byCat[t.category] || []).push(t);
      return Object.entries(byCat).map(([c, ts]) => c.toUpperCase() + "\n" + ts.map((t) => `  • ${t.name}${t.description ? " — " + t.description : ""}`).join("\n")).join("\n\n");
    },
  },
  show_tool: {
    description: "Show a stack tool's details and credentials by name (fuzzy). Credentials are visible to engineers/admin only (enforced by permissions).",
    schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    run: async (a) => {
      const tools = await api(`/rest/v1/stack_tools?select=id,name,category,description,how_to_use,url,docs_url&name=ilike.*${encodeURIComponent(a.name)}*`);
      if (!tools.length) throw new Error(`No tool matching "${a.name}".`);
      const t = tools[0];
      const creds = await api(`/rest/v1/stack_credentials?select=label,kind,value&tool_id=eq.${t.id}&order=position.asc`).catch(() => []);
      return `${t.name} [${t.category}]${t.description ? "\n  " + t.description : ""}${t.url ? "\n  URL: " + t.url : ""}${t.docs_url ? "\n  Docs: " + t.docs_url : ""}${t.how_to_use ? "\n\nHow to use:\n" + t.how_to_use : ""}${creds.length ? "\n\nCredentials:\n" + creds.map((c) => `  ${c.label} (${c.kind}): ${c.value}`).join("\n") : ""}`;
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
