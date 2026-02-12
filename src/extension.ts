import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand(
    'vhdlHelper.clipboardComponentToDut',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }

      // 1. Read COMPONENT block from clipboard
      const clipboardText = await vscode.env.clipboard.readText();
      if (!clipboardText || !clipboardText.trim()) {
        vscode.window.showInformationMessage('VHDL Helper: Clipboard is empty.');
        return;
      }

      // 2. Transform to DUT PORT MAP with tabbed innards
      const transformed = transformComponentToPortMap(clipboardText);
      if (!transformed) {
        vscode.window.showInformationMessage(
          'VHDL Helper: No valid COMPONENT block found in clipboard.'
        );
        return;
      }

      // 3. Insert at current cursor position (or replace selection)
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

  context.subscriptions.push(disposable);
}

export function deactivate() {}

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
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    // Match: name : IN/OUT/INOUT ...;
    const portRegex = /^(\w+)\s*:\s*(IN|OUT|INOUT)\b.*;?$/i;
    const m = portRegex.exec(line);
    if (!m) {
      // Keep unrecognized lines as-is (indented)
      mappingLines.push(`\t${line}`);
      continue;
    }

    const portName = m[1];

    // Derive signal name, stripping i_/o_ if present
    let signalName = portName;
    if (signalName.startsWith('i_') || signalName.startsWith('o_')) {
      signalName = signalName.slice(2);
    }

    mappingLines.push(`\t${portName} => ${signalName},`);
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