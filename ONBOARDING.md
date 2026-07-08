# Missions — terminal & Claude Code access

Run your missions and tasks from the terminal, or just **talk to them inside Claude Code**. Two tools, one login, zero servers to run.

- **`msn`** — a command-line tool (`msn today`, `msn done TEL-3`, …).
- **`missions` MCP server** — the same actions as Claude Code tools, so you say *"mark TEL-3 done"* and it happens mid-session.

Both talk directly to the Missions database over HTTPS, authenticated as **you**. There is no extra account and no separate server — it's the same backend the web app uses.

---

## Is it secure? Can I do more than in the app?

**No — you can only ever do what your role already allows in the app, never more.** This is guaranteed by the database, not by trust:

- Logging in gives your machine *your own* access token — the same identity as your browser session.
- Every request carries that token. The database enforces **Row-Level Security** on every query, keyed to your identity — the exact same rules the web app runs against. The database can't tell a request came from the app vs. the terminal, and applies identical permissions either way.
- These tools use the **public key** only — never any admin/service key. They have no elevated powers of their own; your token defines what you can touch.

So an engineer sees engineer data, a head sees their missions, nobody sees anything their role can't. If the app says no, these tools get the same no.

---

## What you can do

In Claude Code, just talk (French or English — both work):

| You say | It does |
|---|---|
| "What's on for today?" | Your open tasks due today or overdue |
| "Show my tasks this week" | This week's tasks, by day |
| "What's assigned to me?" | Tasks assigned to you across missions |
| "List the Tellent tasks" | Open tasks of a mission (by key) |
| "List all my projects" | Every mission you can see, grouped |
| "Add a task to Modjo: rebuild the scoring query, high priority" | Creates the task |
| "Mark TEL-3 done" | Completes it |
| "Start TEL-4" | Moves it to *doing* |
| "Repousse MODJ-7 à lundi" | Postpones the due date |
| "Comment on TEL-4: waiting on Damien's CRM access — mark it a question" | Adds a comment; questions route to the admin inbox with your name |
| "Créé une mission client pour Acme Corp" | New project (client / internal / team) |
| "Log 2h extra on Tellent" | Logs extra hours (counted as production) |

The 11 tools behind these: `today · week · my_tasks · list_tasks · list_missions · add_task · complete_task · start_task · postpone_task · comment_task · new_mission · log_extra_hours`.

Prefer typing? The same actions exist as `msn` commands — run `msn` with no arguments to see them all.

---

## Install (5 minutes, once)

### Prerequisites
- **Node.js 18+** — check with `node --version`. (Install: `brew install node` on Mac.)
- **GitHub CLI** — check with `gh auth status`. (Install: `brew install gh`, then `gh auth login`.) Needed only to download the files from the private repo.
- **Claude Code** — for the conversational part.

### Steps

```sh
# 1. Download the CLI and the MCP server
mkdir -p ~/.config/msn
gh api -H "Accept: application/vnd.github.raw" repos/xotw/missions-cli/contents/msn         | sudo tee /usr/local/bin/msn > /dev/null && sudo chmod +x /usr/local/bin/msn
gh api -H "Accept: application/vnd.github.raw" repos/xotw/missions-cli/contents/mcp-server.js > ~/.config/msn/mcp-server.js

# 2. Log in with your Missions app email + password (creates your own session)
msn login your-email@bulldozer-collective.com

# 3. Register the MCP server with Claude Code (global, all sessions)
claude mcp add --scope user missions -- node ~/.config/msn/mcp-server.js
```

Then **restart Claude Code** (MCP tools load at session start) and try: *"what's on for today?"*

Verify anytime with `claude mcp list` — you should see `missions … ✔ Connected`.

### Install by handing this to Claude Code
You can also paste this into a Claude Code session and let it run the install for you:

> Install the Missions CLI and MCP server by following the "Install" steps in this document: download `msn` to `/usr/local/bin`, download `mcp-server.js` to `~/.config/msn/`, then register the MCP server with `claude mcp add --scope user missions -- node ~/.config/msn/mcp-server.js`. Stop before the login step and tell me to run `msn login` myself (it needs my password).

---

## Day to day

- Your login **persists** — across terminal windows, tabs, and reboots. You log in once; the token auto-refreshes. You only re-login if you go a very long time without using it.
- The CLI and MCP **share the same login** — `msn login` once and both work.
- Everything you do shows up in the web app instantly (it's the same database — no sync), and vice-versa.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Not logged in` | Run `msn login your-email@…` |
| `Session expired` | Run `msn login …` again |
| `Login failed — invalid_credentials` | Wrong email or password. Use the **exact** email you log into the web app with. |
| MCP tools don't appear in Claude Code | Restart Claude Code; check `claude mcp list` shows `✔ Connected` |
| `No mission "XYZ"` | Wrong mission key, or your role can't see that mission (expected — RLS) |
| `command not found: gh` | Install GitHub CLI: `brew install gh` then `gh auth login` |

---

## How it works (for the curious)

There's no "missions server" running anywhere. `msn` and `mcp-server.js` are each a single script file on your machine. When you run a command, the script sends an HTTPS request straight to the Missions **database** (Supabase) — the same database the web app reads from — carrying your login token. The database checks your permissions (RLS) and answers. The web app, the CLI, and the MCP server are three different remote controls for the same database; none is "in front of" the others, and all obey the same rules.
