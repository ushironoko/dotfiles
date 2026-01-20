-- ~/.config/nvim/init.lua
vim.g.mapleader = " "
vim.g.maplocalleader = ","
vim.opt.number = true  -- 行番号表示

-- lazy.nvim bootstrap
local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not vim.loop.fs_stat(lazypath) then
  vim.fn.system({
    "git",
    "clone",
    "--filter=blob:none",
    "https://github.com/folke/lazy.nvim.git",
    "--branch=stable",
    lazypath,
  })
end
vim.opt.rtp:prepend(lazypath)

-- プラグイン設定
require("lazy").setup({
  { "Mofiqul/dracula.nvim", name = "dracula", priority = 1000,
    config = function()
      require("dracula").setup({
        transparent_bg = false,
        italic_comment = true,
      })
      vim.cmd.colorscheme("dracula")
    end,
  },
  { "nvim-tree/nvim-tree.lua",
    config = function()
      require("nvim-tree").setup({
        filters = {
          dotfiles = false,  -- ドットファイルを表示
          git_ignored = false,  -- gitignore対象も表示
        },
      })
    end,
  },
  { "nvim-tree/nvim-web-devicons" },
  { "nvim-treesitter/nvim-treesitter",
    build = ":TSUpdate",
    config = function()
      require("nvim-treesitter").install({ "typescript", "tsx", "go", "rust", "lua", "vim", "vimdoc" })
    end,
  },
  { "kdheepak/lazygit.nvim",
    dependencies = { "nvim-lua/plenary.nvim" },
    cmd = { "LazyGit", "LazyGitConfig", "LazyGitCurrentFile", "LazyGitFilter", "LazyGitFilterCurrentFile" },
    keys = { { "<leader>gg", "<cmd>LazyGit<CR>", desc = "LazyGit" } },
  },
  { "sindrets/diffview.nvim", config = true },
  { "pwntester/octo.nvim",
    cmd = "Octo",
    dependencies = {
      "nvim-lua/plenary.nvim",
      "nvim-tree/nvim-web-devicons",
      "ibhagwan/fzf-lua",
    },
    config = function()
      require("octo").setup({
        picker = "fzf-lua",
        enable_builtin = true,
        default_remote = { "origin", "upstream" },
        suppress_missing_scope = {
          projects_v2 = true,
        },
        mappings = {
          review_diff = {
            add_review_comment = { lhs = "<localleader>c", desc = "コメント追加" },
            add_review_suggestion = { lhs = "<localleader>s", desc = "サジェスト追加" },
            next_thread = { lhs = "n", desc = "次のコメント" },
            prev_thread = { lhs = "N", desc = "前のコメント" },
          },
          file_panel = {
            add_review_comment = { lhs = "<localleader>c", desc = "コメント追加" },
            add_review_suggestion = { lhs = "<localleader>s", desc = "サジェスト追加" },
            next_thread = { lhs = "n", desc = "次のコメント" },
            prev_thread = { lhs = "N", desc = "前のコメント" },
          },
        },
      })
    end,
  },
  { "ibhagwan/fzf-lua",
   config = function()
      require("fzf-lua").setup({
        files = {
          fd_opts = "--type f --hidden --follow --exclude .git",
        },
        grep = {
          rg_opts = "--hidden --column --line-number --no-heading --color=always --smart-case --follow -g '!.git'",
        },
      })
    end,
  },
  { "folke/which-key.nvim", event = "VeryLazy", config = true },
  -- LSP
  { "williamboman/mason.nvim", config = true },
  { "neovim/nvim-lspconfig" },
  { "williamboman/mason-lspconfig.nvim",
    config = function()
      require("mason-lspconfig").setup({
        ensure_installed = { "ts_ls", "rust_analyzer" },
      })
    end,
  },
}, {
  rocks = { enabled = false },
})

-- LSP設定 (Neovim 0.11+)
vim.lsp.config("ts_ls", {
  init_options = {
    preferences = {
      includeInlayParameterNameHints = "all",
      includeInlayParameterNameHintsWhenArgumentMatchesName = false,
      includeInlayFunctionParameterTypeHints = true,
      includeInlayVariableTypeHints = true,
      includeInlayVariableTypeHintsWhenTypeMatchesName = false,
      includeInlayPropertyDeclarationTypeHints = true,
      includeInlayFunctionLikeReturnTypeHints = true,
      includeInlayEnumMemberValueHints = true,
    },
  },
})
vim.lsp.config("rust_analyzer", {})
vim.lsp.enable({ "ts_ls", "rust_analyzer" })

-- キーマップ
vim.keymap.set("n", "<leader>e", ":NvimTreeToggle<CR>")
vim.keymap.set("n", "<leader>w", "<cmd>w<CR>", { desc = "保存" })
vim.keymap.set("n", "<leader>x", "<cmd>q<CR>", { desc = "閉じる" })
vim.keymap.set("n", "<C-h>", "<C-w>h")  -- 左のウィンドウ
vim.keymap.set("n", "<C-l>", "<C-w>l")  -- 右のウィンドウ
vim.keymap.set("n", "<C-j>", "<C-w>j")  -- 下のウィンドウ
vim.keymap.set("n", "<C-k>", "<C-w>k")  -- 上のウィンドウ
vim.keymap.set("n", "<leader><Left>", "<C-w>h")
vim.keymap.set("n", "<leader><Right>", "<C-w>l")
vim.keymap.set("n", "<leader><Down>", "<C-w>j")
vim.keymap.set("n", "<leader><Up>", "<C-w>k")
vim.keymap.set("n", "<leader>h", "<C-w>h")
vim.keymap.set("n", "<leader>l", "<C-w>l")
vim.keymap.set("n", "<leader>j", "<C-w>j")
vim.keymap.set("n", "<leader>k", "<C-w>k")
vim.keymap.set("n", "<leader>gD", "<cmd>DiffviewOpen<CR>", { desc = "リポジトリdiff" })
vim.keymap.set("n", "<leader>gc", "<cmd>DiffviewClose<CR>", { desc = "diffview閉じる" })
-- fzf
vim.keymap.set("n", "<leader>ff", "<cmd>FzfLua files<CR>", { desc = "ファイル検索" })
vim.keymap.set("n", "<leader>fg", "<cmd>FzfLua live_grep<CR>", { desc = "grep検索" })
vim.keymap.set("n", "<leader>fb", "<cmd>FzfLua buffers<CR>", { desc = "バッファ一覧" })
vim.keymap.set("n", "<leader>fh", "<cmd>FzfLua help_tags<CR>", { desc = "ヘルプ検索" })
-- LSP
vim.keymap.set("n", "gd", vim.lsp.buf.definition, { desc = "定義へ移動" })
vim.keymap.set("n", "K", vim.lsp.buf.hover, { desc = "ホバー情報" })
vim.keymap.set("n", "<leader>i", vim.lsp.buf.code_action, { desc = "コードアクション" })
vim.keymap.set("n", "<leader>rn", vim.lsp.buf.rename, { desc = "リネーム" })
vim.keymap.set("n", "[d", vim.diagnostic.goto_prev, { desc = "前のエラー" })
vim.keymap.set("n", "]d", vim.diagnostic.goto_next, { desc = "次のエラー" })
-- Terminal
vim.keymap.set("n", "<leader>t", "<cmd>terminal<CR>", { desc = "ターミナル" })
-- 絶対パスをクリップボードにコピー
vim.keymap.set("n", "<leader>C", function()
  local path = vim.fn.expand("%:p")
  vim.fn.setreg("+", path)
  vim.notify("Copied: " .. path)
end, { desc = "絶対パスをコピー" })

-- LSP自動ホバー（カーソル停止時に型情報を表示）
vim.opt.updatetime = 500  -- ディレイ（ミリ秒）、お好みで調整

vim.api.nvim_create_autocmd("CursorHold", {
  callback = function()
    -- LSPがアタッチされているバッファのみ
    if #vim.lsp.get_clients({ bufnr = 0 }) == 0 then
      return
    end
    -- すでにフローティングウィンドウが開いている場合はスキップ
    for _, win in ipairs(vim.api.nvim_list_wins()) do
      if vim.api.nvim_win_get_config(win).relative ~= "" then
        return
      end
    end
    vim.lsp.buf.hover()
  end,
})

-- インレイヒント（型情報のインライン表示）
vim.api.nvim_create_autocmd("LspAttach", {
  callback = function(args)
    local client = vim.lsp.get_client_by_id(args.data.client_id)
    if client and client.supports_method("textDocument/inlayHint") then
      vim.lsp.inlay_hint.enable(true, { bufnr = args.buf })
    end
  end,
})

-- トグル用キーマップ
vim.keymap.set("n", "<leader>ih", function()
  vim.lsp.inlay_hint.enable(not vim.lsp.inlay_hint.is_enabled())
end, { desc = "インレイヒント切替" })

-- Octo (GitHub PR Review)
vim.keymap.set("n", "<leader>op", "<cmd>Octo pr list<CR>", { desc = "PR一覧" })
vim.keymap.set("n", "<leader>or", "<cmd>Octo review start<CR>", { desc = "レビュー開始" })
vim.keymap.set("n", "<leader>os", "<cmd>Octo review submit<CR>", { desc = "レビュー送信" })
