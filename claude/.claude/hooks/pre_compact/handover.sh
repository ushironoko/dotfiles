#!/usr/bin/env bash

if [ -f ./HANDOVER.md ]; then
  exit 0
fi

echo "Before compressing your context, record all your project progress, remaining tasks, and user instructions in ./HANDOVER.md , which will be loaded in your next session and used to continue your tasks."  1>&2
exit 2
