if [ ! -f ./HANDOVER.md ]; then
  exit 0
fi

echo "There is a HANDOVER.md file. This is the handover note you left for yourself in the last session. Please review the contents and continue with your task." 1>&2
exit 0
