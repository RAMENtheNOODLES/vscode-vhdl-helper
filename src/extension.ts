import * as vscode from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  RevealOutputChannelOn,
  ServerOptions,
  TransportKind,
  Trace,
  State
} from 'vscode-languageclient/node';

import * as path from 'path';

let client: LanguageClient | undefined;
let startCount = 0;

const output = vscode.window.createOutputChannel('VHDL Language Server');
const trace = vscode.window.createOutputChannel('VHDL LS Trace');

function stateName(s: State): string {
  switch (s) {
    case State.Stopped: return 'Stopped';
    case State.Starting: return 'Starting';
    case State.Running: return 'Running';
    default: return String(s);
  }
}

type VhdlFunctionParameter = {
  label: string;
};

type VhdlFunctionSignature = {
  name: string;
  returnType: string;
  parameters: VhdlFunctionParameter[];
  label: string;
};

export function activate(context: vscode.ExtensionContext) {
  // --- LSP client ---
  if (!client) {
    console.log('[vhdl-helper] Launching Language Client');
    startLanguageClient(context);
  }

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

  const functionSignatureProvider = vscode.languages.registerSignatureHelpProvider(
    'vhdl',
    {
      provideSignatureHelp(document, position) {
        const signatures = parseVhdlFunctions(document.getText());
        if (signatures.length === 0) {
          return null;
        }

        const callContext = getFunctionCallContext(document, position);
        if (!callContext) {
          return null;
        }

        const matching = signatures.filter(
          s => s.name.toLowerCase() === callContext.functionName.toLowerCase()
        );

        if (matching.length === 0) {
          return null;
        }

        const help = new vscode.SignatureHelp();
        help.signatures = matching.map((fn): vscode.SignatureInformation => {
          const info = new vscode.SignatureInformation(fn.label);
          info.parameters = fn.parameters.map((p) => new vscode.ParameterInformation(p.label));
          return info;
        });

        help.activeSignature = 0;
        const activeSignature = matching[0];
        help.activeParameter = Math.min(
          callContext.activeParameter,
          Math.max(activeSignature.parameters.length - 1, 0)
        );
        return help;
      },
    },
    '(',
    ','
  );

  context.subscriptions.push(
    toDutDisposable,
    toSignalsDisposable,
    headerCompletionProvider,
    functionSignatureProvider
  );
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}

function startLanguageClient(context: vscode.ExtensionContext): void {
  startCount += 1;
  output.appendLine(`[vhdl-helper] startLanguageClient() call #${startCount}`);

  if (client) return;

  let serverModule: string;
  try {
    serverModule = require.resolve('vhdl-language-server/dist/server.js');
  } catch (e) {
    output.appendLine(`[vhdl-helper] Failed to resolve server module: ${String(e)}`);
    return;
  }

  const nodeExe = process.execPath;
  const serverOptions: ServerOptions = {
    run: { command: nodeExe, args: [serverModule, '--stdio'], transport: TransportKind.stdio },
    debug: { command: nodeExe, args: [serverModule, '--stdio'], transport: TransportKind.stdio },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'vhdl' }],
    outputChannel: output,
    traceOutputChannel: trace,
    revealOutputChannelOn: RevealOutputChannelOn.Never,
  };

  client = new LanguageClient(
    'vhdlLanguageServer',
    'VHDL Language Server',
    serverOptions,
    clientOptions
  );

  client.onDidChangeState((e) => {
    output.appendLine(`[client] state changed: ${stateName(e.oldState)} -> ${stateName(e.newState)}`);
  });

  client.setTrace(Trace.Verbose);

  // Correct lifecycle management for v9: start() returns Disposable
  client.start().then(
    () => output.appendLine('[client] start() resolved'),
    (e) => output.appendLine(`[client] start() rejected: ${String(e)}`)
  );

  // Ensure it is stopped on extension deactivation
  context.subscriptions.push({
    dispose: () => {
      void client?.stop();
    },
  });
}

function buildHeaderSnippet(authorName: string, courseName: string): vscode.SnippetString {
  const snippet = new vscode.SnippetString();
  snippet.appendText(`--========================================
--
-- Author:\t`);
  snippet.appendText(authorName);
  snippet.appendText(
    `\n-- Date:\t`
  );
  snippet.appendVariable('CURRENT_MONTH_NAME', '');
  snippet.appendText(` `);
  snippet.appendVariable('CURRENT_DATE', '');
  snippet.appendText(`, `);
  snippet.appendVariable('CURRENT_YEAR', '');
  snippet.appendText(`\n-- Course:\t`);
  snippet.appendText(courseName);
  snippet.appendText(`\n--
-- Description: `);
  snippet.appendTabstop();
  snippet.appendText(`\n--\t\t`);
  snippet.appendTabstop();
  snippet.appendText(`\n--\t\t`);
  snippet.appendTabstop();
  snippet.appendText(`\n--\t\tY=`);
  snippet.appendTabstop();
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

function parseVhdlFunctions(text: string): VhdlFunctionSignature[] {
  const out: VhdlFunctionSignature[] = [];
  const functionKeyword = /\bfunction\s+(\w+)\b/gi;
  let match: RegExpExecArray | null;

  while ((match = functionKeyword.exec(text)) !== null) {
    const name = match[1];
    let i = functionKeyword.lastIndex;

    while (i < text.length && /\s/.test(text[i])) {
      i += 1;
    }

    let rawParams = '';
    if (text[i] === '(') {
      const paramStart = i + 1;
      let depth = 1;
      i += 1;

      while (i < text.length && depth > 0) {
        if (text[i] === '(') depth += 1;
        else if (text[i] === ')') depth -= 1;
        i += 1;
      }

      if (depth !== 0) {
        continue;
      }

      rawParams = text.slice(paramStart, i - 1);

      while (i < text.length && /\s/.test(text[i])) {
        i += 1;
      }
    }

    const returnWord = text.slice(i, i + 6).toLowerCase();
    if (returnWord !== 'return') {
      continue;
    }
    i += 6;

    while (i < text.length && /\s/.test(text[i])) {
      i += 1;
    }

    const returnStart = i;
    let depth = 0;
    let returnEnd = -1;

    while (i < text.length) {
      const ch = text[i];
      if (ch === '(') {
        depth += 1;
        i += 1;
        continue;
      }
      if (ch === ')' && depth > 0) {
        depth -= 1;
        i += 1;
        continue;
      }
      if (depth === 0 && ch === ';') {
        returnEnd = i;
        break;
      }
      if (depth === 0 && isWordAt(text, i, 'is')) {
        returnEnd = i;
        break;
      }
      i += 1;
    }

    if (returnEnd === -1) {
      continue;
    }

    const returnType = text.slice(returnStart, returnEnd).trim();
    const parameters = parseVhdlParameterList(rawParams);
    const label = parameters.length > 0
      ? `function ${name}(${parameters.map(p => p.label).join('; ')}) return ${returnType}`
      : `function ${name} return ${returnType}`;

    out.push({ name, returnType, parameters, label });
  }

  return out;
}

function isWordAt(text: string, index: number, word: string): boolean {
  const end = index + word.length;
  if (end > text.length) {
    return false;
  }

  if (text.slice(index, end).toLowerCase() !== word.toLowerCase()) {
    return false;
  }

  const before = index > 0 ? text[index - 1] : ' ';
  const after = end < text.length ? text[end] : ' ';
  return !/[a-zA-Z0-9_]/.test(before) && !/[a-zA-Z0-9_]/.test(after);
}

function parseVhdlParameterList(rawParams: string): VhdlFunctionParameter[] {
  const parameters: VhdlFunctionParameter[] = [];
  const parts = rawParams
    .split(';')
    .map(p => p.trim())
    .filter(Boolean);

  for (const part of parts) {
    const m = /^([\w,\s]+)\s*:\s*(?:(in|out|inout|buffer)\s+)?(.+)$/i.exec(part);
    if (!m) {
      continue;
    }

    const names = m[1].split(',').map(s => s.trim()).filter(Boolean);
    const mode = (m[2] ?? 'in').trim().toLowerCase();
    const typeText = m[3].replace(/\s*:=\s*[\s\S]*$/i, '').trim();

    for (const name of names) {
      parameters.push({ label: `${name} : ${mode} ${typeText}` });
    }
  }

  return parameters;
}

function getFunctionCallContext(
  document: vscode.TextDocument,
  position: vscode.Position
): { functionName: string; activeParameter: number } | null {
  const text = document.getText();
  const cursorOffset = document.offsetAt(position);
  const stack: Array<{ openOffset: number; functionName: string | null }> = [];

  let inComment = false;
  for (let i = 0; i < cursorOffset; i++) {
    const ch = text[i];
    const next = i + 1 < cursorOffset ? text[i + 1] : '';

    if (inComment) {
      if (ch === '\n') {
        inComment = false;
      }
      continue;
    }

    if (ch === '-' && next === '-') {
      inComment = true;
      i += 1;
      continue;
    }

    if (ch === '(') {
      const fnName = extractFunctionNameBeforeParen(text, i);
      stack.push({ openOffset: i, functionName: fnName });
      continue;
    }

    if (ch === ')' && stack.length > 0) {
      stack.pop();
    }
  }

  for (let i = stack.length - 1; i >= 0; i--) {
    const frame = stack[i];
    if (!frame.functionName) {
      continue;
    }

    const activeParameter = countTopLevelCommas(text, frame.openOffset + 1, cursorOffset);
    return {
      functionName: frame.functionName,
      activeParameter,
    };
  }

  return null;
}

function extractFunctionNameBeforeParen(text: string, openParenOffset: number): string | null {
  let i = openParenOffset - 1;

  while (i >= 0 && /\s/.test(text[i])) {
    i -= 1;
  }

  if (i < 0) {
    return null;
  }

  let end = i;
  while (i >= 0 && /[a-zA-Z0-9_]/.test(text[i])) {
    i -= 1;
  }

  const start = i + 1;
  if (start > end) {
    return null;
  }

  const name = text.slice(start, end + 1);
  if (!/^[a-zA-Z]\w*$/.test(name)) {
    return null;
  }

  return name;
}

function countTopLevelCommas(text: string, startOffset: number, endOffset: number): number {
  let depth = 0;
  let inComment = false;
  let commas = 0;

  for (let i = startOffset; i < endOffset; i++) {
    const ch = text[i];
    const next = i + 1 < endOffset ? text[i + 1] : '';

    if (inComment) {
      if (ch === '\n') {
        inComment = false;
      }
      continue;
    }

    if (ch === '-' && next === '-') {
      inComment = true;
      i += 1;
      continue;
    }

    if (ch === '(') {
      depth += 1;
      continue;
    }

    if (ch === ')' && depth > 0) {
      depth -= 1;
      continue;
    }

    if (ch === ',' && depth === 0) {
      commas += 1;
    }
  }

  return commas;
}
