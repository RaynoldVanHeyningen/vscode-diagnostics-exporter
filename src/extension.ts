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

    // When diagnostics change → rewrite diagnostics.json
    context.subscriptions.push(
        vscode.languages.onDidChangeDiagnostics(() => scheduleDiagnosticsWrite()),
        vscode.workspace.onDidSaveTextDocument(() => scheduleDiagnosticsWrite())
    );

    // === FILE SYSTEM WATCHER (detects ANY new/changed files — including agent files) ===
    const watcher = vscode.workspace.createFileSystemWatcher(
        "**/*.{cs,ts,js,tsx,jsx,py,gd,gdshader,tscn,tres,res,cfg,ini,json,xml,yaml}"
    );

    // File created (agents, scripts, external tools, git, etc.)
    watcher.onDidCreate(async (uri) => {
        if (shouldIgnore(uri)) return;
        console.log("[diagnostics-exporter] File created:", uri.fsPath);
        await handleNewOrChangedFile(uri);
    });

    // File changed without being opened
    watcher.onDidChange(async (uri) => {
        if (shouldIgnore(uri)) return;
        console.log("[diagnostics-exporter] File changed:", uri.fsPath);
        await handleNewOrChangedFile(uri);
    });

    // File deleted → remove stale diagnostics
    watcher.onDidDelete((uri) => {
        if (shouldIgnore(uri)) return;
        console.log("[diagnostics-exporter] File deleted:", uri.fsPath);
        cleanupCollection.set(uri, []); // clear diagnostics for this file
        scheduleDiagnosticsWrite();
    });

    context.subscriptions.push(watcher);

    // Initial full scan
    preloadDiagnostics().catch(err =>
        console.error("[diagnostics-exporter] preloadDiagnostics ERROR:", err)
    );
    console.log("[diagnostics-exporter] preloadDiagnostics() CALLED");
}

export function deactivate() {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
    }
}

function shouldIgnore(uri: vscode.Uri): boolean {
    // Ignore everything inside .mcp
    return uri.fsPath.includes("\\.mcp\\") || uri.fsPath.includes("/.mcp/");
}

function scheduleDiagnosticsWrite() {
    if (!diagnosticsFileUri) return;

    if (debounceTimer) clearTimeout(debounceTimer);

    debounceTimer = setTimeout(() => {
        writeDiagnosticsFile(diagnosticsFileUri!);
    }, 300);
}

// === FULL WORKSPACE PRELOAD ===
async function preloadDiagnostics() {
    const files = await vscode.workspace.findFiles(
        "**/*.{cs,ts,js,tsx,jsx,py,gd,gdshader,tscn,tres,res,cfg,ini,json,xml,yaml}",
        "**/{node_modules,Library,.git,.godot/imported,.mcp}/**"
    );

    console.log(`[diagnostics-exporter] Preloading ${files.length} files...`);

    for (const file of files) {
        if (shouldIgnore(file)) continue;

        try {
            const doc = await vscode.workspace.openTextDocument(file);

            await vscode.window.showTextDocument(doc, {
                preview: true,
                preserveFocus: true
            });

            await vscode.commands.executeCommand("workbench.action.closeActiveEditor");

        } catch (err) {
            console.warn("[diagnostics-exporter] Failed to preload:", file.fsPath, err);
        }
    }

    console.log("[diagnostics-exporter] Preload complete");
}

// === TRIGGER DIAGNOSTICS ON NEW OR CHANGED FILE ===
async function handleNewOrChangedFile(uri: vscode.Uri) {
    try {
        console.log(`[diagnostics-exporter] Scanning file: ${uri.fsPath}`);

        const doc = await vscode.workspace.openTextDocument(uri);

        await vscode.window.showTextDocument(doc, {
            preview: true,
            preserveFocus: true
        });

        await new Promise(res => setTimeout(res, 150));

        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");

        console.log(`[diagnostics-exporter] Scanned new/changed file: ${uri.fsPath}`);
    } catch (err) {
        console.error("[diagnostics-exporter] Failed to scan:", uri.fsPath, err);
    }
}

// === WRITE diagnostics.json ===
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

        console.log(`[diagnostics-exporter] Wrote diagnostics.json (${serializable.length} diagnostics)`);

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
