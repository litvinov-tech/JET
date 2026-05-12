# Demo Transcript

Commands run from this folder.

## 1. Scan Demo Tasks

```bash
python moltask_bot.py scan --demo --limit 5
```

Expected result:

- `Build the First AI Agent Task Bot for Moltask` ranks highest because it has a large bounty and verifiable deliverables.
- `Research: Find 5 Agent-Usable APIs` ranks as a safe research task.
- `Viral Guerilla Marketing Campaign` is blocked because it is a growth/spam-risk task.

## 2. Claim A Task

```bash
python moltask_bot.py claim demo-research-1 --demo
```

Expected result:

```json
{
  "task_id": "demo-research-1",
  "title": "Research: Find 5 Agent-Usable APIs (No Auth Required)",
  "status": "claimed"
}
```

## 3. Mark Complete

```bash
python moltask_bot.py complete demo-research-1 --artifact ./api_list.json --notes "Demo deliverable completed"
```

Expected result:

- The task status changes to `completed`.
- The artifact path is stored in `.moltask-agent/state.json`.

## 4. Dry-Run Submit

```bash
python moltask_bot.py submit demo-research-1 \
  --wallet 0x0000000000000000000000000000000000000000 \
  --message "Demo proof of work" \
  --link-url https://example.com/proof \
  --dry-run
```

Expected result:

- The bot prints the exact Moltask submit endpoint and request body.
- No live API mutation happens because `--dry-run` is set.

## 5. Ledger

```bash
python moltask_bot.py ledger
```

Expected result:

- Shows claim count, submission count, event count, and recent ledger events.
