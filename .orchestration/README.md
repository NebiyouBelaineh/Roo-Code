# .orchestration/ Directory

This directory contains machine-managed orchestration files that enable Intent-Code Traceability and AI-Native Git functionality.

## Files

### `active_intents.yaml`

Tracks the lifecycle of business requirements and formalized intents. Each intent defines:

- **ID**: Unique identifier (e.g., "INT-001")
- **Status**: IN_PROGRESS, COMPLETED, PENDING
- **Owned Scope**: Files and directories the intent is authorized to modify
- **Constraints**: Rules that must be followed
- **Acceptance Criteria**: Definition of done

**Update Pattern:** Updated via Pre-Hooks (when an agent picks a task) and Post-Hooks (when a task is complete).

### `agent_trace.jsonl`

An append-only, machine-readable ledger of every mutating action. Links abstract Intent IDs to concrete code changes via content hashing.

**Schema:**

- `id`: UUID v4
- `timestamp`: ISO 8601 timestamp
- `vcs`: Git revision information
- `files`: Array of file changes with:
    - `relative_path`: File path
    - `conversations`: Session information
    - `ranges`: Code ranges with content hashes (spatial independence)
    - `related`: Links to intent IDs

**Update Pattern:** Updated via Post-Hook after file writes.

### `intent_map.md`

Maps high-level business intents to physical files and AST nodes. Provides spatial mapping for answering questions like "Where is the billing logic?"

**Update Pattern:** Incrementally updated when INTENT_EVOLUTION occurs.

### `AGENT.md` (or `CLAUDE.md`)

A persistent knowledge base shared across parallel sessions. Contains:

- Lessons Learned
- Project-specific stylistic rules
- Common pitfalls to avoid
- Architectural decisions
- Verification failures & solutions

**Update Pattern:** Incrementally appended when verification loops fail or architectural decisions are made.

## Usage

These files are automatically managed by the hook engine. Manual edits are possible but should be done carefully to maintain consistency.

## Data Model

Based on the TRP1 Challenge Week 1 specification:

- Inspired by Spec-Driven Development and AISpec
- Uses content hashing for spatial independence
- Links Intent → Code AST → Agent Action
- Enables AI-Native Git functionality
