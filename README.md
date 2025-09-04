# Dotfiles

Personal configuration files for Unix-like systems.

## Structure

```
dotfiles/
├── shell/          # Shell configurations
│   ├── .bashrc     # Bash configuration
│   ├── .profile    # Login shell configuration
│   └── .zshrc      # Zsh configuration
├── git/            # Git configuration
│   └── .gitconfig  # Git global configuration
├── claude/         # Claude CLI configuration
│   └── .claude/    # Claude settings directory (partial)
├── config/         # .config directory contents
│   ├── fish/       # Fish shell configuration
│   └── git/        # Additional Git configuration
├── install.sh      # Installation script
└── README.md       # This file
```

## Installation

### Quick Install

Clone the repository and run the installation script:

```bash
git clone https://github.com/[your-username]/dotfiles.git ~/dev/dotfiles
cd ~/dev/dotfiles
./install.sh
```

The installation script will:
1. Create symbolic links from your home directory to the files in this repository
2. Back up any existing files before replacing them
3. Set up the directory structure as needed

### Manual Installation

If you prefer to manually link specific files:

```bash
# Example: Link .bashrc
ln -s ~/dev/dotfiles/shell/.bashrc ~/.bashrc

# Example: Link Git configuration
ln -s ~/dev/dotfiles/git/.gitconfig ~/.gitconfig
```

## Updating

To update your dotfiles:

```bash
cd ~/dev/dotfiles
git pull origin main
```

## Adding New Dotfiles

1. Move the file/directory to the appropriate location in this repository
2. Create a symbolic link from the original location
3. Update the `install.sh` script if necessary
4. Commit your changes

Example:
```bash
# Move a new configuration file
mv ~/.newconfig ~/dev/dotfiles/shell/.newconfig
ln -s ~/dev/dotfiles/shell/.newconfig ~/.newconfig

# Add to git
git add shell/.newconfig
git commit -m "Add .newconfig"
```

## Customization

Feel free to modify any configuration files to suit your needs. The files are organized by category for easy management.

## License

These dotfiles are provided as-is for personal use.