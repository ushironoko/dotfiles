#!/usr/bin/env bash
# ExitPlanMode前にAskUserQuestionが使用されたか確認

FLAG_FILE="/tmp/.claude_hearing_done"
PERMISSION_MODE=$(cat)

if [[ "$PERMISSION_MODE" == "plan" ]]; then
  if [[ ! -f "$FLAG_FILE" ]]; then
    echo "⚠️ 警告: AskUserQuestionでヒアリングを実施していません。"
    echo "   より堅牢なプランのため、ユーザーへの確認を推奨します。"
    echo ""
    echo "💡 ヒント: plan-hearing スキルを使用すると効率的なヒアリングが可能です。"
  fi
fi

exit 0  # ブロックせず続行
