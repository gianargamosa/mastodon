# Mastodon

**Mastodon** (`mas`, for **m**ultiple **a**gent **s**essions) runs several coding agents (Claude Code, Codex, Gemini CLI) — or anything else
that runs in a terminal — side by side in one window. A sidebar lists every
session, and the main pane shows the selected one, so you can have an agent
working on each website and hop between them.

```
 mas                3 sessions │ ✻ Updating header nav…
───────────────────────────────│
 ● shop                        │   src/components/Header.tsx
   working 40% · claude        │   …
                               │
 ◉ blog                        │
   blocked · claude            │
                               │
 ○ dev                         │
   npm                         │
```

The command is `mas`; Mastodon is the project's name.

## Install

You need:

- Node 18 or newer
- whichever agent CLIs you want to run (`claude`, `codex`, `gemini`); anything
  else on your PATH works too

```sh
npm i -g mas-term        # puts `mas` on your PATH
mas --install-shortcuts  # adds mas:claude, mas:codex, mas:gemini, mas:shell
mas --help               # check it's installed
```

Or from a clone of this repo: `npm install`, then `npm link` instead of the
first line.

`--install-shortcuts` links one `mas:<agent>` per configured agent next to `mas`.
(npm can’t do this itself: it would install a `mas:claude` bin as plain `claude`
and clobber the real one.) Re-run it after adding agents to your config. To put
the shortcuts somewhere else, pass a folder: `mas --install-shortcuts ~/bin`.

To try it without installing anything globally, run `npm start` (same as
`node bin/mas.js`) from the project folder.

To uninstall, run `npm uninstall -g mas-term` (or `npm unlink -g mas-term` for
a linked clone) and delete the
`mas:<agent>` links it made next to `mas`.

## Use

### Quick start

1. `cd` into a project and run `mas:claude`. Mastodon opens with Claude Code in
   that folder.
2. Press `Ctrl+]` to jump to the sidebar, then `n` to add another session: pick
   an agent (or type any command), a folder and a name.
3. Use `↑` `↓` to switch between sessions and `⏎` to go back into one. The
   sidebar shows which ones are working, waiting for you, or done.
4. Press `q` in the sidebar to quit.

### Commands

```sh
mas:claude                                  # Claude in this folder
mas:codex --model o4                        # extra args go to the agent
mas                                         # empty sidebar, press n
mas claude:~/sites/shop codex:~/sites/blog  # several at once (agent:dir:name)
mas claude:. -- npm run dev                 # any command after --
mas htop:.                                  # any command on your PATH
mas --close shop                            # close the "shop" session (several names ok)
mas --tab work --close shop                 # … in the "work" window
```

`--close` takes session names as the sidebar shows them; quote names with
spaces (`mas --close "shop:claude 2"`). If any name doesn't match, nothing is
closed and mas lists the open sessions.

### Keys

| Where   | Key                    | Does                                  |
| ------- | ---------------------- | ------------------------------------- |
| anywhere| `Ctrl+]`               | toggle between session and sidebar    |
| sidebar | `↑` `↓` / `j` `k`      | switch session (shows it immediately) |
| sidebar | `1`–`9`                | jump into session N                   |
| sidebar | `⏎` / `esc`            | back into the session                 |
| sidebar | `n`                    | new session (agent or any command → folder → name) |
| sidebar | `r` / `x`              | restart / kill session (after `x`, `1`–`9` picks another session to kill) |
| sidebar | click `×`              | kill that session (asks first)        |
| sidebar | `q`                    | quit (asks first if anything runs)    |
| session | mouse wheel, `Shift+PgUp/PgDn` | scroll back through output   |
| session | drag                   | select and copy text                  |
| anywhere| click                  | focus the pane, or pick a session in the sidebar |

To copy text, drag over it in the pane: mas highlights it and copies it when you
let go, without the sidebar, and joins lines the program wrapped back together.
It sets the clipboard through your terminal (OSC 52) and through `pbcopy` on
macOS (`wl-copy` or `xclip` on Linux). A program that uses the mouse itself
gets the drag instead; there, hold Shift (Option in iTerm2 and Terminal on
macOS) to use your terminal's own selection.

### One window for everything

The first `mas` you start becomes home base. Running `mas:claude`, `mas:codex`,
`mas <agent>:<dir>` or `mas -- <command>` from any other tab or folder adds the
session to that window and exits, so everything collects in one place. The new
session uses the environment of the tab you ran it from (PATH, nvm, env vars).
`mas --new …` starts a separate window instead. The running instance listens on
a socket in your temp folder (`$MAS_SOCKET` to override).

### Several windows, grouped by name

Give a window a name with `--tab` and it becomes home base for that name only,
so you can keep one window per project or client:

```sh
mas --tab work                         # in one tab
mas --tab personal                     # in another
mas:claude --tab work                  # from anywhere: lands in "work"
mas --tab personal codex:~/sites/blog  # lands in "personal"
```

`--tab <name>` (or `-t <name>`, `--tab=<name>`) goes before any agent arguments.
If no mas with that name is running yet, it starts one. The name shows in the
sidebar header and the window title. Sessions inside a named window get
`MAS_TAB=<name>`, so `mas:claude` run from one of their shells joins the same
window. Set `MAS_TAB` yourself to give a terminal tab a default. Without a name
you get the default window, as before.

## Status (OSC 7501)

Programs that speak the [Program Status Protocol (OSC 7501)](https://www.superlogical.com/rex/docs/build/program-status)
report their own state, and the sidebar shows it:

| Report    | Sidebar                                                    |
| --------- | ---------------------------------------------------------- |
| `working` | ● yellow, `working`, with `progress` as a percentage if sent |
| `blocked` | ◉ red, `blocked`                                           |
| `done`    | ● teal, `done` — stays until you go back and press a key   |
| `error`   | ● red, `error` — same                                      |
| `idle`    | ○ green, `idle`                                            |

Each entry shows the session name, then `state · agent`. The selected session
is highlighted. The terminal bell rings (at most every 3 s) when a session
you’re not looking at becomes blocked, done or errors.

mas answers the protocol’s detection query, so agents that only report after
the probe (Claude Code does this) light up. Anything that doesn’t speak it still
runs normally, just without a status. Only **○ exited** is shown for it.
mas follows spec revision 0.4: records per `id` with `clear` subtrees, working
and blocked records dropped on exit or a new shell prompt (OSC 133;A), and
malformed or oversized reports ignored.

Try it without spending tokens: `mas -- node examples/status-demo.js`, then press
`Ctrl+]` and switch to another session to watch the badge go working → needs
permission → done.

## Config

Optional JSON, merged in order: `~/.config/mas/config.json`, then
`./mas.config.json`. Add your own agents and sessions to start every time:

```json
{
  "bell": true,
  "agents": {
    "claude-yolo": { "command": "claude", "args": ["--dangerously-skip-permissions"], "label": "Claude (no prompts)" },
    "aider": { "command": "aider", "args": ["--model", "sonnet"] }
  },
  "sessions": [
    { "agent": "claude", "cwd": "~/sites/shop", "name": "shop" },
    { "agent": "shell", "cwd": "~/sites/shop", "name": "shop:dev" }
  ]
}
```

## How it works

Each session is a real pseudo-terminal (`node-pty`) whose output feeds a headless
xterm (`@xterm/headless`). The app redraws the selected session's screen into the
pane, changing only the rows that differ (when new output scrolls the pane, it
has your terminal scroll and paints just the new rows), and forwards your
keystrokes to it.
Frames are drawn as soon as something changes (capped at ~60 a second), sent
with synchronized output so they paint in one go, and held back while the
program is partway through a frame of its own (mode 2026). The
headless terminal also answers the agent's terminal queries, so background
sessions keep running normally while you're looking at another one.
