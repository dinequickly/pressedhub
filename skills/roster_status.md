# Roster Status

You have a card on the user's Roster page that shows your current status at a glance. Keep it updated so the user always knows what you're doing and what, if anything, you need from them.

## The tool

```
set_roster_status(tone, summary, label?, cta?, file_name?)
```

Call this whenever your status meaningfully changes. You can call it multiple times in one session.

## Fields

**tone** — controls the card's visual style:
- `running` — you are actively working right now
- `ok` — you finished or produced something ready to review
- `warn` — you need the user's input or attention before you can continue
- `idle` — you are done and standing by, nothing needed

**summary** — one plain sentence shown as the card body. Write it to the user, not about yourself. "Found 3 pricing gaps in the Q2 deck." not "Agent completed analysis of Q2 pricing deck."

**label** — short uppercase stamp shown on the card (≤18 chars). Optional but recommended. Examples: `ON IT`, `DONE`, `REVIEW DOC`, `WANTS CHAT`, `WAITING`, `BLOCKED`.

**cta** — hint for what the user should do next:
- `open_chat` — directs them to reply to you in chat
- `open_files` — directs them to open a file you produced
- `none` — purely informational, no action needed

**file_name** — name of a specific file when asking them to review something (e.g. `Q2_Analysis.xlsx`).

## When to call it

- **At the start of work**: set `tone: "running"`, `label: "ON IT"`, and a one-line description of what you're doing.
- **When you finish**: set `tone: "ok"`, `label: "DONE"`, and describe the outcome. If you produced a file, set `cta: "open_files"` and `file_name`.
- **When you're blocked**: set `tone: "warn"`, `label: "WANTS CHAT"` or `"BLOCKED"`, and state exactly what you need in the summary. Set `cta: "open_chat"`.
- **When you need a decision**: same as blocked — `tone: "warn"`, `cta: "open_chat"`, summary should be the specific question.
- **When going idle**: set `tone: "idle"`, `label: "STANDING BY"` if there's nothing to report.

## Examples

Starting a scheduled research task:
```
set_roster_status(
  tone="running",
  label="ON IT",
  summary="Pulling this week's competitor pricing and building the comparison table."
)
```

Finished and produced a file:
```
set_roster_status(
  tone="ok",
  label="REVIEW DOC",
  summary="Competitor pricing comparison is ready — 6 gaps flagged for Q3.",
  cta="open_files",
  file_name="Competitor_Pricing_Q3.xlsx"
)
```

Needs user input:
```
set_roster_status(
  tone="warn",
  label="WANTS CHAT",
  summary="Should I include the EU market in this analysis or keep it US-only?",
  cta="open_chat"
)
```

All done, nothing needed:
```
set_roster_status(
  tone="ok",
  label="DONE",
  summary="Weekly digest sent. Next run scheduled for Monday.",
  cta="none"
)
```

## Rules of thumb

- Always call it at least once before your session ends so the card doesn't just show the last raw message.
- Prefer `warn` over `ok` when you want the user to actually look at something — it makes the card highlighted and the action button prominent.
- Keep summaries under 150 characters so they don't get clipped on the card.
- Don't set `tone: "running"` as your final status — it will show a spinner permanently.
