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
  packageName?: string;
  sourceUri?: string;
  declarationOffset?: number;
};

type FunctionCallContext = {
  functionName: string;
  packageQualifier?: string;
  activeParameter: number;
};

type VhdlTypedSymbolKind = 'signal' | 'variable' | 'constant' | 'port' | 'generic';

type VhdlTypedSymbol = {
  name: string;
  typeText: string;
  kind: VhdlTypedSymbolKind;
  sourceUri?: string;
  packageName?: string;
  declarationOffset?: number;
};

type OriginCandidate = {
  kind: string;
  name: string;
  packageName?: string;
  sourceUri: string;
  declarationOffset?: number;
};

const workspaceFunctionCache = new Map<string, VhdlFunctionSignature[]>();
const workspaceSymbolCache = new Map<string, VhdlTypedSymbol[]>();
const vhdlFileGlob = '**/*.{vhd,vhdl,vho,vht}';

// Decoration type for unused symbols — subtle gray, no squiggly underline
const unusedSymbolDecoration = vscode.window.createTextEditorDecorationType({
  color: 'rgba(120, 124, 128, 0.65)',
  backgroundColor: 'rgba(120, 124, 128, 0.03)',
  fontStyle: 'italic',
  borderRadius: '2px',
  overviewRulerColor: 'rgba(120, 124, 128, 0.25)',
  overviewRulerLane: vscode.OverviewRulerLane.Right,
});

// Cache for unused symbols per document
const unusedSymbolsCache = new Map<string, UnusedSymbol[]>();

type UnusedSymbol = {
  name: string;
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
};

export function activate(context: vscode.ExtensionContext) {
  output.appendLine('\n\n========== VHDL HELPER EXTENSION ACTIVATED ==========');
  output.appendLine(`[vhdl-helper] Activation time: ${new Date().toISOString()}`);
  
  // --- LSP client ---
  if (!client) {
    console.log('[vhdl-helper] Launching Language Client');
    startLanguageClient(context);
  }

  output.appendLine('[vhdl-helper] Extension activation started');

  void initializeWorkspaceFunctionIndex();
  for (const doc of vscode.workspace.textDocuments) {
    updateWorkspaceFunctionCacheForDocument(doc);
    updateWorkspaceSymbolCacheForDocument(doc);
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

  const openOriginDisposable = vscode.commands.registerCommand(
    'vhdlHelper.openOrigin',
    async (arg?: { sourceUri?: string; declarationOffset?: number }) => {
      const sourceUri = arg?.sourceUri;
      if (!sourceUri) {
        return;
      }

      try {
        const uri = vscode.Uri.parse(sourceUri);
        const document = await vscode.workspace.openTextDocument(uri);

        if (typeof arg?.declarationOffset === 'number' && arg.declarationOffset >= 0) {
          const position = document.positionAt(arg.declarationOffset);
          await vscode.window.showTextDocument(document, {
            preview: false,
            selection: new vscode.Range(position, position),
          });
          return;
        }

        await vscode.window.showTextDocument(document, { preview: false });
      } catch (error) {
        output.appendLine(`[vhdl-helper] Failed to open origin: ${String(error)}`);
      }
    }
  );

  const refreshGhdlCacheDisposable = vscode.commands.registerCommand(
    'vhdlHelper.refreshGhdlCache',
    async () => {
      if (!client || !client.isRunning()) {
        vscode.window.showErrorMessage('VHDL Helper: Language server is not running.');
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Refreshing GHDL cache and re-analyzing workspace',
          cancellable: false,
        },
        async () => {
          try {
            output.appendLine('[vhdl-helper] Sending vhdl/refreshGhdlCache request to server...');
            
            // Send custom LSP request to server
            const result = await client!.sendRequest('vhdl/refreshGhdlCache', {});
            
            output.appendLine(`[vhdl-helper] Server refresh completed: ${JSON.stringify(result)}`);
            
            // Refresh decorations for visible editors
            for (const editor of vscode.window.visibleTextEditors) {
              if (isVhdlDocument(editor.document)) {
                await applyUnusedSymbolDecorations(editor);
              }
            }
            
            // Show summary message
            const summary = result as any;
            const filesProcessed = summary.filesProcessed || 0;
            const filesSuccessful = summary.filesSuccessful || 0;
            const cacheFilesCleared = summary.cacheFilesCleared || 0;
            
            vscode.window.showInformationMessage(
              `VHDL Helper: Refreshed GHDL cache. ${filesProcessed} file${filesProcessed === 1 ? '' : 's'} processed, ${filesSuccessful} compiled successfully, ${cacheFilesCleared} cache file${cacheFilesCleared === 1 ? '' : 's'} cleared.`
            );
          } catch (error) {
            output.appendLine(`[vhdl-helper] Error refreshing GHDL cache: ${String(error)}`);
            vscode.window.showErrorMessage(`VHDL Helper: Failed to refresh GHDL cache: ${String(error)}`);
          }
        }
      );
    }
  );

  // TEST command: Highlight unused symbols
  const testHighlightUnusedDisposable = vscode.commands.registerCommand(
    'vhdlHelper.testHighlightUnused',
    async () => {
      output.appendLine('\n========== TEST COMMAND TRIGGERED ==========');
      output.appendLine(`[vhdl-helper] testHighlightUnused command triggered at ${new Date().toISOString()}`);
      
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        output.appendLine('[vhdl-helper] ERROR: No active editor');
        vscode.window.showErrorMessage('No active editor');
        return;
      }

      output.appendLine(`[vhdl-helper] Active editor: ${editor.document.fileName}`);
      output.appendLine(`[vhdl-helper] Language ID: ${editor.document.languageId}`);
      output.appendLine(`[vhdl-helper] Document URI: ${editor.document.uri.toString()}`);
      
      if (!isVhdlDocument(editor.document)) {
        output.appendLine('[vhdl-helper] ERROR: Not a VHDL document');
        vscode.window.showErrorMessage('Not a VHDL document');
        return;
      }

      output.appendLine('[vhdl-helper] Document is VHDL, applying decorations...');
      await applyUnusedSymbolDecorations(editor);
      output.appendLine('[vhdl-helper] Test command completed');
      vscode.window.showInformationMessage('Unused symbols highlighting complete. Check output panel.');
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
        item.sortText = 'zzzz_header';
        const range = document.getWordRangeAtPosition(position, /\w+/);
        if (range) {
          item.range = range;
        }
        return [item];
      },
    }
  );

  const parameterAwareCompletionProvider = vscode.languages.registerCompletionItemProvider(
    'vhdl',
    {
      provideCompletionItems(document, position) {
        const callContext = getFunctionCallContext(document, position);
        if (!callContext) {
          return null;
        }

        const matching = resolveMatchingFunctionSignatures(document, callContext);
        if (matching.length === 0) {
          return null;
        }

        const expectedTypes = getExpectedParameterTypes(matching, callContext.activeParameter);
        if (expectedTypes.size === 0) {
          return null;
        }

        const documentUri = document.uri.toString();
        const documentText = document.getText();
        const cursorOffset = document.offsetAt(position);
        const usedPackages = collectUsedPackagesBeforeOffset(documentText, cursorOffset);
        const cursorScopeStack = getScopeStackAtOffset(documentText, cursorOffset);
        const localSymbols = parseVhdlTypedSymbols(document.getText()).map((s) => ({
          ...s,
          sourceUri: documentUri,
        }));
        const workspaceSymbols = getWorkspaceSymbolsExcluding(documentUri);
        const allSymbols = dedupeTypedSymbols([...localSymbols, ...workspaceSymbols]);

        const ranked = allSymbols
          .map((symbol) => ({
            symbol,
            score: scoreSymbolAgainstExpectedTypes(
              symbol,
              expectedTypes,
              {
                documentUri,
                cursorOffset,
                cursorScopeStack,
                usedPackages,
                documentText,
              }
            ),
          }))
          .filter((entry) => entry.score < 1000)
          .sort((a, b) => {
            if (a.score !== b.score) return a.score - b.score;
            return a.symbol.name.localeCompare(b.symbol.name);
          })
          .slice(0, 200);

        if (ranked.length === 0) {
          return null;
        }

        const bestScore = ranked[0].score;

        return ranked.map((entry, index): vscode.CompletionItem => {
          const item = new vscode.CompletionItem(
            entry.symbol.name,
            completionKindForSymbol(entry.symbol.kind)
          );
          item.detail = `${entry.symbol.kind} : ${entry.symbol.typeText}`;
          const band = completionPriorityBand(entry.score);
          item.sortText = `!${band}_${String(entry.score).padStart(4, '0')}_${entry.symbol.name.toLowerCase()}`;
          item.filterText = entry.symbol.name;
          item.insertText = entry.symbol.name;
          if (index === 0 || entry.score === bestScore) {
            item.preselect = index === 0;
          }
          return item;
        });
      },
    },
    '(',
    ',',
    ' '
  );

  const functionSignatureProvider = vscode.languages.registerSignatureHelpProvider(
    'vhdl',
    {
      provideSignatureHelp(document, position) {
        const documentUri = document.uri.toString();
        const localSignatures = parseVhdlFunctions(document.getText()).map(sig => ({
          ...sig,
          sourceUri: documentUri,
        }));
        const cachedWorkspaceSignatures = getWorkspaceSignaturesExcluding(documentUri);
        const signatures = dedupeSignatures([...localSignatures, ...cachedWorkspaceSignatures]);

        if (signatures.length === 0) {
          return null;
        }

        const callContext = getFunctionCallContext(document, position);
        if (!callContext) {
          return null;
        }

        const matching = resolveMatchingFunctionSignatures(document, callContext, signatures);

        if (matching.length === 0) {
          return null;
        }

        const help = new vscode.SignatureHelp();
        help.signatures = matching.map((fn): vscode.SignatureInformation => {
          const info = new vscode.SignatureInformation(fn.label);
          info.parameters = fn.parameters.map((p) => new vscode.ParameterInformation(p.label));
          if (fn.packageName) {
            info.documentation = new vscode.MarkdownString(`Package: ${fn.packageName}`);
          }
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


  const originHoverProvider = vscode.languages.registerHoverProvider(
    'vhdl',
    {
      provideHover(document, position) {
        const range = document.getWordRangeAtPosition(position, /[a-zA-Z]\w*/);
        if (!range) {
          return null;
        }

        const symbolName = document.getText(range);
        if (!symbolName) {
          return null;
        }

        if (isSymbolFromCurrentFile(document, symbolName)) {
          return null;
        }

        const context = getHoverContext(document, range.start);
        const candidates = resolveExternalOriginCandidates(document, symbolName, context);
        if (candidates.length === 0) {
          return null;
        }

        const markdown = new vscode.MarkdownString();
        markdown.isTrusted = true;
        const shown = candidates.slice(0, 4);

        for (const candidate of shown) {
          const sourceLabel = formatOriginSourceLabel(candidate.sourceUri, document.uri);
          const packagePart = candidate.packageName ? `, package ${candidate.packageName}` : '';
          const openLink = buildOpenOriginCommandLink(candidate);
          markdown.appendMarkdown(`From ${candidate.kind}${packagePart}: ${sourceLabel} ([Open](${openLink}))`);
          markdown.appendMarkdown('  \n');
        }

        if (candidates.length > shown.length) {
          markdown.appendMarkdown(`(+${candidates.length - shown.length} more matches)`);
        }

        return new vscode.Hover(markdown, range);
      },
    }
  );
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => {
      output.appendLine(`[vhdl-helper] onDidOpenTextDocument: ${document.fileName}`);
      updateWorkspaceFunctionCacheForDocument(document);
      updateWorkspaceSymbolCacheForDocument(document);
      if (isVhdlDocument(document)) {
        output.appendLine(`[vhdl-helper] VHDL document opened, scheduling decoration update`);
        // Schedule the decoration update with a small delay to ensure editor is ready
        setTimeout(() => {
          for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document.uri.toString() === document.uri.toString()) {
              output.appendLine(`[vhdl-helper] Found editor for ${document.fileName}, applying decorations`);
              applyUnusedSymbolDecorations(editor);
              break;
            }
          }
        }, 100);
      }
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      output.appendLine(`[vhdl-helper] onDidChangeTextDocument: ${event.document.fileName}`);
      updateWorkspaceFunctionCacheForDocument(event.document);
      updateWorkspaceSymbolCacheForDocument(event.document);
      if (isVhdlDocument(event.document)) {
        output.appendLine(`[vhdl-helper] VHDL document changed, updating decorations`);
        for (const editor of vscode.window.visibleTextEditors) {
          if (editor.document.uri.toString() === event.document.uri.toString()) {
            output.appendLine(`[vhdl-helper] Updating decorations for ${event.document.fileName}`);
            void applyUnusedSymbolDecorations(editor);
            break;
          }
        }
      }
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      output.appendLine(`[vhdl-helper] onDidSaveTextDocument: ${document.fileName}`);
      updateWorkspaceFunctionCacheForDocument(document);
      updateWorkspaceSymbolCacheForDocument(document);
      if (isVhdlDocument(document)) {
        output.appendLine(`[vhdl-helper] VHDL document saved, updating decorations`);
        for (const editor of vscode.window.visibleTextEditors) {
          if (editor.document.uri.toString() === document.uri.toString()) {
            output.appendLine(`[vhdl-helper] Updating decorations for saved document ${document.fileName}`);
            void applyUnusedSymbolDecorations(editor);
            break;
          }
        }
      }
    }),
    vscode.workspace.onDidCreateFiles((event) => {
      for (const file of event.files) {
        void indexVhdlFile(file);
      }
    }),
    vscode.workspace.onDidDeleteFiles((event) => {
      for (const file of event.files) {
        workspaceFunctionCache.delete(file.toString());
        workspaceSymbolCache.delete(file.toString());
        unusedSymbolsCache.delete(file.toString());
      }
    }),
    vscode.workspace.onDidRenameFiles((event) => {
      for (const renamed of event.files) {
        workspaceFunctionCache.delete(renamed.oldUri.toString());
        workspaceSymbolCache.delete(renamed.oldUri.toString());
        unusedSymbolsCache.delete(renamed.oldUri.toString());
        void indexVhdlFile(renamed.newUri);
      }
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && isVhdlDocument(editor.document)) {
        output.appendLine(`[vhdl-helper] Active editor changed to VHDL: ${editor.document.fileName}`);
        void applyUnusedSymbolDecorations(editor);
      }
    }),
    toDutDisposable,
    toSignalsDisposable,
    openOriginDisposable,
    refreshGhdlCacheDisposable,
    testHighlightUnusedDisposable,
    headerCompletionProvider,
    parameterAwareCompletionProvider,
    functionSignatureProvider,
    originHoverProvider
  );

  // Apply initial decorations to all visible VHDL editors
  output.appendLine(`[vhdl-helper] Applying initial decorations to ${vscode.window.visibleTextEditors.length} visible editors`);
  for (const editor of vscode.window.visibleTextEditors) {
    if (isVhdlDocument(editor.document)) {
      output.appendLine(`[vhdl-helper] Applying initial decorations to ${editor.document.fileName}`);
      setTimeout(() => void applyUnusedSymbolDecorations(editor), 100);
    }
  }
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

async function initializeWorkspaceFunctionIndex(): Promise<void> {
  try {
    const files = await vscode.workspace.findFiles(vhdlFileGlob);
    await Promise.all(files.map((file) => indexVhdlFile(file)));
    output.appendLine(`[vhdl-helper] Indexed VHDL function signatures from ${files.length} files.`);
  } catch (error) {
    output.appendLine(`[vhdl-helper] Failed to build function index: ${String(error)}`);
  }
}

async function indexVhdlFile(fileUri: vscode.Uri): Promise<void> {
  if (!isVhdlFileUri(fileUri)) {
    return;
  }

  try {
    const document = await vscode.workspace.openTextDocument(fileUri);
    updateWorkspaceFunctionCacheForDocument(document);
    updateWorkspaceSymbolCacheForDocument(document);
  } catch (error) {
    output.appendLine(`[vhdl-helper] Failed to index ${fileUri.fsPath}: ${String(error)}`);
  }
}

function updateWorkspaceFunctionCacheForDocument(document: vscode.TextDocument): void {
  if (!isVhdlDocument(document)) {
    return;
  }

  const signatures = parseVhdlFunctions(document.getText()).map(sig => ({
    ...sig,
    sourceUri: document.uri.toString(),
  }));

  workspaceFunctionCache.set(document.uri.toString(), signatures);
}

function updateWorkspaceSymbolCacheForDocument(document: vscode.TextDocument): void {
  if (!isVhdlDocument(document)) {
    return;
  }

  const symbols = parseVhdlTypedSymbols(document.getText()).map((symbol) => ({
    ...symbol,
    sourceUri: document.uri.toString(),
  }));

  workspaceSymbolCache.set(document.uri.toString(), symbols);
}

function isVhdlDocument(document: vscode.TextDocument): boolean {
  return document.languageId.toLowerCase() === 'vhdl';
}

function isVhdlFileUri(fileUri: vscode.Uri): boolean {
  const lowerPath = fileUri.fsPath.toLowerCase();
  return lowerPath.endsWith('.vhd') ||
    lowerPath.endsWith('.vhdl') ||
    lowerPath.endsWith('.vho') ||
    lowerPath.endsWith('.vht');
}

function getWorkspaceSignaturesExcluding(documentUri: string): VhdlFunctionSignature[] {
  const out: VhdlFunctionSignature[] = [];
  for (const [uri, signatures] of workspaceFunctionCache.entries()) {
    if (uri === documentUri) {
      continue;
    }
    out.push(...signatures);
  }
  return out;
}

function getWorkspaceSymbolsExcluding(documentUri: string): VhdlTypedSymbol[] {
  const out: VhdlTypedSymbol[] = [];
  for (const [uri, symbols] of workspaceSymbolCache.entries()) {
    if (uri === documentUri) {
      continue;
    }
    out.push(...symbols);
  }
  return out;
}

function dedupeSignatures(signatures: VhdlFunctionSignature[]): VhdlFunctionSignature[] {
  const out: VhdlFunctionSignature[] = [];
  const seen = new Set<string>();

  for (const sig of signatures) {
    const key = [
      sig.sourceUri ?? '',
      sig.packageName ?? '',
      sig.name.toLowerCase(),
      sig.label,
    ].join('|');

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    out.push(sig);
  }

  return out;
}

function dedupeTypedSymbols(symbols: VhdlTypedSymbol[]): VhdlTypedSymbol[] {
  const out: VhdlTypedSymbol[] = [];
  const seen = new Set<string>();

  for (const symbol of symbols) {
    const key = [
      symbol.sourceUri ?? '',
      symbol.name.toLowerCase(),
      normalizeType(symbol.typeText),
      symbol.kind,
    ].join('|');

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    out.push(symbol);
  }

  return out;
}

function resolveMatchingFunctionSignatures(
  document: vscode.TextDocument,
  callContext: FunctionCallContext,
  preloadedSignatures?: VhdlFunctionSignature[]
): VhdlFunctionSignature[] {
  const signatures = preloadedSignatures ?? (() => {
    const documentUri = document.uri.toString();
    const localSignatures = parseVhdlFunctions(document.getText()).map(sig => ({
      ...sig,
      sourceUri: documentUri,
    }));
    const cachedWorkspaceSignatures = getWorkspaceSignaturesExcluding(documentUri);
    return dedupeSignatures([...localSignatures, ...cachedWorkspaceSignatures]);
  })();

  let matching = signatures.filter(
    s => s.name.toLowerCase() === callContext.functionName.toLowerCase()
  );

  if (callContext.packageQualifier) {
    const qualifiedMatches = matching.filter(
      s => (s.packageName ?? '').toLowerCase() === callContext.packageQualifier?.toLowerCase()
    );
    if (qualifiedMatches.length > 0) {
      matching = qualifiedMatches;
    }
  }

  return matching;
}

function isSymbolFromCurrentFile(document: vscode.TextDocument, symbolName: string): boolean {
  const lowered = symbolName.toLowerCase();
  const localFunctions = parseVhdlFunctions(document.getText());
  if (localFunctions.some((fn) => fn.name.toLowerCase() === lowered)) {
    return true;
  }

  const localSymbols = parseVhdlTypedSymbols(document.getText());
  return localSymbols.some((symbol) => symbol.name.toLowerCase() === lowered);
}

function getHoverContext(
  document: vscode.TextDocument,
  wordStart: vscode.Position
): { packageQualifier?: string; isFunctionCall: boolean } {
  const lineText = document.lineAt(wordStart.line).text;
  const currentOffset = document.offsetAt(wordStart);
  const lineStartOffset = document.offsetAt(new vscode.Position(wordStart.line, 0));
  const lineRelativeStart = currentOffset - lineStartOffset;

  let packageQualifier: string | undefined;
  let i = lineRelativeStart - 1;
  while (i >= 0 && /\s/.test(lineText[i])) {
    i -= 1;
  }
  if (i >= 0 && lineText[i] === '.') {
    i -= 1;
    while (i >= 0 && /\s/.test(lineText[i])) {
      i -= 1;
    }
    const end = i;
    while (i >= 0 && /[a-zA-Z0-9_]/.test(lineText[i])) {
      i -= 1;
    }
    const start = i + 1;
    if (start <= end) {
      const candidate = lineText.slice(start, end + 1);
      if (/^[a-zA-Z]\w*$/.test(candidate)) {
        packageQualifier = candidate;
      }
    }
  }

  const afterText = lineText.slice(lineRelativeStart);
  const isFunctionCall = /^\s*[a-zA-Z]\w*\s*\(/.test(afterText);

  return {
    packageQualifier,
    isFunctionCall,
  };
}

function resolveExternalOriginCandidates(
  document: vscode.TextDocument,
  symbolName: string,
  hoverContext: { packageQualifier?: string; isFunctionCall: boolean }
): OriginCandidate[] {
  const nameLower = symbolName.toLowerCase();
  const documentUri = document.uri.toString();
  const candidates: OriginCandidate[] = [];

  for (const fn of getWorkspaceSignaturesExcluding(documentUri)) {
    if (!fn.sourceUri) {
      continue;
    }
    if (fn.name.toLowerCase() !== nameLower) {
      continue;
    }
    if (hoverContext.packageQualifier && (fn.packageName ?? '').toLowerCase() !== hoverContext.packageQualifier.toLowerCase()) {
      continue;
    }
    candidates.push({
      kind: 'function',
      name: fn.name,
      packageName: fn.packageName,
      sourceUri: fn.sourceUri,
      declarationOffset: fn.declarationOffset,
    });
  }

  if (!hoverContext.isFunctionCall || candidates.length === 0) {
    for (const symbol of getWorkspaceSymbolsExcluding(documentUri)) {
      if (!symbol.sourceUri) {
        continue;
      }
      if (symbol.name.toLowerCase() !== nameLower) {
        continue;
      }
      if (hoverContext.packageQualifier && (symbol.packageName ?? '').toLowerCase() !== hoverContext.packageQualifier.toLowerCase()) {
        continue;
      }
      candidates.push({
        kind: symbol.kind,
        name: symbol.name,
        packageName: symbol.packageName,
        sourceUri: symbol.sourceUri,
        declarationOffset: symbol.declarationOffset,
      });
    }
  }

  return dedupeOriginCandidates(candidates);
}

function dedupeOriginCandidates(candidates: OriginCandidate[]): OriginCandidate[] {
  const out: OriginCandidate[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const key = [
      candidate.kind,
      candidate.name.toLowerCase(),
      candidate.packageName ?? '',
      candidate.sourceUri,
    ].join('|');

    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(candidate);
  }

  return out;
}

function formatOriginSourceLabel(sourceUri: string, currentUri: vscode.Uri): string {
  const source = vscode.Uri.parse(sourceUri);
  const relative = vscode.workspace.asRelativePath(source, false);
  const currentRelative = vscode.workspace.asRelativePath(currentUri, false);
  if (relative && relative !== currentRelative) {
    return relative;
  }
  return source.fsPath;
}

function buildOpenOriginCommandLink(candidate: OriginCandidate): string {
  const payload = encodeURIComponent(JSON.stringify([{
    sourceUri: candidate.sourceUri,
    declarationOffset: candidate.declarationOffset,
  }]));
  return `command:vhdlHelper.openOrigin?${payload}`;
}

function getExpectedParameterTypes(
  signatures: VhdlFunctionSignature[],
  activeParameterIndex: number
): Set<string> {
  const expected = new Set<string>();

  for (const signature of signatures) {
    if (signature.parameters.length === 0) {
      continue;
    }

    const safeIndex = Math.min(activeParameterIndex, signature.parameters.length - 1);
    const parameter = signature.parameters[safeIndex];
    const paramType = extractParameterTypeFromLabel(parameter.label);
    if (paramType) {
      expected.add(normalizeType(paramType));
    }
  }

  return expected;
}

function extractParameterTypeFromLabel(label: string): string {
  const m = /^\s*\w+\s*:\s*(?:(?:in|out|inout|buffer)\s+)?(.+)$/i.exec(label);
  return (m?.[1] ?? '').trim();
}

function parseVhdlTypedSymbols(text: string): VhdlTypedSymbol[] {
  const packageBlocks = findPackageBlocks(text);
  const scopedSymbols = packageBlocks.flatMap((block) =>
    parseVhdlTypedSymbolsInSegment(text, block.contentStartOffset, block.contentEndOffset, block.packageName)
  );

  const globalSymbols = parseVhdlTypedSymbolsInSegment(text, 0, text.length)
    .filter((symbol) => !packageBlocks.some((block) =>
      (symbol.declarationOffset ?? -1) >= block.contentStartOffset &&
      (symbol.declarationOffset ?? -1) < block.contentEndOffset
    ));

  return [...globalSymbols, ...scopedSymbols];
}

function parseVhdlTypedSymbolsInSegment(
  text: string,
  segmentStartOffset: number,
  segmentEndOffset: number,
  packageName?: string
): VhdlTypedSymbol[] {
  const symbols: VhdlTypedSymbol[] = [];
  const segment = text.slice(segmentStartOffset, segmentEndOffset);
  const sanitizedSegment = segment.replace(/--.*$/gm, '');

  // Build mapping from sanitizedSegment index -> original segment index
  const sanitizedToOriginal: number[] = [];
  {
    let origI = 0;
    let sanJ = 0;
    while (origI < segment.length) {
      if (segment.startsWith('--', origI)) {
        // skip until end of line (but keep the newline)
        while (origI < segment.length && segment[origI] !== '\n') {
          origI += 1;
        }
        // If newline char exists, copy it into sanitized and map it
        if (origI < segment.length && segment[origI] === '\n') {
          sanitizedToOriginal[sanJ++] = origI;
          origI += 1;
        }
        continue;
      }
      // copy this char
      sanitizedToOriginal[sanJ++] = origI;
      origI += 1;
    }
  }

  const declarationRegex = /\b(signal|variable|constant)\s+([\w\s,]+?)\s*:\s*([\s\S]*?);/gi;
  let declMatch: RegExpExecArray | null;
  while ((declMatch = declarationRegex.exec(sanitizedSegment)) !== null) {
    const kind = declMatch[1].toLowerCase() as VhdlTypedSymbolKind;
    const names = declMatch[2].split(',').map((s) => s.trim()).filter(Boolean);
    const typeText = declMatch[3].replace(/\s*:=\s*[\s\S]*$/i, '').trim();
    const sanIndex = declMatch.index;
    const origIndex = (sanitizedToOriginal[sanIndex] ?? sanIndex);
    const declarationOffset = segmentStartOffset + origIndex;
    for (const name of names) {
      symbols.push({ name, typeText, kind, packageName, declarationOffset });
    }
  }

  const genericRegex = /\bgeneric\s*\(([\s\S]*?)\)\s*;/gi;
  let genericMatch: RegExpExecArray | null;
  while ((genericMatch = genericRegex.exec(sanitizedSegment)) !== null) {
    const sanIndex = genericMatch.index;
    const origIndex = (sanitizedToOriginal[sanIndex] ?? sanIndex);
    symbols.push(
      ...parseInterfaceBlockSymbols(genericMatch[1], 'generic', packageName, segmentStartOffset + origIndex)
    );
  }

  const portRegex = /\bport\s*\(([\s\S]*?)\)\s*;/gi;
  let portMatch: RegExpExecArray | null;
  while ((portMatch = portRegex.exec(sanitizedSegment)) !== null) {
    const sanIndex = portMatch.index;
    const origIndex = (sanitizedToOriginal[sanIndex] ?? sanIndex);
    symbols.push(
      ...parseInterfaceBlockSymbols(portMatch[1], 'port', packageName, segmentStartOffset + origIndex)
    );
  }

  return symbols;
}

function parseInterfaceBlockSymbols(
  block: string,
  kind: 'port' | 'generic',
  packageName?: string,
  declarationOffset?: number
): VhdlTypedSymbol[] {
  const symbols: VhdlTypedSymbol[] = [];
  const statements = block
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const stmt of statements) {
    const m = /^([\w\s,]+)\s*:\s*(?:(?:in|out|inout|buffer)\s+)?(.+)$/i.exec(stmt);
    if (!m) {
      continue;
    }

    const names = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    const typeText = m[2].replace(/\s*:=\s*[\s\S]*$/i, '').trim();

    for (const name of names) {
      symbols.push({ name, typeText, kind, packageName, declarationOffset });
    }
  }

  return symbols;
}

function scoreSymbolAgainstExpectedTypes(
  symbol: VhdlTypedSymbol,
  expectedTypes: Set<string>,
  context: {
    documentUri: string;
    cursorOffset: number;
    cursorScopeStack: string[];
    usedPackages: Set<string>;
    documentText: string;
  }
): number {
  const normalizedSymbol = normalizeType(symbol.typeText);
  if (!normalizedSymbol) {
    return 1000;
  }

  let best = 1000;
  for (const expectedType of expectedTypes) {
    if (normalizedSymbol === expectedType) {
      best = Math.min(best, 0);
      continue;
    }

    if (typeBase(normalizedSymbol) === typeBase(expectedType)) {
      best = Math.min(best, 100);
      continue;
    }

    if (isNumericType(normalizedSymbol) && isNumericType(expectedType)) {
      best = Math.min(best, 200);
      continue;
    }

    if (isStdLogicFamily(normalizedSymbol) && isStdLogicFamily(expectedType)) {
      best = Math.min(best, 250);
      continue;
    }
  }

  if (best >= 1000) {
    return best;
  }

  let score = best;

  // Prefer local kinds for argument completion.
  if (symbol.kind === 'variable') score -= 20;
  if (symbol.kind === 'signal') score -= 15;
  if (symbol.kind === 'constant') score -= 10;

  if (symbol.sourceUri === context.documentUri) {
    score -= 30;

    if (typeof symbol.declarationOffset === 'number') {
      if (symbol.declarationOffset <= context.cursorOffset) {
        score -= 20;
        const distance = context.cursorOffset - symbol.declarationOffset;
        score += Math.min(100, Math.floor(distance / 250));
      } else {
        score += 90;
      }

      const symbolScopeStack = getScopeStackAtOffset(context.documentText, symbol.declarationOffset);
      const sharedDepth = commonPrefixLength(context.cursorScopeStack, symbolScopeStack);
      score -= Math.min(60, sharedDepth * 20);
      score += Math.max(0, context.cursorScopeStack.length - sharedDepth) * 10;
    }
  } else {
    score += 120;
  }

  if (symbol.packageName) {
    if (context.usedPackages.has(symbol.packageName.toLowerCase())) {
      score -= 25;
    } else {
      score += 80;
    }
  }

  return Math.max(0, score);
}

function completionPriorityBand(score: number): string {
  if (score <= 40) return '0000';
  if (score <= 160) return '0001';
  if (score <= 320) return '0002';
  return '0003';
}

function collectUsedPackagesBeforeOffset(text: string, endOffset: number): Set<string> {
  const used = new Set<string>();
  const segment = text.slice(0, endOffset);
  const useRegex = /\buse\s+([a-zA-Z][\w]*(?:\.[a-zA-Z][\w]*)+)\s*;/gi;
  let match: RegExpExecArray | null;

  while ((match = useRegex.exec(segment)) !== null) {
    const pathParts = match[1].split('.').filter(Boolean);
    if (pathParts.length >= 2) {
      used.add(pathParts[pathParts.length - 2].toLowerCase());
    }
  }

  return used;
}

function getScopeStackAtOffset(text: string, endOffset: number): string[] {
  const stack: string[] = [];
  const segment = text.slice(0, endOffset);
  const tokenRegex = /\b(end\s+(?:process|function|procedure|block|architecture|entity|package)|process|function|procedure|block|architecture|entity|package)\b/gi;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(segment)) !== null) {
    const token = match[1].toLowerCase().replace(/\s+/g, ' ').trim();
    if (token.startsWith('end ')) {
      const kind = token.slice(4);
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i] === kind) {
          stack.splice(i, 1);
          break;
        }
      }
      continue;
    }

    stack.push(token);
  }

  return stack;
}

function commonPrefixLength(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) {
    i += 1;
  }
  return i;
}

function normalizeType(typeText: string): string {
  return typeText.toLowerCase().replace(/\s+/g, ' ').trim();
}

function typeBase(typeText: string): string {
  const normalized = normalizeType(typeText);
  const parenIndex = normalized.indexOf('(');
  return parenIndex >= 0 ? normalized.slice(0, parenIndex).trim() : normalized;
}

function isNumericType(typeText: string): boolean {
  const base = typeBase(typeText);
  return base === 'integer' || base === 'natural' || base === 'positive' || base === 'signed' || base === 'unsigned';
}

function isStdLogicFamily(typeText: string): boolean {
  const base = typeBase(typeText);
  return base === 'std_logic' || base === 'std_logic_vector' || base === 'std_ulogic' || base === 'std_ulogic_vector';
}

function completionKindForSymbol(kind: VhdlTypedSymbolKind): vscode.CompletionItemKind {
  switch (kind) {
    case 'constant':
      return vscode.CompletionItemKind.Constant;
    case 'variable':
      return vscode.CompletionItemKind.Variable;
    case 'signal':
      return vscode.CompletionItemKind.Field;
    case 'port':
      return vscode.CompletionItemKind.Property;
    case 'generic':
      return vscode.CompletionItemKind.Value;
    default:
      return vscode.CompletionItemKind.Variable;
  }
}

function parseVhdlFunctions(text: string): VhdlFunctionSignature[] {
  const packageBlocks = findPackageBlocks(text);
  const scopedFunctions = packageBlocks.flatMap((block) =>
    parseVhdlFunctionsInSegment(text, block.contentStartOffset, block.contentEndOffset, block.packageName)
  );

  const globalFunctions = parseVhdlFunctionsInSegment(text, 0, text.length)
    .filter((fn) => !packageBlocks.some((block) =>
      fn.startOffset >= block.contentStartOffset && fn.startOffset < block.contentEndOffset
    ));

  return [...globalFunctions, ...scopedFunctions].map((fn) => fn.signature);
}

function findPackageBlocks(text: string): Array<{
  packageName: string;
  contentStartOffset: number;
  contentEndOffset: number;
}> {
  const blocks: Array<{
    packageName: string;
    contentStartOffset: number;
    contentEndOffset: number;
  }> = [];

  const packageHeader = /\bpackage\s+(?:body\s+)?(\w+)\s+is\b/gi;
  let headerMatch: RegExpExecArray | null;

  while ((headerMatch = packageHeader.exec(text)) !== null) {
    const packageName = headerMatch[1];
    const contentStartOffset = packageHeader.lastIndex;
    const endRegex = /\bend\s+package(?:\s+body)?(?:\s+\w+)?\s*;/gi;
    endRegex.lastIndex = contentStartOffset;
    const endMatch = endRegex.exec(text);

    if (!endMatch) {
      continue;
    }

    const contentEndOffset = endMatch.index;
    blocks.push({ packageName, contentStartOffset, contentEndOffset });
  }

  return blocks;
}

function parseVhdlFunctionsInSegment(
  text: string,
  segmentStartOffset: number,
  segmentEndOffset: number,
  packageName?: string
): Array<{ signature: VhdlFunctionSignature; startOffset: number }> {
  const segment = text.slice(segmentStartOffset, segmentEndOffset);
  const out: Array<{ signature: VhdlFunctionSignature; startOffset: number }> = [];
  const functionKeyword = /\bfunction\s+(\w+)\b/gi;
  let match: RegExpExecArray | null;

  while ((match = functionKeyword.exec(segment)) !== null) {
    const name = match[1];
    const absoluteStartOffset = segmentStartOffset + match.index;
    let i = functionKeyword.lastIndex;

    while (i < segment.length && /\s/.test(segment[i])) {
      i += 1;
    }

    let rawParams = '';
    if (segment[i] === '(') {
      const paramStart = i + 1;
      let depth = 1;
      i += 1;

      while (i < segment.length && depth > 0) {
        if (segment[i] === '(') depth += 1;
        else if (segment[i] === ')') depth -= 1;
        i += 1;
      }

      if (depth !== 0) {
        continue;
      }

      rawParams = segment.slice(paramStart, i - 1);

      while (i < segment.length && /\s/.test(segment[i])) {
        i += 1;
      }
    }

    const returnWord = segment.slice(i, i + 6).toLowerCase();
    if (returnWord !== 'return') {
      continue;
    }
    i += 6;

    while (i < segment.length && /\s/.test(segment[i])) {
      i += 1;
    }

    const returnStart = i;
    let depth = 0;
    let returnEnd = -1;

    while (i < segment.length) {
      const ch = segment[i];
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
      if (depth === 0 && isWordAt(segment, i, 'is')) {
        returnEnd = i;
        break;
      }
      i += 1;
    }

    if (returnEnd === -1) {
      continue;
    }

    const returnType = segment.slice(returnStart, returnEnd).trim();
    const parameters = parseVhdlParameterList(rawParams);
    const baseLabel = parameters.length > 0
      ? `function ${name}(${parameters.map(p => p.label).join('; ')}) return ${returnType}`
      : `function ${name} return ${returnType}`;
    const label = packageName ? `${packageName}.${baseLabel}` : baseLabel;

    out.push({
      startOffset: absoluteStartOffset,
      signature: {
        name,
        returnType,
        parameters,
        label,
        packageName,
        declarationOffset: absoluteStartOffset,
      },
    });
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
): FunctionCallContext | null {
  const text = document.getText();
  const cursorOffset = document.offsetAt(position);
  const stack: Array<{
    openOffset: number;
    functionName: string | null;
    packageQualifier?: string;
  }> = [];

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
      const callInfo = extractFunctionCallInfoBeforeParen(text, i);
      stack.push({
        openOffset: i,
        functionName: callInfo?.functionName ?? null,
        packageQualifier: callInfo?.packageQualifier,
      });
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
      packageQualifier: frame.packageQualifier,
      activeParameter,
    };
  }

  return null;
}

function extractFunctionCallInfoBeforeParen(
  text: string,
  openParenOffset: number
): { functionName: string; packageQualifier?: string } | null {
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

  const functionName = text.slice(start, end + 1);
  if (!/^[a-zA-Z]\w*$/.test(functionName)) {
    return null;
  }

  let packageQualifier: string | undefined;
  let j = start - 1;
  while (j >= 0 && /\s/.test(text[j])) {
    j -= 1;
  }

  if (j >= 0 && text[j] === '.') {
    j -= 1;
    while (j >= 0 && /\s/.test(text[j])) {
      j -= 1;
    }

    const qualifierEnd = j;
    while (j >= 0 && /[a-zA-Z0-9_]/.test(text[j])) {
      j -= 1;
    }
    const qualifierStart = j + 1;

    if (qualifierStart <= qualifierEnd) {
      const qualifier = text.slice(qualifierStart, qualifierEnd + 1);
      if (/^[a-zA-Z]\w*$/.test(qualifier)) {
        packageQualifier = qualifier;
      }
    }
  }

  return {
    functionName,
    packageQualifier,
  };
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

/**
 * Find all unused symbols in a document using simple text search.
 * A symbol is considered unused if it appears only on its declaration line.
 */
async function findUnusedSymbols(document: vscode.TextDocument): Promise<UnusedSymbol[]> {
  try {
    const symbols = parseVhdlTypedSymbols(document.getText());
    output.appendLine(`[vhdl-helper] Parsing document: found ${symbols.length} symbols`);
    
    if (symbols.length === 0) {
      return [];
    }

    // Skip ports and generics as they might be used outside the file
    const symbolsToCheck = symbols.filter(s => s.kind !== 'port' && s.kind !== 'generic');
    output.appendLine(`[vhdl-helper] Checking ${symbolsToCheck.length} symbols (excluding ports/generics)`);
    
    const unused: UnusedSymbol[] = [];
    const documentText = document.getText();
    const lines = documentText.split('\n');
    
    for (const symbol of symbolsToCheck) {
      if (symbol.declarationOffset === undefined) {
        continue;
      }

      try {
        // Find the declaration position and log offsets for diagnostics
        const declPosition = document.positionAt(symbol.declarationOffset);
        const declLine = declPosition.line;
        output.appendLine(`[vhdl-helper]   '${symbol.name}' found on line ${declLine + 1} (offset ${symbol.declarationOffset})`);

        // First, try to use the language server / VS Code reference provider if available
        let foundUsageElsewhere = false;
        let refProviderTried = false;
        try {
          // executeCommand returns an array of Location when supported
          // It may throw or return undefined if not supported by the language server
          // We pass the declaration position as the position to query references for
          // and expect the declaration itself to be included in the returned list.
          // If more than one location is returned, the symbol is used elsewhere.
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          const refs = await vscode.commands.executeCommand('vscode.executeReferenceProvider', document.uri, declPosition) as vscode.Location[] | undefined;
          refProviderTried = true;
          if (Array.isArray(refs)) {
            output.appendLine(`[vhdl-helper] Reference provider returned ${refs.length} refs for '${symbol.name}'`);
            if (refs.length > 1) {
              foundUsageElsewhere = true;
            } else {
              foundUsageElsewhere = false;
            }
          } else {
            output.appendLine(`[vhdl-helper] Reference provider returned no results for '${symbol.name}'`);
          }
        } catch (e) {
          output.appendLine(`[vhdl-helper] Reference provider failed for '${symbol.name}': ${String(e)}`);
        }

        // If reference provider wasn't available or gave no useful info, fallback to text search
        if (!refProviderTried || foundUsageElsewhere === false) {
          // We'll perform a conservative text search on the original document text,
          // ignoring comment tails and skipping the declaration line. This is a fallback
          // and may produce false positives/negatives, but is safer than relying solely on
          // a sanitized text copy that can shift offsets.
          const searchRegex = new RegExp(`\\b${escapeRegExp(symbol.name)}\\b`, 'i');
          for (let lineNum = 0; lineNum < lines.length; lineNum++) {
            if (lineNum === declLine) continue;
            const rawLine = lines[lineNum];
            const lineNoComments = rawLine.replace(/--.*$/,'');
            if (!lineNoComments.trim()) continue;
            const m = searchRegex.exec(lineNoComments);
            if (m) {
              foundUsageElsewhere = true;
              const matchIndex = m.index ?? -1;
              const matchedText = m[0];
              output.appendLine(`[vhdl-helper]   '${symbol.name}' text-search fallback match on line ${lineNum + 1} at index ${matchIndex}: "${matchedText}"`);
              output.appendLine(`[vhdl-helper]     rawLine: ${rawLine.trim()}`);
              output.appendLine(`[vhdl-helper]     lineNoComments: ${lineNoComments.trim()}`);
              break;
            }
          }
        }

        if (!foundUsageElsewhere) {
          output.appendLine(`[vhdl-helper] UNUSED: '${symbol.name}' (${symbol.kind})`);

          // Try to find the symbol on the declaration line (best-effort)
          const declLineText = lines[declLine] ?? '';
          output.appendLine(`[vhdl-helper]     declaration line text: ${declLineText.trim()}`);
          const symbolIndex = findSymbolNameInDeclaration(declLineText, symbol.name);
          output.appendLine(`[vhdl-helper]     findSymbolNameInDeclaration returned index: ${symbolIndex}`);
          if (symbolIndex >= 0) {
            unused.push({
              name: symbol.name,
              startLine: declLine,
              startChar: symbolIndex,
              endLine: declLine,
              endChar: symbolIndex + symbol.name.length,
            });
          } else {
            // As a last resort, search the declaration line for a raw match
            const fallbackMatch = declLineText.match(new RegExp(`\\b${escapeRegExp(symbol.name)}\\b`, 'i'));
            if (fallbackMatch && fallbackMatch.index !== undefined) {
              unused.push({
                name: symbol.name,
                startLine: declLine,
                startChar: fallbackMatch.index,
                endLine: declLine,
                endChar: fallbackMatch.index + symbol.name.length,
              });
            }
          }
        } else {
          output.appendLine(`[vhdl-helper] USED: '${symbol.name}' (${symbol.kind})`);
        }
      } catch (error) {
        output.appendLine(`[vhdl-helper] Error checking symbol '${symbol.name}': ${String(error)}`);
      }
    }

    output.appendLine(`[vhdl-helper] Found ${unused.length} unused symbols total`);
    return unused;
  } catch (error) {
    output.appendLine(`[vhdl-helper] Error in findUnusedSymbols: ${String(error)}`);
    return [];
  }
}



/**
 * Find the position of a symbol name in a declaration line.
 */
function findSymbolNameInDeclaration(lineText: string, symbolName: string): number {
  // Look for patterns like: signal x : type; or variable x : type;
  // We want to find the first occurrence of the symbol name after signal/variable/constant keyword
  const keywords = ['signal', 'variable', 'constant'];
  
  for (const keyword of keywords) {
    const keywordLower = keyword.toLowerCase();
    const lineLower = lineText.toLowerCase();
    const keywordIndex = lineLower.indexOf(keywordLower);
    
    if (keywordIndex >= 0) {
      // Search for symbol name after the keyword
      const afterKeywordIndex = keywordIndex + keyword.length;
      const afterKeyword = lineText.slice(afterKeywordIndex);
      const symbolMatch = afterKeyword.match(new RegExp(`\\b${escapeRegExp(symbolName)}\\b`, 'i'));
      
      if (symbolMatch && symbolMatch.index !== undefined) {
        return afterKeywordIndex + symbolMatch.index;
      }
    }
  }

  // Fallback: find first occurrence with word boundary
  const wordBoundaryMatch = lineText.match(new RegExp(`\\b${escapeRegExp(symbolName)}\\b`, 'i'));
  if (wordBoundaryMatch && wordBoundaryMatch.index !== undefined) {
    return wordBoundaryMatch.index;
  }

  return -1;
}

/**
 * Escape special regex characters.
 */
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Apply unused symbol decorations to a text editor.
 */
async function applyUnusedSymbolDecorations(editor: vscode.TextEditor): Promise<void> {
  try {
    output.appendLine(`[vhdl-helper] applyUnusedSymbolDecorations called for: ${editor.document.fileName}`);
    
    if (!isVhdlDocument(editor.document)) {
      output.appendLine(`[vhdl-helper] Not a VHDL document, skipping`);
      return;
    }

    output.appendLine(`[vhdl-helper] Finding unused symbols...`);
    const unusedSymbols = await findUnusedSymbols(editor.document);
    output.appendLine(`[vhdl-helper] Found ${unusedSymbols.length} unused symbols`);
    
    unusedSymbolsCache.set(editor.document.uri.toString(), unusedSymbols);

    const decorations: vscode.DecorationOptions[] = unusedSymbols.map((symbol, idx) => {
      output.appendLine(`[vhdl-helper] Creating decoration ${idx + 1}: '${symbol.name}' at line ${symbol.startLine + 1}, chars ${symbol.startChar}-${symbol.endChar}`);
      return {
        range: new vscode.Range(
          new vscode.Position(symbol.startLine, symbol.startChar),
          new vscode.Position(symbol.endLine, symbol.endChar)
        ),
        hoverMessage: `Unused ${findSymbolKind(editor.document, symbol.name)}`,
      };
    });

    output.appendLine(`[vhdl-helper] Setting ${decorations.length} decorations on editor`);
    editor.setDecorations(unusedSymbolDecoration, decorations);
    output.appendLine(`[vhdl-helper] Decorations applied successfully`);
  } catch (error) {
    output.appendLine(`[vhdl-helper] ERROR in applyUnusedSymbolDecorations: ${String(error)}`);
    console.error('[vhdl-helper] Error:', error);
  }
}

/**
 * Find the kind of symbol for hover message.
 */
function findSymbolKind(document: vscode.TextDocument, symbolName: string): string {
  const symbols = parseVhdlTypedSymbols(document.getText());
  const symbol = symbols.find((s) => s.name.toLowerCase() === symbolName.toLowerCase());
  return symbol?.kind ?? 'symbol';
}

/**
 * Update decorations for all visible VHDL editors.
 */
function updateAllUnusedSymbolDecorations(): void {
  for (const editor of vscode.window.visibleTextEditors) {
    if (isVhdlDocument(editor.document)) {
      void applyUnusedSymbolDecorations(editor);
    }
  }
}
