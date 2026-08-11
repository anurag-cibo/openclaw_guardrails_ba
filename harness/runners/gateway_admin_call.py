#!/usr/bin/env python3
"""Call one OpenClaw Gateway RPC with the experiment operator scopes."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from approval_responder import gateway_call


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--openclaw-repo", required=True)
    parser.add_argument("--method", required=True)
    parser.add_argument("--params", default="{}")
    parser.add_argument("--timeout-seconds", type=float, default=20.0)
    args = parser.parse_args()

    try:
        params = json.loads(args.params)
    except json.JSONDecodeError as error:
        parser.error(f"--params is not valid JSON: {error}")
    if not isinstance(params, dict):
        parser.error("--params must be a JSON object")

    result = gateway_call(
        Path(args.openclaw_repo),
        args.method,
        params,
        timeout=args.timeout_seconds,
    )
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
