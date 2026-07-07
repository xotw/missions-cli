# msn — Missions from the terminal

Zero-dependency CLI (Node ≥ 18) for the Missions app. Logs in as **you**; the app's RLS applies identically — you can only see and touch what your role allows.

## Install

```sh
gh api -H "Accept: application/vnd.github.raw" repos/xotw/missions-cli/contents/msn | sudo tee /usr/local/bin/msn > /dev/null && sudo chmod +x /usr/local/bin/msn
```

(or clone and `ln -s "$PWD/msn" /usr/local/bin/msn`)

## Use

```
msn login                 # once — your app email + password
msn today                 # open tasks due or overdue
msn ls TEL                # open tasks of a mission (--all includes done)
msn add TEL "Relancer Chloé" !1 #followup
msn start TEL-12          # → doing
msn done TEL-12           # → done
msn postpone TEL-3 +3d    # or monday, or 2026-07-15
msn whoami
```

Token auto-refreshes; config in `~/.config/msn/config.json` (chmod 600).
