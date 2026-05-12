#!/usr/bin/env python3
"""
Moltask Agent Task Bot

Small standard-library bot for scanning Moltask bounties, filtering tasks an
agent can realistically complete, recording local claims, and submitting proof
of work when explicitly requested.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_API_BASE = "https://www.moltask.com/api"
DEFAULT_STATE_DIR = ".moltask-agent"
DEFAULT_WALLET_ENV = "BASE_WALLET_ADDRESS"
SAFE_CATEGORIES = {
    "automation",
    "content_writing",
    "coding",
    "code",
    "data_analysis",
    "research",
    "translation",
    "writing",
}
BLOCKED_KEYWORDS = {
    "viral",
    "guerilla",
    "spam",
    "first to let the world know",
    "test ask",
    "automated test",
}


DEMO_TASKS = [
    {
        "id": "demo-research-1",
        "title": "Research: Find 5 Agent-Usable APIs (No Auth Required)",
        "description": "Find and document 5 useful APIs that agents can call without authentication.",
        "category": "research",
        "bounty_amount": "1500",
        "requirements": ["API testing", "Documentation skills"],
        "deliverables": ["api_list.json", "examples.sh", "README.md"],
        "created_at": "2026-05-12T00:00:00Z",
    },
    {
        "id": "demo-bot-1",
        "title": "Build the First AI Agent Task Bot for Moltask",
        "description": "Create a working bot that helps AI agents earn MOLT.",
        "category": "automation",
        "bounty_amount": "7500",
        "requirements": ["Working code", "README with setup", "Open source on GitHub", "Demo"],
        "deliverables": ["GitHub repository", "Documentation", "Demo"],
        "created_at": "2026-05-12T00:00:00Z",
    },
    {
        "id": "demo-spam-1",
        "title": "Viral Guerilla Marketing Campaign for Moltask",
        "description": "Post everywhere and collect engagement.",
        "category": "other",
        "bounty_amount": "3000",
        "requirements": ["10+ posts", "screenshots"],
        "deliverables": ["engagement_report.md"],
        "created_at": "2026-05-12T00:00:00Z",
    },
]


@dataclass
class Settings:
    api_base: str
    wallet: str
    state_dir: Path
    timeout: int = 30


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load_env_file(path: Path = Path(".env")) -> None:
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def make_settings(args: argparse.Namespace) -> Settings:
    load_env_file()
    wallet = args.wallet or os.environ.get(DEFAULT_WALLET_ENV, "")
    return Settings(
        api_base=(args.api_base or os.environ.get("MOLTASK_API_BASE") or DEFAULT_API_BASE).rstrip("/"),
        wallet=wallet,
        state_dir=Path(args.state_dir or os.environ.get("MOLTASK_STATE_DIR") or DEFAULT_STATE_DIR),
        timeout=int(args.timeout or 30),
    )


def http_json(method: str, url: str, body: dict[str, Any] | None = None, timeout: int = 30) -> Any:
    data = None
    headers = {"Accept": "application/json", "User-Agent": "moltask-agent-task-bot/0.1"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code} {url}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Network error for {url}: {exc}") from exc


def ensure_state(settings: Settings) -> dict[str, Any]:
    settings.state_dir.mkdir(parents=True, exist_ok=True)
    state_path = settings.state_dir / "state.json"
    if not state_path.exists():
        state = {"claims": {}, "submissions": {}, "ledger": [], "created_at": utc_now()}
        save_state(settings, state)
        return state
    return json.loads(state_path.read_text(encoding="utf-8"))


def save_state(settings: Settings, state: dict[str, Any]) -> None:
    settings.state_dir.mkdir(parents=True, exist_ok=True)
    tmp = settings.state_dir / "state.json.tmp"
    tmp.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")
    tmp.replace(settings.state_dir / "state.json")


def fetch_tasks(settings: Settings, demo: bool = False) -> list[dict[str, Any]]:
    if demo:
        return DEMO_TASKS
    url = f"{settings.api_base}/tasks?status=open"
    data = http_json("GET", url, timeout=settings.timeout)
    tasks = data.get("tasks") if isinstance(data, dict) else data
    if not isinstance(tasks, list):
        raise RuntimeError(f"Unexpected tasks response: {data!r}")
    return tasks


def fetch_submission_count(settings: Settings, task_id: str) -> int | None:
    try:
        data = http_json("GET", f"{settings.api_base}/tasks/{task_id}/submissions", timeout=settings.timeout)
    except RuntimeError:
        return None
    if isinstance(data, dict):
        count = data.get("count")
        if isinstance(count, int):
            return count
        submissions = data.get("submissions")
        if isinstance(submissions, list):
            return len(submissions)
    return None


def task_text(task: dict[str, Any]) -> str:
    fields = [task.get("title"), task.get("description"), task.get("category")]
    return " ".join(str(x or "") for x in fields).lower()


def score_task(task: dict[str, Any], submission_count: int | None = None) -> dict[str, Any]:
    text = task_text(task)
    category = str(task.get("category") or "").lower()
    bounty = float(task.get("bounty_amount") or task.get("bounty") or 0)
    reasons: list[str] = []
    score = 0
    blocked = False

    if any(word in text for word in BLOCKED_KEYWORDS):
        blocked = True
        reasons.append("blocked_keyword_or_spam_growth")

    if category in SAFE_CATEGORIES:
        score += 20
        reasons.append("safe_category")
    else:
        score -= 15
        reasons.append("weak_category")

    if bounty >= 5000:
        score += 35
        reasons.append("large_bounty")
    elif bounty >= 1500:
        score += 22
        reasons.append("medium_bounty")
    elif bounty >= 500:
        score += 12
        reasons.append("small_bounty")

    deliverables = " ".join(str(x) for x in task.get("deliverables") or [])
    requirements = " ".join(str(x) for x in task.get("requirements") or [])
    if any(token in (deliverables + requirements).lower() for token in ["readme", "json", "csv", "github", "code", "curl"]):
        score += 15
        reasons.append("verifiable_artifact")

    if submission_count is not None:
        if submission_count == 0:
            score += 15
            reasons.append("no_competition")
        elif submission_count < 10:
            score += 5
            reasons.append("low_competition")
        elif submission_count > 30:
            score -= 18
            reasons.append("crowded")

    if blocked:
        score = min(score, -50)

    return {
        "id": task.get("id"),
        "title": task.get("title"),
        "category": task.get("category"),
        "bounty_amount": bounty,
        "score": score,
        "blocked": blocked,
        "submission_count": submission_count,
        "reasons": reasons,
    }


def cmd_scan(args: argparse.Namespace) -> int:
    settings = make_settings(args)
    tasks = fetch_tasks(settings, demo=args.demo)
    rows = []
    for task in tasks:
        count = None if args.no_submission_counts or args.demo else fetch_submission_count(settings, str(task.get("id")))
        rows.append(score_task(task, count))
    rows.sort(key=lambda item: item["score"], reverse=True)
    if args.auto_claim:
        state = ensure_state(settings)
        for row in rows:
            if row["score"] >= args.min_score and not row["blocked"]:
                state["claims"].setdefault(row["id"], {
                    "task_id": row["id"],
                    "title": row["title"],
                    "claimed_at": utc_now(),
                    "score": row["score"],
                    "status": "claimed",
                })
        save_state(settings, state)
    print(json.dumps(rows[: args.limit], indent=2, ensure_ascii=False))
    return 0


def cmd_claim(args: argparse.Namespace) -> int:
    settings = make_settings(args)
    state = ensure_state(settings)
    tasks = fetch_tasks(settings, demo=args.demo)
    task = next((item for item in tasks if str(item.get("id")) == args.task_id), None)
    if not task:
        raise SystemExit(f"Task not found: {args.task_id}")
    row = score_task(task, None)
    if row["blocked"] and not args.force:
        raise SystemExit(f"Refusing blocked/spam-like task: {row['reasons']}")
    state["claims"][args.task_id] = {
        "task_id": args.task_id,
        "title": task.get("title"),
        "claimed_at": utc_now(),
        "score": row["score"],
        "status": "claimed",
    }
    state["ledger"].append({"time": utc_now(), "event": "claim", "task_id": args.task_id, "score": row["score"]})
    save_state(settings, state)
    print(json.dumps(state["claims"][args.task_id], indent=2))
    return 0


def cmd_complete(args: argparse.Namespace) -> int:
    settings = make_settings(args)
    state = ensure_state(settings)
    claim = state["claims"].setdefault(args.task_id, {"task_id": args.task_id, "claimed_at": utc_now()})
    claim.update({
        "status": "completed",
        "completed_at": utc_now(),
        "artifact": args.artifact,
        "link_url": args.link_url,
        "notes": args.notes,
    })
    state["ledger"].append({"time": utc_now(), "event": "complete", "task_id": args.task_id, "artifact": args.artifact})
    save_state(settings, state)
    print(json.dumps(claim, indent=2))
    return 0


def cmd_submit(args: argparse.Namespace) -> int:
    settings = make_settings(args)
    if not settings.wallet:
        raise SystemExit(f"Missing wallet. Set {DEFAULT_WALLET_ENV} or pass --wallet.")
    message = args.message
    if args.message_file:
        message = Path(args.message_file).read_text(encoding="utf-8")
    if not message:
        raise SystemExit("Submission message is required.")
    body = {
        "worker_address": settings.wallet,
        "message": message[:5000],
        "link_url": args.link_url,
        "link_type": args.link_type,
    }
    if args.dry_run:
        print(json.dumps({"dry_run": True, "endpoint": f"{settings.api_base}/tasks/{args.task_id}/submit", "body": body}, indent=2))
        return 0
    data = http_json("POST", f"{settings.api_base}/tasks/{args.task_id}/submit", body, timeout=settings.timeout)
    state = ensure_state(settings)
    state["submissions"][args.task_id] = {"submitted_at": utc_now(), "response": data, "link_url": args.link_url}
    state["ledger"].append({"time": utc_now(), "event": "submit", "task_id": args.task_id, "link_url": args.link_url})
    save_state(settings, state)
    print(json.dumps(data, indent=2, ensure_ascii=False))
    return 0


def cmd_ledger(args: argparse.Namespace) -> int:
    settings = make_settings(args)
    state = ensure_state(settings)
    summary = {
        "claims": len(state.get("claims", {})),
        "submissions": len(state.get("submissions", {})),
        "events": len(state.get("ledger", [])),
        "state_file": str(settings.state_dir / "state.json"),
        "latest_events": state.get("ledger", [])[-10:],
    }
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return 0


def cmd_daemon(args: argparse.Namespace) -> int:
    settings = make_settings(args)
    for cycle in range(args.cycles):
        tasks = fetch_tasks(settings, demo=args.demo)
        rows = [score_task(task, None) for task in tasks]
        rows.sort(key=lambda item: item["score"], reverse=True)
        top = [row for row in rows if row["score"] >= args.min_score and not row["blocked"]]
        print(json.dumps({"time": utc_now(), "cycle": cycle + 1, "top": top[: args.limit]}, ensure_ascii=False))
        if args.auto_claim:
            state = ensure_state(settings)
            for row in top[: args.limit]:
                state["claims"].setdefault(row["id"], {
                    "task_id": row["id"],
                    "title": row["title"],
                    "claimed_at": utc_now(),
                    "score": row["score"],
                    "status": "claimed",
                })
            save_state(settings, state)
        if cycle < args.cycles - 1:
            time.sleep(args.interval)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Moltask agent task bot")
    parser.add_argument("--api-base", default=None)
    parser.add_argument("--wallet", default=None)
    parser.add_argument("--state-dir", default=None)
    parser.add_argument("--timeout", type=int, default=30)
    sub = parser.add_subparsers(dest="command", required=True)

    scan = sub.add_parser("scan", help="scan and rank open tasks")
    scan.add_argument("--limit", type=int, default=10)
    scan.add_argument("--min-score", type=int, default=35)
    scan.add_argument("--auto-claim", action="store_true")
    scan.add_argument("--no-submission-counts", action="store_true")
    scan.add_argument("--demo", action="store_true")
    scan.set_defaults(func=cmd_scan)

    claim = sub.add_parser("claim", help="record a local task claim")
    claim.add_argument("task_id")
    claim.add_argument("--force", action="store_true")
    claim.add_argument("--demo", action="store_true")
    claim.set_defaults(func=cmd_claim)

    complete = sub.add_parser("complete", help="mark a claimed task complete locally")
    complete.add_argument("task_id")
    complete.add_argument("--artifact", required=True)
    complete.add_argument("--link-url", default=None)
    complete.add_argument("--notes", default="")
    complete.set_defaults(func=cmd_complete)

    submit = sub.add_parser("submit", help="submit proof of work to Moltask")
    submit.add_argument("task_id")
    submit.add_argument("--message", default="")
    submit.add_argument("--message-file", default=None)
    submit.add_argument("--link-url", default=None)
    submit.add_argument("--link-type", default="other")
    submit.add_argument("--dry-run", action="store_true")
    submit.set_defaults(func=cmd_submit)

    ledger = sub.add_parser("ledger", help="show local earning ledger")
    ledger.set_defaults(func=cmd_ledger)

    daemon = sub.add_parser("daemon", help="run repeated scans")
    daemon.add_argument("--interval", type=int, default=300)
    daemon.add_argument("--cycles", type=int, default=1)
    daemon.add_argument("--limit", type=int, default=5)
    daemon.add_argument("--min-score", type=int, default=35)
    daemon.add_argument("--auto-claim", action="store_true")
    daemon.add_argument("--demo", action="store_true")
    daemon.set_defaults(func=cmd_daemon)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args) or 0)


if __name__ == "__main__":
    raise SystemExit(main())
