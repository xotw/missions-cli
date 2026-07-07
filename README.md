# msn — Missions from the terminal

Zero-dependency CLI (Node ≥ 18) for the Missions app. Logs in as **you**; the app's RLS applies identically — you can only see and touch what your role allows.

## Install
```sh
gh api -H "Accept: application/vnd.github.raw" repos/xotw/missions-cli/contents/msn | sudo tee /usr/local/bin/msn > /dev/null && sudo chmod +x /usr/local/bin/msn
```

## Commands
```
# Tasks
msn today                        open tasks due/overdue
msn week                         this week's tasks by day
msn mine                         tasks assigned to me
msn ls <KEY> [--all]             a mission's tasks
msn add <KEY> "title" [!1] [#tag]
msn start|done <KEY-n>           set doing / done
msn postpone <KEY-n> +3d|monday|YYYY-MM-DD
msn comment <KEY-n> "text" [--question]

# Missions
msn missions                     all projects, grouped by kind
msn new <client|internal|team> "Name" [KEY]

# Time
msn extra <hours> [KEY] "note"   log extra hours (always production)

# Account
msn login [email] · msn whoami
```

Token auto-refreshes; config in `~/.config/msn/config.json` (chmod 600). Everything runs through Supabase REST under your JWT — same permissions as the web app.
