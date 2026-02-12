# VHDL Helper

VHDL Helper is a Visual Studio Code extension that provides VHDL snippets and a command to convert a VHDL COMPONENT declaration from the clipboard into a DUT PORT MAP inserted at the cursor or replacing a selection.

## Features

- VHDL snippets for common language patterns.
- A command that converts clipboard COMPONENT declarations into DUT PORT MAP text.

## Usage

1. Copy a VHDL COMPONENT declaration to your clipboard.
2. Open a VHDL file and place your cursor where you want the DUT PORT MAP inserted (or select text to replace).
3. Run the command or use the keybinding to insert the generated port map.

## Commands

- **VHDL: Clipboard COMPONENT → DUT PORT MAP** (`vhdlHelper.clipboardComponentToDut`)
  - Default keybinding: `Ctrl+Alt+D`

## VSIX Package

To build the VSIX locally:

1. `npm ci`
2. `npm run compile`
3. `npx vsce package --out vhdl-helper.vsix`

## AI Authorship Notice

Most of the code in this repository was written by AI, but it has been verified by a competent human.

## License

MIT
