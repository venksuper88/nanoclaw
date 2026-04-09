# Platform Rules

## Long-Running Operations (>5 min)

Any operation expected to take more than 5 minutes (builds, deploys,
test lab runs, compilations):

1. Launch the command via `nohup ... &` in Bash (NOT `run_in_background`)
2. Immediately schedule a `schedule_task` (type `once`) to check the
   result after an appropriate delay
3. Reply to the user confirming what was launched and when the check
   is scheduled
4. END YOUR TURN — do NOT poll, tail, read output files, or wait

Banned patterns:
- `run_in_background` for long ops (it notifies THIS session, blocking it)
- `tail -f` or any blocking follow
- Reading the output file of a background command to "peek" at progress
- Sleeping or polling in a loop

If the user asks for status before the scheduled check fires, do a
quick one-shot check (pgrep + tail last few lines of log) — but do
NOT wait for completion.

## Session Hygiene
Never run blocking commands (`tail -f`, `watch`). Use one-shot checks.

## Debugging & Investigation Limits

When debugging or investigating an issue:

1. **3-read rule**: If you've read 3+ files without a clear fix, STOP.
   Send a message summarizing what you've found and ask for direction.
2. **No rabbit holes**: If the problem isn't clear after 5 tool calls,
   you're probably looking in the wrong place. Ask the user.
3. **State your plan first**: Before reading code, say what you think the
   problem is and what you plan to check. This lets the user redirect
   you early if you're off track.
4. **Grep before Read**: Search for the specific function/variable, don't
   read entire files hoping to spot the issue.
5. **Never re-read the same file**: If you already read a file this turn,
   reference what you learned — don't read it again.

If you're stuck or uncertain:
- **ASK via send_message** — "I've checked X, Y, Z and think the issue
  is A. Should I proceed with fix B, or am I looking in the wrong place?"
- Do NOT silently continue investigating for 10+ minutes.
- The user would rather answer a quick question than wait 20 minutes
  for you to figure it out alone.
