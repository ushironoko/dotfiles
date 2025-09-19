# Repeat CLAUDE.md Instructions

This command will repeat all CLAUDE.md file contents in the current session, allowing users to reload instructions at any time.

## Usage

Simply type `/repeat-memory` to have Claude recite all CLAUDE.md instructions currently in effect.

## Purpose

This command ensures Claude maintains awareness of all project-specific and global instructions by:

- Re-reading global CLAUDE.md (~/.claude/CLAUDE.md)
- Re-reading project CLAUDE.md files
- Reinforcing important constraints and requirements

## What it does

When invoked, Claude will:

1. Locate and read all relevant CLAUDE.md files
2. Display their contents in the current conversation
3. Acknowledge and apply all instructions immediately

This is particularly useful when:

- You suspect Claude may have forgotten some instructions
- After a long conversation where context may have drifted
- When switching between different types of tasks
- To ensure critical constraints are being followed
