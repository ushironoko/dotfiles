#!/usr/bin/env bash

if [ -f ./HANDOVER.md ]; then
  exit 0
fi

echo "REQUIRED ACTION: You MUST create ./HANDOVER.md NOW with the following: 1) Current project status, 2) Pending tasks, 3) Important context. This file is REQUIRED for compact to proceed. CREATE THE FILE IMMEDIATELY using the Write tool."  1>&2
exit 2
