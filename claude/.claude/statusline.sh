#!/bin/bash
# JSON入力を一度読み取る
input=$(cat)

# 一般的な抽出のためのヘルパー関数
get_model_name() { echo "$input" | jq -r '.model.display_name'; }
get_current_dir() { echo "$input" | jq -r '.workspace.current_dir'; }
get_project_dir() { echo "$input" | jq -r '.workspace.project_dir'; }
get_version() { echo "$input" | jq -r '.version'; }
get_cost() { echo "$input" | jq -r '.cost.total_cost_usd'; }
get_duration() { echo "$input" | jq -r '.cost.total_duration_ms'; }

# ヘルパーを使用
MODEL=$(get_model_name)
DIR=$(get_current_dir)
echo "[$MODEL] 📁 ${DIR##*/}"
echo "🕒 $(get_version) | 💰 $(get_cost) USD | ⏳ $(get_duration) ms"
