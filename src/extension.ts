import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  // Existing command: Clipboard COMPONENT -> DUT PORT MAP
  const toDutDisposable = vscode.commands.registerCommand(
    'vhdlHelper.clipboardComponentToDut',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const clipboardText = await vscode.env.clipboard.readText();
      if (!clipboardText || !clipboardText.trim()) {
        vscode.window.showInformationMessage('VHDL Helper: Clipboard is empty.');
        return;
      }

      const transformed = transformComponentToPortMap(clipboardText);
      if (!transformed) {
        vscode.window.showInformationMessage(
          'VHDL Helper: No valid COMPONENT block found in clipboard.'
        );
        return;
      }

      const sel = editor.selection;
      await editor.edit(editBuilder => {
        if (sel && !sel.isEmpty) {
          editBuilder.replace(sel, transformed);
        } else {
          editBuilder.insert(sel.active, transformed);
        }
      });
    }
  );

  // NEW command: Clipboard COMPONENT -> SIGNAL declarations
  const toSignalsDisposable = vscode.commands.registerCommand(
    'vhdlHelper.clipboardComponentToSignals',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const clipboardText = await vscode.env.clipboard.readText();
      if (!clipboardText || !clipboardText.trim()) {
        vscode.window.showInformationMessage('VHDL Helper: Clipboard is empty.');
        return;
      }

      const signals = transformComponentToSignals(clipboardText, {
        stripPrefixes: ['i_', 'o_'], // extendable: e.g., ['i_', 'o_', 'b_', 'io_']
        forceLowercaseNames: false,   // set true if you want all signal names lowercased
      });

      if (!signals) {
        vscode.window.showInformationMessage(
          'VHDL Helper: No valid COMPONENT/PORT block found in clipboard.'
        );
        return;
      }

      const sel = editor.selection;
      await editor.edit(editBuilder => {
        if (sel && !sel.isEmpty) {
          editBuilder.replace(sel, signals);
        } else {
          editBuilder.insert(sel.active, signals);
        }
      });
    }
  );

  const headerCompletionProvider = vscode.languages.registerCompletionItemProvider(
    'vhdl',
    {
      provideCompletionItems(document, position) {
        const config = vscode.workspace.getConfiguration('vhdlHelper');
        const authorName = config.get<string>('authorName') ?? '';
        const courseName = config.get<string>('courseName') ?? '';
        const item = new vscode.CompletionItem(
          'header',
          vscode.CompletionItemKind.Snippet
        );
        item.detail = 'VHDL Helper: Header snippet';
        item.insertText = buildHeaderSnippet(authorName, courseName);
        item.preselect = true;
        item.sortText = '0';
        const range = document.getWordRangeAtPosition(position, /\w+/);
        if (range) {
          item.range = range;
        }
        return [item];
      },
    }
  );

  context.subscriptions.push(
    toDutDisposable,
    toSignalsDisposable,
    headerCompletionProvider
  );
}

export function deactivate() {}

function buildHeaderSnippet(authorName: string, courseName: string): vscode.SnippetString {
  const snippet = new vscode.SnippetString();
  snippet.appendText(`--========================================
--
-- Author:\t`);
  snippet.appendPlaceholder(authorName, 1);
  snippet.appendText(
    `\n-- Date:\t$CURRENT_MONTH_NAME $CURRENT_DATE, $CURRENT_YEAR
-- Course:\t`
  );
  snippet.appendPlaceholder(courseName, 2);
  snippet.appendText(`\n--
-- Description: `);
  snippet.appendPlaceholder('', 3);
  snippet.appendText(`\n--\t\t`);
  snippet.appendPlaceholder('', 4);
  snippet.appendText(`\n--\t\t`);
  snippet.appendPlaceholder('', 5);
  snippet.appendText(`\n--\t\tY=`);
  snippet.appendPlaceholder('', 6);
  snippet.appendText(
    `\n--========================================

-- Library Declaration
LIBRARY ieee;
USE ieee.std_logic_1164.all;

`
  );
  snippet.appendTabstop(0);
  return snippet;
}

/**
 * Transform a VHDL COMPONENT declaration (from clipboard) into a DUT PORT MAP.
 * Uses:
 *   dut : <COMPONENT_NAME>
 *   PORT MAP(
 *     i_a => a,
 *     ...
 *   );
 * with tabbed inner lines.
 */
function transformComponentToPortMap(text: string): string | null {
  const lines = text.split(/\r?\n/);

  // 1. Find COMPONENT line and extract name
  const componentRegex = /^\s*COMPONENT\s+(\w+)\s+IS\s*$/i;
  let componentName: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const m = componentRegex.exec(lines[i]);
    if (m) {
      componentName = m[1];
      break;
    }
  }

  if (!componentName) {
    return null;
  }

  // 2. Find PORT (...) block
  const portStartRegex = /^\s*PORT\s*\(\s*$/i;
  const portEndRegex = /^\s*\)\s*;\s*$/;
  let portStartIndex = -1;
  let portEndIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    if (portStartIndex === -1 && portStartRegex.test(lines[i])) {
      portStartIndex = i;
      continue;
    }
    if (portStartIndex !== -1 && portEndRegex.test(lines[i])) {
      portEndIndex = i;
      break;
    }
  }

  if (portStartIndex === -1 || portEndIndex === -1) {
    return null;
  }

  // 3. Extract port lines between PORT ( and );
  const portLines = lines.slice(portStartIndex + 1, portEndIndex);

  const mappingLines: string[] = [];

  for (const rawLine of portLines) {
    const withoutComment = rawLine.replace(/--.*$/, '');
    const line = withoutComment.trim();
    if (!line) continue;

    // Match: name : IN/OUT/INOUT/BUFFER ...;  (tolerate optional trailing semicolon)
    const portRegex = /^([\w, \t]+)\s*:\s*(IN|OUT|INOUT|BUFFER)\b.*;?$/i;
    const m = portRegex.exec(line);
    if (!m) {
      // Keep unrecognized lines as-is (indented)
      mappingLines.push(`\t${line}`);
      continue;
    }

    // Support comma-grouped names
    const names = m[1].split(',').map(s => s.trim()).filter(Boolean);

    for (const portName of names) {
      let signalName = portName;
      if (signalName.startsWith('i_') || signalName.startsWith('o_')) {
        signalName = signalName.slice(2);
      }
      mappingLines.push(`\t${portName} => ${signalName},`);
    }
  }

  // 4. Remove trailing comma from last mapping line
  if (mappingLines.length > 0) {
    const lastIdx = mappingLines.length - 1;
    mappingLines[lastIdx] = mappingLines[lastIdx].replace(/,\s*$/, '');
  }

  // 5. Build result with tabbed innards
  const result: string[] = [];
  result.push(`dut : ${componentName}`);
  result.push(`PORT MAP(`);
  result.push(...mappingLines);
  result.push(`);`);

  return result.join('\n');
}

/**
 * Transform a VHDL COMPONENT declaration (from clipboard) into SIGNAL declarations.
 * - Extracts the PORT (...) block
 * - Supports comma-grouped identifiers: a, b : in std_logic;
 * - Strips configured prefixes (default: i_, o_)
 * - Preserves type text (e.g., STD_LOGIC, STD_LOGIC_VECTOR(7 downto 0), signed, etc.)
 * - Ignores direction (IN/OUT/INOUT/BUFFER)
 */
function transformComponentToSignals(
  text: string,
  options?: {
    stripPrefixes?: string[];
    forceLowercaseNames?: boolean;
  }
): string | null {
  const stripPrefixes = options?.stripPrefixes ?? ['i_', 'o_'];
  const forceLower = options?.forceLowercaseNames ?? false;

  const lines = text.split(/\r?\n/);

  // Locate PORT block boundaries
  const portStartRegex = /^\s*PORT\s*\(\s*$/i;
  const portEndRegex = /^\s*\)\s*;\s*$/;
  let portStartIndex = -1;
  let portEndIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    if (portStartIndex === -1 && portStartRegex.test(lines[i])) {
      portStartIndex = i;
      continue;
    }
    if (portStartIndex !== -1 && portEndRegex.test(lines[i])) {
      portEndIndex = i;
      break;
    }
  }

  if (portStartIndex === -1 || portEndIndex === -1) {
    return null;
  }

  // Extract lines inside the PORT block
  const rawPortLines = lines.slice(portStartIndex + 1, portEndIndex);

  // Coalesce into complete statements (some types may wrap lines)
  const statements: string[] = [];
  let buf: string[] = [];

  const flushIfComplete = () => {
    if (buf.length === 0) return;
    const joined = buf.join(' ').replace(/\s+/g, ' ').trim();
    // Most port decls end with ';' — but the last one might not.
    statements.push(joined.replace(/;+\s*$/, ''));
    buf = [];
  };

  for (const raw of rawPortLines) {
    const noComment = raw.replace(/--.*$/, '');
    if (!noComment.trim()) continue;
    buf.push(noComment.trim());
    if (/[;]$/.test(noComment.trim())) {
      flushIfComplete();
    }
  }
  // Flush any remaining partial (e.g., last line missing ;)
  flushIfComplete();

  const resultLines: string[] = [];

  for (const stmt of statements) {
    // Expect: names : mode type [:= default]
    // Capture groups:
    // 1: names (possibly comma-separated)
    // 2: mode
    // 3: type (+ possible default) -> we'll trim default
    const m = /^([\w,\s]+)\s*:\s*(IN|OUT|INOUT|BUFFER)\s+(.+)$/i.exec(stmt);
    if (!m) {
      // Skip lines that are not standard port decls (e.g., blank or malformed)
      continue;
    }

    // Split and clean names
    const names = m[1].split(',').map(s => s.trim()).filter(Boolean);

    // Clean type: drop default assignments if present
    let typePart = m[3].trim();
    // Drop default assignment ':= ...' if specified
    typePart = typePart.replace(/\s*:=\s*[^;]+$/i, '').trim();

    // Also remove any trailing commas (shouldn't be present after coalescing)
    typePart = typePart.replace(/,+\s*$/, '').trim();

    for (let name of names) {
      // Strip configured prefixes
      for (const pfx of stripPrefixes) {
        if (name.startsWith(pfx)) {
          name = name.slice(pfx.length);
          break;
        }
      }

      if (forceLower) name = name.toLowerCase();

      resultLines.push(`SIGNAL ${name} : ${typePart};`);
    }
  }

  if (resultLines.length === 0) {
    return null;
  }

  return resultLines.join('\n');
}
