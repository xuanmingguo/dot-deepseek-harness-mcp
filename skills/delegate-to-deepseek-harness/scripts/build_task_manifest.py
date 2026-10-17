#!/usr/bin/env python3
"""Build a path-reference-only contract for a bounded DeepSeek Harness task."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys


PERMISSION_MODES = ("read-only", "workspace-write", "danger-full-access")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        epilog="External paths are task declarations only. The server checks its own configured external-path policy before admission."
    )
    parser.add_argument("workspace", help="Authorized Harness workspace root")
    parser.add_argument(
        "--path",
        action="append",
        dest="paths",
        required=True,
        help="Review target relative to the workspace or an explicitly granted absolute external path; repeatable",
    )
    parser.add_argument(
        "--context-path",
        action="append",
        required=True,
        help="Workspace-relative or explicitly granted absolute external path Harness may search and read; repeatable; use . for the workspace root",
    )
    parser.add_argument(
        "--scope",
        required=True,
        help="Single-line review or implementation scope; never paste source text here",
    )
    parser.add_argument(
        "--exclude-path",
        action="append",
        default=[],
        help="Workspace-relative or explicitly granted absolute external path excluded from the delegated scope; repeatable",
    )
    parser.add_argument(
        "--write-path",
        action="append",
        default=[],
        help="Workspace-relative or explicitly write-granted absolute external path Harness may modify; repeatable; external writes require danger-full-access",
    )
    for access in ("read", "write"):
        for kind in ("file", "directory"):
            parser.add_argument(
                f"--external-{access}-{kind}",
                action="append",
                default=[],
                help=f"Declare an absolute external {kind} for {access} access; repeatable; subject to the server's configured policy",
            )
    parser.add_argument("--permission-mode", choices=PERMISSION_MODES, default="read-only")
    return parser.parse_args()


def path_contains(parent: Path, child: Path) -> bool:
    return child.is_relative_to(parent)


def normalize_external_paths(args: argparse.Namespace) -> list[dict[str, str]]:
    grants = []
    for access in ("read", "write"):
        for kind in ("file", "directory"):
            for value in getattr(args, f"external_{access}_{kind}"):
                if not value or value.strip() != value or "\0" in value or not Path(value).is_absolute():
                    raise ValueError("external paths must be absolute, non-empty and contain no NUL or surrounding whitespace")
                declared = Path(os.path.abspath(value))
                canonical = declared.resolve(strict=False)
                if canonical.exists():
                    matches_kind = canonical.is_file() if kind == "file" else canonical.is_dir()
                    if not matches_kind:
                        raise ValueError(f"external path does not match kind={kind}: {value}")
                else:
                    parent = canonical.parent
                    while not parent.exists():
                        parent = parent.parent
                    if not parent.is_dir():
                        raise ValueError(f"external path parent is not a directory: {value}")
                grant = {"path": canonical.as_posix(), "access": access, "kind": kind, "declared": str(declared)}
                if grant not in grants:
                    grants.append(grant)
    if len(grants) > 64:
        raise ValueError("external paths must contain at most 64 grants")
    return grants


def grant_contains(grant: dict[str, str], declared: Path, canonical: Path) -> bool:
    declared_root = Path(grant["declared"])
    canonical_root = Path(grant["path"])
    if grant["kind"] == "file":
        return declared == declared_root and canonical == canonical_root
    return path_contains(declared_root, declared) and path_contains(canonical_root, canonical)


def normalize_location(root: Path, value: str, *, must_exist: bool, grants: list[dict[str, str]]) -> str:
    if not value or "\0" in value:
        raise ValueError("locations must be non-empty and contain no NUL")
    resolved = (root / value).resolve(strict=must_exist)
    try:
        relative = resolved.relative_to(root)
    except ValueError as exc:
        declared = Path(os.path.abspath(root / value))
        if Path(value).is_absolute() and any(grant_contains(grant, declared, resolved) for grant in grants):
            return resolved.as_posix()
        raise ValueError(f"path escapes workspace: {value}") from exc
    return relative.as_posix() or "."


def normalize_locations(root: Path, values: list[str], *, must_exist: bool, grants: list[dict[str, str]]) -> list[str]:
    return list(dict.fromkeys(normalize_location(root, value, must_exist=must_exist, grants=grants) for value in values))


def validate_scope(value: str) -> str:
    scope = value.strip()
    if not scope:
        raise ValueError("--scope must not be empty")
    if len(scope) > 2_000:
        raise ValueError("--scope exceeds 2000 characters")
    if "\n" in scope or "\r" in scope or "```" in scope:
        raise ValueError("--scope must be concise single-line instructions, not embedded source text")
    return scope


def contains_path(parent: str, child: str) -> bool:
    if os.name == "nt":
        parent = parent.casefold()
        child = child.casefold()
    return (parent == "." and not Path(child).is_absolute()) or child == parent or child.startswith(f"{parent.rstrip('/')}/")


def main() -> int:
    args = parse_args()
    root = Path(args.workspace).resolve(strict=True)
    if not root.is_dir():
        raise ValueError("workspace must be a directory")

    external_paths = normalize_external_paths(args)
    if args.permission_mode != "danger-full-access" and any(grant["access"] == "write" for grant in external_paths):
        raise ValueError("external write grants require --permission-mode danger-full-access")
    if args.permission_mode == "read-only" and args.write_path:
        raise ValueError("--write-path is forbidden in read-only mode")
    if args.permission_mode != "read-only" and not args.write_path:
        raise ValueError("write-capable modes require at least one --write-path")

    review_targets = normalize_locations(root, args.paths, must_exist=True, grants=external_paths)
    context_read_scope = normalize_locations(root, args.context_path, must_exist=True, grants=external_paths)
    excluded_paths = normalize_locations(root, args.exclude_path, must_exist=False, grants=external_paths)
    write_scope = normalize_locations(root, args.write_path, must_exist=False, grants=[grant for grant in external_paths if grant["access"] == "write"])
    for target in review_targets:
        if not any(contains_path(context, target) for context in context_read_scope):
            raise ValueError(f"review target is outside context read scope: {target}")
        if any(contains_path(excluded, target) for excluded in excluded_paths):
            raise ValueError(f"review target is excluded: {target}")
    for target in write_scope:
        if not any(contains_path(context, target) for context in context_read_scope):
            raise ValueError(f"write path is outside context read scope: {target}")

    payload = {
        "schemaVersion": 4 if external_paths else 3,
        "sourceTransferPolicy": "path-reference-only",
        "workspaceRoot": str(root),
        "permissionMode": args.permission_mode,
        "scope": validate_scope(args.scope),
        "reviewTargets": review_targets,
        "contextReadScope": context_read_scope,
        "excludedPaths": excluded_paths,
        "writeScope": write_scope,
        "scopeEnforcement": "instruction-only",
    }
    if external_paths:
        payload["externalPaths"] = [{key: grant[key] for key in ("path", "access", "kind")} for grant in external_paths]
    sys.stdout.reconfigure(encoding="utf-8")
    json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
