import * as vscode from "vscode";

interface SerializableDiagnostic {
    file: string;
    range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
    };
    severity: "error" | "warning" | "information" | "hint";
    message: string;
    source?: string;
    code?: string | number;
}

let diagnosticsFileUri: vscode.Uri | undefined;
let debounceTimer: NodeJS.Timeout | undefined;

// Track files opened by the extension (so we know which tabs to close)
const extensionOpenedFiles = new Set<string>();

// Used to clear stale diagnostics for deleted files
const cleanupCollection = vscode.languages.createDiagnosticCollection("diagnostics-exporter-cleanup");

export function activate(context: vscode.ExtensionContext) {
    console.log("[diagnostics-exporter] ACTIVATE() REACHED");

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        console.warn("[diagnostics-exporter] No workspace open. Idle.");
        return;
    }

    const mcpFolderUri = vscode.Uri.joinPath(workspaceFolder.uri, ".mcp");
    diagnosticsFileUri = vscode.Uri.joinPath(mcpFolderUri, "diagnostics.json");

    vscode.workspace.fs.createDirectory(mcpFolderUri).then(
        () => scheduleDiagnosticsWrite(),
        err => console.error("[diagnostics-exporter] Failed to create .mcp folder:", err)
    );

    context.subscriptions.push(
        vscode.languages.onDidChangeDiagnostics(() => scheduleDiagnosticsWrite()),
        vscode.workspace.onDidSaveTextDocument(() => scheduleDiagnosticsWrite())
    );

    // Watcher: detect new/changed/deleted files
    const watcher = vscode.workspace.createFileSystemWatcher(
        "**/*.{cs,ts,js,tsx,jsx,py,gd,gdshader,tscn,tres,res,cfg,ini,json,xml,yaml}"
    );

    watcher.onDidCreate(uri => onFileCreatedOrChanged(uri));
    watcher.onDidChange(uri => onFileCreatedOrChanged(uri));

    watcher.onDidDelete(uri => {
        if (shouldIgnore(uri)) return;
        console.log("[diagnostics-exporter] File deleted:", uri.fsPath);

        cleanupCollection.set(uri, []); // clear diagnostics for removed file
        scheduleDiagnosticsWrite();
    });

    context.subscriptions.push(watcher);

    // Initial preload
    preloadDiagnostics().catch(err =>
        console.error("[diagnostics-exporter] preloadDiagnostics ERROR:", err)
    );
}

export function deactivate() {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
    }
}

//
// IGNORE RULES
//
function shouldIgnore(uri: vscode.Uri): boolean {
    const p = uri.fsPath.toLowerCase();
    return (
        p.includes("\\.mcp\\") ||
        p.includes("/.mcp/") ||
        p.includes("\\.claude\\") ||
        p.includes("/.claude/") ||
        p.includes("\\.godot\\") ||
        p.includes("/.godot/") ||
        p.includes("\\dist\\") ||
        p.includes("/dist/")
    );
}

//
// DEBOUNCE WRITE
//
function scheduleDiagnosticsWrite() {
    if (!diagnosticsFileUri) return;

    if (debounceTimer) clearTimeout(debounceTimer);

    debounceTimer = setTimeout(() => {
        writeDiagnosticsFile(diagnosticsFileUri!);
    }, 200);
}

//
// PRELOAD ALL WORKSPACE FILES
//
async function preloadDiagnostics() {
    const files = await vscode.workspace.findFiles(
        "**/*.{cs,ts,js,tsx,jsx,py,gd,gdshader,tscn}",
        "**/{node_modules,Library,.git,.godot/imported,.mcp,.claude,.godot,.vscode,dist}/**"
    );

    console.log(`[diagnostics-exporter] Preloading ${files.length} files...`);

    for (const file of files) {
        if (!shouldIgnore(file)) {
            await safelyScanFile(file);
        }
    }

    console.log("[diagnostics-exporter] Preload complete");
}

//
// FILE WATCHER CALLBACK
//
async function onFileCreatedOrChanged(uri: vscode.Uri) {
    if (shouldIgnore(uri)) return;

    console.log("[diagnostics-exporter] File updated:", uri.fsPath);
    await safelyScanFile(uri);
}

//
// SAFELY OPEN → TRIGGER LSP → CLOSE ONLY OUR TAB
//
async function safelyScanFile(uri: vscode.Uri) {
    try {
        const doc = await vscode.workspace.openTextDocument(uri);

        // mark file as opened by extension
        extensionOpenedFiles.add(uri.fsPath);

        const editor = await vscode.window.showTextDocument(doc, {
            preview: true,
            preserveFocus: true
        });

        // let LSP catch up
        await new Promise(res => setTimeout(res, 120));

        await closeTabForDocument(doc);

        console.log("[diagnostics-exporter] Scanned:", uri.fsPath);
    } catch (err) {
        console.error("[diagnostics-exporter] Failed to scan:", uri.fsPath, err);
    }
}

//
// CLOSE *ONLY THE TAB* WE OPENED — NOT TERMINALS, NOT SIDEBARS
//
async function closeTabForDocument(doc: vscode.TextDocument) {
    const path = doc.uri.fsPath;

    if (!extensionOpenedFiles.has(path)) {
        return; // user opened file → do not close
    }

    const allTabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);

    const targetTab = allTabs.find(tab =>
        tab.input instanceof vscode.TabInputText &&
        tab.input.uri.fsPath === path
    );

    if (targetTab) {
        await vscode.window.tabGroups.close(targetTab);
    }

    extensionOpenedFiles.delete(path);
}

//
// WRITE diagnostics.json
//
async function writeDiagnosticsFile(fileUri: vscode.Uri) {
    try {
        const allDiagnostics = vscode.languages.getDiagnostics();
        const serializable: SerializableDiagnostic[] = [];

        for (const [uri, diags] of allDiagnostics) {
            if (shouldIgnore(uri)) continue;

            for (const d of diags) {
                serializable.push({
                    file: uri.fsPath,
                    range: {
                        start: {
                            line: d.range.start.line,
                            character: d.range.start.character
                        },
                        end: {
                            line: d.range.end.line,
                            character: d.range.end.character
                        }
                    },
                    severity: severityToString(d.severity),
                    message: d.message,
                    source: d.source,
                    code: typeof d.code === "object" ? (d.code as any).value : d.code
                });
            }
        }

        const contents = JSON.stringify(
            {
                generatedAt: new Date().toISOString(),
                diagnostics: serializable
            },
            null,
            2
        );

        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(contents, "utf8"));
        console.log(
            `[diagnostics-exporter] Updated diagnostics.json (${serializable.length} diagnostics)`
        );

    } catch (err) {
        console.error("[diagnostics-exporter] Failed to write diagnostics.json:", err);
    }
}

//
// SEVERITY MAPPING
//
function severityToString(sev: vscode.DiagnosticSeverity): SerializableDiagnostic["severity"] {
    switch (sev) {
        case vscode.DiagnosticSeverity.Error: return "error";
        case vscode.DiagnosticSeverity.Warning: return "warning";
        case vscode.DiagnosticSeverity.Information: return "information";
        case vscode.DiagnosticSeverity.Hint: return "hint";
        default: return "information";
    }
}
