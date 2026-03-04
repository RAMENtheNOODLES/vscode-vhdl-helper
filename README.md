# VHDL Helper

VHDL Helper is a Visual Studio Code extension that provides VHDL snippets, and syntax highlighting. This extension is similar to the [awesome-vhdl](https://github.com/puorc/awesome-vhdl/tree/master) but has a few tweaks
that better suited my use-case.

Syntax highlighting and semantics were forked from the [awesome-vhdl](https://github.com/puorc/awesome-vhdl/tree/master) extension.

## Features

- VHDL snippets for common language patterns.
- A command that converts clipboard COMPONENT declarations into DUT PORT MAP text.
- A header snippet that can prefill author and course from settings.

## Usage

1. Copy a VHDL COMPONENT declaration to your clipboard.
2. Open a VHDL file and place your cursor where you want the DUT PORT MAP inserted (or select text to replace).
3. Run the command or use the keybinding to insert the generated port map.

## Commands

- **VHDL: Clipboard COMPONENT → DUT PORT MAP** (`vhdlHelper.clipboardComponentToDut`)
  - Default keybinding: `Ctrl+Alt+D`
- **VHDL: Clipboard COMPONENT → SIGNAL DECLARATIONS** (`vhdlHelper.clipboardComponentToSignals`)
  - Default keybinding: `Ctrl+Alt+S`

## Settings

- `vhdlHelper.authorName`: Default author name used in the VHDL header snippet.
- `vhdlHelper.courseName`: Default course name used in the VHDL header snippet.

## AI Authorship Notice

Most of the code in this repository was written by AI, but it has been verified by a competent human.

## License

MIT
