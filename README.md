# VHDL Helper

VHDL Helper is a Visual Studio Code extension that provides VHDL snippets, and syntax highlighting. This extension is similar to the [awesome-vhdl](https://github.com/puorc/awesome-vhdl/tree/master) but has a few tweaks
that better suited my use-case.

Syntax highlighting and semantics were forked from the [awesome-vhdl](https://github.com/puorc/awesome-vhdl/tree/master) extension.

## Features

- VHDL snippets for common language patterns.
- A command that converts clipboard COMPONENT declarations into DUT PORT MAP text.
- A header snippet that can prefill author and course from settings.
- A Language Server that allows mistakes to be caught before compile-time

## Usage

1. Copy a VHDL COMPONENT declaration to your clipboard.
2. Open a VHDL file and place your cursor where you want the DUT PORT MAP inserted (or select text to replace).
3. Run the command or use the keybinding to insert the generated port map.

## Language Server
In order to use the "GHDL" or "BOTH" option as a Language Server, GHDL needs to be installed on your computer.

For Windows users, GHDL can be installed via WINGET (`winget install ghdl`) or via `MSYS2`. More details on the installation process can be found [here](https://github.com/ghdl/ghdl?tab=readme-ov-file#getting-ghdl).

Once GHDL is installed, close and reopen VScode.

## Commands

- **VHDL: Clipboard COMPONENT → DUT PORT MAP** (`vhdlHelper.clipboardComponentToDut`)
  - Default keybinding: `Ctrl+Alt+D`
- **VHDL: Clipboard COMPONENT → SIGNAL DECLARATIONS** (`vhdlHelper.clipboardComponentToSignals`)
  - Default keybinding: `Ctrl+Alt+S`

## Settings

- `vhdlHelper.authorName`: Default author name used in the VHDL header snippet.
- `vhdlHelper.courseName`: Default course name used in the VHDL header snippet.
- `vhdl.languageStandard`: VHDL language standard used by the language server. Supported values: `87`, `93`, `02`, `08`, `19`.
- `vhdl.diagnostics.mode`: Diagnostic source to use. Supported values: `basic`, `ghdl`, `both`, `off`.
- `vhdl.ghdl.path`: Absolute path to the `ghdl` executable. Leave empty to use the system `PATH`.
- `vhdl.ghdl.args`: Extra arguments appended to each `ghdl -a` invocation.
- `vhdl.ghdl.run`: When GHDL analysis runs. Supported values: `onSave`, `onType`.
- `vhdl.ghdl.debounceMs`: Debounce delay in milliseconds when `vhdl.ghdl.run` is `onType`.
- `vhdl.workspace.sourceGlobs`: Glob patterns used to discover VHDL source files for workspace indexing and navigation.
- `vhdl.workspace.includeGhdlStandardLibraries`: Whether to index GHDL's bundled `ieee` and `std` libraries for hover, definition, and completion support.
- `vhdl.workspace.indexing.enabled`: Whether workspace-wide indexing is enabled for navigation features.
- `vhdl.workspace.indexing.rescanIntervalMs`: How often the workspace indexer re-scans files. Set to `0` to disable periodic rescans.

## AI Authorship Notice

Most of the code in this repository was written by AI, but it has been verified by a competent human.

## License

MIT
