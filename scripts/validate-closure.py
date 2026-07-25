#!/usr/bin/env python3
"""Fail-closed validator for brutal-aqe-loop closure manifests."""

from __future__ import annotations

import json
import sys
from pathlib import Path


COMPLETE = "complete"


def error(message: str, errors: list[str]) -> None:
    errors.append(message)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: scripts/validate-closure.py <closure-manifest.json>", file=sys.stderr)
        return 2

    path = Path(sys.argv[1])
    try:
        manifest = json.loads(path.read_text())
    except Exception as exc:  # noqa: BLE001 - CLI validator should report parse failures.
        print(f"failed to read {path}: {exc}", file=sys.stderr)
        return 2

    errors: list[str] = []
    required_top = [
        "schema_version",
        "status",
        "blast_class",
        "action_floor",
        "clean_target",
        "artifact_ref",
        "artifact_hash",
        "scope_hash",
        "rounds",
        "acceptance_matrix",
        "verification_matrix",
        "investigation_log",
        "good_findings",
        "ledger_ref",
        "candidate_records",
        "rollback",
        "composite_audit",
        "closure_dossier",
    ]
    for key in required_top:
        if key not in manifest:
            error(f"missing top-level key: {key}", errors)

    if manifest.get("status") != "CLOSED":
        error("status must be CLOSED", errors)
    if manifest.get("blast_class") == "high":
        if manifest.get("action_floor") != "low":
            error("high blast requires action_floor=low", errors)
        if manifest.get("clean_target", 0) < 2:
            error("high blast requires clean_target >= 2", errors)

    rounds = manifest.get("rounds")
    if not isinstance(rounds, list) or len(rounds) < manifest.get("clean_target", 10**9):
        error("rounds must contain at least clean_target entries", errors)
        rounds = [] if not isinstance(rounds, list) else rounds

    artifact_hash = manifest.get("artifact_hash")
    scope_hash = manifest.get("scope_hash")
    fresh_contexts: set[str] = set()
    for index, round_manifest in enumerate(rounds, start=1):
        prefix = f"round {index}"
        for key in [
            "round_id",
            "fresh_context_id",
            "artifact_hash",
            "scope_hash",
            "verdict",
            "valid",
            "full_gate_status",
            "triggered_contract_inventory",
            "refuter_records",
        ]:
            if key not in round_manifest:
                error(f"{prefix}: missing {key}", errors)
        if round_manifest.get("artifact_hash") != artifact_hash:
            error(f"{prefix}: artifact_hash does not match closure artifact_hash", errors)
        if round_manifest.get("scope_hash") != scope_hash:
            error(f"{prefix}: scope_hash does not match closure scope_hash", errors)
        if round_manifest.get("verdict") != "CLEAN":
            error(f"{prefix}: verdict must be CLEAN", errors)
        if round_manifest.get("valid") is not True:
            error(f"{prefix}: valid must be true", errors)
        if round_manifest.get("full_gate_status") != "PASS":
            error(f"{prefix}: full_gate_status must be PASS", errors)
        if round_manifest.get("triggered_contract_inventory") != COMPLETE:
            error(f"{prefix}: triggered_contract_inventory must be complete", errors)
        if round_manifest.get("refuter_records") != COMPLETE:
            error(f"{prefix}: refuter_records must be complete", errors)
        fresh_context_id = round_manifest.get("fresh_context_id")
        if fresh_context_id in fresh_contexts:
            error(f"{prefix}: fresh_context_id was reused", errors)
        if isinstance(fresh_context_id, str):
            fresh_contexts.add(fresh_context_id)

    for key in [
        "acceptance_matrix",
        "verification_matrix",
        "investigation_log",
        "good_findings",
    ]:
        if manifest.get(key) != COMPLETE:
            error(f"{key} must be complete", errors)

    if manifest.get("candidate_records") not in (COMPLETE, "queued"):
        error("candidate_records must be complete or queued", errors)

    if manifest.get("rollback") in (None, "", "missing"):
        error("rollback must be present", errors)
    if manifest.get("composite_audit") != "PASS":
        error("composite_audit must be PASS", errors)
    if manifest.get("closure_dossier") != "present":
        error("closure_dossier must be present", errors)

    if errors:
        print("STOP: closure manifest is invalid")
        for item in errors:
            print(f"- {item}")
        return 1

    print("CLOSED: closure manifest is valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
