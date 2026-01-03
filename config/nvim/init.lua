-- ~/.config/nvim/init.lua
vim.g.mapleader = " "
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
  { "catppuccin/nvim", name = "catppuccin", priority = 1000,
    config = function()
      vim.cmd.colorscheme("catppuccin")
    end,
  },
  { "nvim-tree/nvim-tree.lua", config = true },
  { "nvim-tree/nvim-web-devicons" },
  { "nvim-treesitter/nvim-treesitter",
    build = ":TSUpdate",
    config = function()
      require("nvim-treesitter").install({ "typescript", "tsx", "go", "rust", "lua", "vim", "vimdoc" })
    end,
  },
  { "lewis6991/gitsigns.nvim", config = true },
  { "sindrets/diffview.nvim", config = true },
  { "ibhagwan/fzf-lua", config = true },
  { "folke/which-key.nvim", event = "VeryLazy", config = true },
  -- LSP
  { "williamboman/mason.nvim", config = true },
  { "williamboman/mason-lspconfig.nvim",
    config = function()
      require("mason-lspconfig").setup({
        ensure_installed = { "ts_ls", "gopls", "rust_analyzer" },
      })
    end,
  },
}, {
  rocks = { enabled = false },
})

-- LSP設定 (Neovim 0.11+)
vim.lsp.config("ts_ls", {})
vim.lsp.config("gopls", {})
vim.lsp.config("rust_analyzer", {})
vim.lsp.enable({ "ts_ls", "gopls", "rust_analyzer" })

-- キーマップ
vim.keymap.set("n", "<leader>e", ":NvimTreeToggle<CR>")
vim.keymap.set("n", "<leader>r", ":source $MYVIMRC<CR>", { desc = "設定リロード" })
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
vim.keymap.set("n", "<leader>gp", ":Gitsigns preview_hunk<CR>")  -- hunkプレビュー
vim.keymap.set("n", "<leader>gd", ":Gitsigns diffthis<CR>")      -- ファイルdiff
vim.keymap.set("n", "<leader>gr", ":Gitsigns reset_hunk<CR>")    -- 変更を戻す
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
vim.keymap.set("n", "<leader>ca", vim.lsp.buf.code_action, { desc = "コードアクション" })
vim.keymap.set("n", "<leader>rn", vim.lsp.buf.rename, { desc = "リネーム" })
vim.keymap.set("n", "[d", vim.diagnostic.goto_prev, { desc = "前のエラー" })
vim.keymap.set("n", "]d", vim.diagnostic.goto_next, { desc = "次のエラー" })
