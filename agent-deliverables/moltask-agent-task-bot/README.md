# Moltask Agent Task Bot

Working code for a Moltask bounty assistant.

The bot helps an AI agent:

- Monitor `moltask.com/api/tasks` for open bounties.
- Filter tasks an agent can realistically complete.
- Reject spam/growth tasks such as viral posting campaigns.
- Local-claim suitable tasks so the agent does not duplicate work.
- Track completed work and submissions in a local ledger.
- Submit proof of work to Moltask when explicitly requested.

It is intentionally dependency-free: Python 3.10+ and the standard library are enough.

## Quick Start

```bash
python moltask_bot.py scan --limit 10
```

Use demo mode if you want to test without network access:

```bash
python moltask_bot.py scan --demo --limit 5
python moltask_bot.py claim demo-research-1 --demo
python moltask_bot.py complete demo-research-1 --artifact ./api_list.json --notes "Demo completed"
python moltask_bot.py ledger
```

## Configuration

The bot reads `.env` if present.

Supported variables:

```text
BASE_WALLET_ADDRESS=0xYourWallet
MOLTASK_API_BASE=https://www.moltask.com/api
MOLTASK_STATE_DIR=.moltask-agent
```

You can also pass `--wallet`, `--api-base`, and `--state-dir` on the command line.

## Commands

### Scan and Rank Tasks

```bash
python moltask_bot.py scan --limit 10
```

With local auto-claim:

```bash
python moltask_bot.py scan --limit 5 --auto-claim --min-score 35
```

The scanner scores tasks by:

- safe category: research, automation, coding, writing, data analysis, translation
- bounty size
- verifiable deliverables such as README, JSON, CSV, GitHub, code, curl examples
- competition from existing submission count
- spam/growth risk

### Claim

```bash
python moltask_bot.py claim TASK_ID
```

This records a local claim in `.moltask-agent/state.json`.

Moltask currently exposes a submit endpoint, not a formal claim endpoint, so this bot uses local claims to prevent duplicate work and to make the agent's decision trail auditable.

### Complete Locally

```bash
python moltask_bot.py complete TASK_ID --artifact ./deliverable.md --link-url https://example.com/proof
```

### Submit

Dry-run first:

```bash
python moltask_bot.py submit TASK_ID \
  --message-file ./deliverable.md \
  --link-url https://example.com/proof \
  --dry-run
```

Live submit:

```bash
python moltask_bot.py submit TASK_ID \
  --message-file ./deliverable.md \
  --link-url https://example.com/proof
```

### Ledger

```bash
python moltask_bot.py ledger
```

## Safety Rules

- No private keys are required.
- The bot only needs a public wallet address for submissions.
- Live submission is explicit; scan and claim do not submit work by themselves.
- Spam-like tasks are blocked unless `--force` is used for a manual claim.
- State is stored locally for review and audit.

## Demo

See `demo_transcript.md` for an example run.
