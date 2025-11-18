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

// Track which files were opened **by the extension**
const extensionOpenedFiles = new Set<string>();

// Collection used to clear diagnostics for deleted files
const cleanupCollection = vscode.languages.createDiagnosticCollection("diagnostics-exporter-cleanup");

export function activate(context: vscode.ExtensionContext) {
    console.log("[diagnostics-exporter] ACTIVATE() REACHED");

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        console.warn("[diagnostics-exporter] No workspace open; extension idle.");
        return;
    }

    const mcpFolderUri = vscode.Uri.joinPath(workspaceFolder.uri, ".mcp");
    diagnosticsFileUri = vscode.Uri.joinPath(mcpFolderUri, "diagnostics.json");

    // Ensure .mcp folder exists
    vscode.workspace.fs.createDirectory(mcpFolderUri).then(
        () => scheduleDiagnosticsWrite(),
        (err) => console.error("[diagnostics-exporter] Failed to create .mcp directory:", err)
    );

    // Rewrite diagnostics.json when diagnostics change
    context.subscriptions.push(
        vscode.languages.onDidChangeDiagnostics(() => scheduleDiagnosticsWrite()),
        vscode.workspace.onDidSaveTextDocument(() => scheduleDiagnosticsWrite())
    );

    // FILE SYSTEM WATCHER — catches new/changed files (including agent-generated)
    const watcher = vscode.workspace.createFileSystemWatcher(
        "**/*.{cs,ts,js,tsx,jsx,py,gd,gdshader,tscn,tres,res,cfg,ini,json,xml,yaml}"
    );

    watcher.onDidCreate(async (uri) => {
        if (shouldIgnore(uri)) return;
        console.log("[diagnostics-exporter] File created:", uri.fsPath);
        await safelyTriggerScan(uri);
    });

    watcher.onDidChange(async (uri) => {
        if (shouldIgnore(uri)) return;
        console.log("[diagnostics-exporter] File changed:", uri.fsPath);
        await safelyTriggerScan(uri);
    });

    watcher.onDidDelete((uri) => {
        if (shouldIgnore(uri)) return;
        console.log("[diagnostics-exporter] File deleted:", uri.fsPath);
        cleanupCollection.set(uri, []); 
        scheduleDiagnosticsWrite();
    });

    context.subscriptions.push(watcher);

    // Initial full workspace preload
    preloadDiagnostics().catch(err =>
        console.error("[diagnostics-exporter] preloadDiagnostics ERROR:", err)
    );

    console.log("[diagnostics-exporter] preloadDiagnostics() CALLED");
}

export function deactivate() {
    if (debounceTimer) clearTimeout(debounceTimer);
}

function shouldIgnore(uri: vscode.Uri): boolean {
    const path = uri.fsPath.toLowerCase();
    return (
        path.includes("\\.mcp\\") ||
        path.includes("/.mcp/") ||
        path.includes("\\.claude\\") ||
        path.includes("/.claude/") ||
        path.includes("\\.godot\\") ||
        path.includes("/.godot/") ||
        path.includes("\\dist\\") ||
        path.includes("/dist/")
    );
}

function scheduleDiagnosticsWrite() {
    if (!diagnosticsFileUri) return;

    if (debounceTimer) clearTimeout(debounceTimer);

    debounceTimer = setTimeout(() => {
        writeDiagnosticsFile(diagnosticsFileUri!);
    }, 300);
}

// ==========================
// FULL WORKSPACE PRELOAD
// ==========================
async function preloadDiagnostics() {
    const files = await vscode.workspace.findFiles(
        "**/*.{cs,ts,js,tsx,jsx,py,gd,gdshader,tscn}",
        "**/{node_modules,Library,.git,.godot/imported,.mcp,.claude,.godot,.vscode,dist,.opencode}/**"
    );

    console.log(`[diagnostics-exporter] Preloading ${files.length} files...`);

    for (const file of files) {
        if (shouldIgnore(file)) continue;
        await safelyTriggerScan(file);
    }

    console.log("[diagnostics-exporter] Preload complete");
}

// ==========================
// SAFE SCANNING WRAPPER
// ==========================
async function safelyTriggerScan(uri: vscode.Uri) {
    try {
        const doc = await vscode.workspace.openTextDocument(uri);

        // Mark this file so we know it’s safe to close afterward
        extensionOpenedFiles.add(uri.fsPath);

        const editor = await vscode.window.showTextDocument(doc, {
            preview: true,
            preserveFocus: true
        });

        await new Promise(res => setTimeout(res, 150));

        // Only close editors WE opened (avoids closing user tabs or terminals)
        if (editor?.document && extensionOpenedFiles.has(editor.document.uri.fsPath)) {
            if (editor.viewColumn !== undefined) {
                await vscode.commands.executeCommand(
                    "workbench.action.closeEditorsInGroup",
                    { groupId: editor.viewColumn }
                );
            }

            extensionOpenedFiles.delete(editor.document.uri.fsPath);
        }

        console.log(`[diagnostics-exporter] Scanned: ${uri.fsPath}`);

    } catch (err) {
        console.error("[diagnostics-exporter] Failed to scan:", uri.fsPath, err);
    }
}

// ==========================
// WRITE diagnostics.json
// ==========================
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
            `[diagnostics-exporter] Wrote diagnostics.json (${serializable.length} diagnostics)`
        );

    } catch (err) {
        console.error("[diagnostics-exporter] Failed to write diagnostics.json:", err);
    }
}

function severityToString(sev: vscode.DiagnosticSeverity): SerializableDiagnostic["severity"] {
    switch (sev) {
        case vscode.DiagnosticSeverity.Error: return "error";
        case vscode.DiagnosticSeverity.Warning: return "warning";
        case vscode.DiagnosticSeverity.Information: return "information";
        case vscode.DiagnosticSeverity.Hint: return "hint";
        default: return "information";
    }
}
