/* eslint-disable @typescript-eslint/naming-convention */
/* eslint-disable eqeqeq */
/* SPDX-License-Identifier: GPL-3.0-or-later */

import {
    commands,
    ConfigurationChangeEvent,
    ExtensionContext,
    TextDocument,
    Uri,
    ViewColumn,
    Webview,
    WebviewPanel,
    window,
    workspace,
    WorkspaceFolder,
} from "vscode";
import AutoDisposable from "../helper/AutoDisposable";
import * as Fs from "fs-extra";
import * as Path from "path";
import * as Util from "../util/Util";
import { vdmDialects } from "../util/DialectUtil";

interface ConjectureTarget {
    kind: string;
    opname: string;
    time: string;
    thid: string;
}

interface ValidationConjecture {
    status: boolean;
    name: string;
    expression: string;
    source?: ConjectureTarget;
    destination?: ConjectureTarget;
}

interface logData {
    executionEvents: any[];
    cpuDecls: any[];
    busDecls: any[];
    cpusWithEvents: any[];
    timestamps: number[];
    conjectures: ValidationConjecture[];
}

export class RTLogViewHandler extends AutoDisposable {
    private _panel: WebviewPanel = undefined;
    private _wsFolder: WorkspaceFolder = undefined;

    // Consts
    private readonly _scaleSetting = "scaleWithEditorFont";
    private readonly _matchSetting = "matchTheme";
    private readonly _configIdentifier = "vdm-vscode.real-timeLogViewer";
    private readonly _logFileExtension = ".rtlog";
    // These messages must match the names in the webview
    private readonly _settingsChangedMsg = "settingsChanged";
    private readonly _initMsg = "init";
    private readonly _fontSetting = "fontSize";

    // The precise object keys are expected in the javascript files.
    private readonly _logEvents = {
        cpuDecl: "CPUdecl",
        busDecl: "BUSdecl",
        threadCreate: "ThreadCreate",
        threadSwapIn: "ThreadSwapIn",
        delayedThreadSwapIn: "DelayedThreadSwapIn",
        threadSwapOut: "ThreadSwapOut",
        threadKill: "ThreadKill",
        messageRequest: "MessageRequest",
        messageActivate: "MessageActivate",
        messageCompleted: "MessageCompleted",
        opActivate: "OpActivate",
        opRequest: "OpRequest",
        opCompleted: "OpCompleted",
        replyRequest: "ReplyRequest",
        deployObj: "DeployObj",
    };

    constructor(private readonly _context: ExtensionContext, readonly _knownVdmFolders: Map<WorkspaceFolder, vdmDialects>) {
        super();
        // Enable the command
        commands.executeCommand("setContext", "vdm-vscode.OpenRTLog", true);
        // Add listener for open log command
        Util.registerCommand(this._disposables, "vdm-vscode.OpenRTLog", async () => {
            const rtWorkSpaceFolders = new Map();
            for (const [key, value] of _knownVdmFolders) {
                if (value == vdmDialects.VDMRT) {
                    rtWorkSpaceFolders.set(key, value);
                }
            }

            // Open only if a real-time workspace is open
            if (rtWorkSpaceFolders.size == 0) {
                window.showInformationMessage("The real time log viewer can only be opened for VDM-RT projects.");
                return;
            }

            // Ask the user to choose one of the workspace folders if more than one has been found
            const wsFS: string | WorkspaceFolder =
                workspace.workspaceFolders.length > 1
                    ? await window.showQuickPick(
                          Array.from(rtWorkSpaceFolders.entries()).map((entry) => entry[0].name),
                          { canPickMany: false, title: "Select workspace folder" }
                      )
                    : workspace.workspaceFolders[0];

            if (!wsFS) {
                return;
            }

            // Get the log file name
            const wsFolder: WorkspaceFolder =
                typeof wsFS === "string" ? Array.from(rtWorkSpaceFolders.keys()).find((key) => key.name == wsFS) : wsFS;
            const logFilesFolderPath: string = Path.join(wsFolder.uri.fsPath, ".generated", "rtlogs");
            const logsInFolder: string[] = Fs.readdirSync(logFilesFolderPath).filter((entry) => entry.endsWith(this._logFileExtension));

            const logFile: string =
                workspace.workspaceFolders.length > 1
                    ? await window.showQuickPick(logsInFolder, { canPickMany: false, title: "Select log file" })
                    : logsInFolder[0];

            if (!logFile) {
                return;
            }
            const logFilePath = Path.join(logFilesFolderPath, logFile);
            this.showLogView(logFilePath, wsFolder, Path.basename(logFilePath).split(".")[0]);
        });

        // Add settings watch
        workspace.onDidChangeConfiguration(
            (e) => {
                if (this._panel) {
                    this.changesAffectsViewCheck(e);
                }
            },
            this,
            _context.subscriptions
        );
        // Add listener for log files
        this._disposables.push(
            workspace.onDidOpenTextDocument((doc: TextDocument) => {
                if (doc.uri.fsPath.endsWith(this._logFileExtension)) {
                    const logName: string = Path.basename(doc.uri.fsPath).split(".")[0];
                    window.showInformationMessage(`Open '${logName}' in log viewer?`, { modal: true }, ...["Open"]).then((response) => {
                        if (response == "Open") {
                            if (this._panel) {
                                this._panel.dispose();
                            }
                            commands
                                .executeCommand("workbench.action.closeActiveEditor")
                                .then(() => this.showLogView(doc.uri.fsPath, workspace.getWorkspaceFolder(doc.uri), logName));
                        }
                    });
                }
            })
        );
    }

    dispose() {
        // Figure out how to close the editor that showed the log view
        this._panel.dispose();
        while (this._disposables.length) {
            this._disposables.pop().dispose();
        }
    }

    private showLogView(logPath: string, wsFolder: WorkspaceFolder, viewName: string) {
        this.parseAndPrepareLogData(logPath).then((dataObj: logData) => {
            this._wsFolder = wsFolder;
            if (dataObj) {
                this.createWebView(viewName, dataObj);
            }
        });
    }

    private changesAffectsViewCheck(event: ConfigurationChangeEvent) {
        // The webview needs to redraw its content if the user changes the theme or font
        if (
            this._wsFolder &&
            (event.affectsConfiguration("editor.fontFamily") ||
                event.affectsConfiguration("editor.fontSize") ||
                event.affectsConfiguration("workbench.colorTheme") ||
                event.affectsConfiguration(`${this._configIdentifier}.${this._scaleSetting}`) ||
                event.affectsConfiguration(`${this._configIdentifier}.${this._matchSetting}`) ||
                event.affectsConfiguration(`${this._configIdentifier}.${this._fontSetting}`))
        ) {
            const config = workspace.getConfiguration(this._configIdentifier, this._wsFolder);
            this._panel.webview.postMessage({
                cmd: this._settingsChangedMsg,
                fontSize: config.get(this._scaleSetting) == false ? config.get(this._fontSetting) : undefined,
                matchTheme: config.get(this._matchSetting),
            });
        }
    }

    private async parseAndPrepareLogData(logPath: string): Promise<any> {
        if (!logPath) {
            return;
        }

        const logContent: string = await Fs.readFile(logPath, "utf-8");
        if (!logContent) {
            return;
        }
        const logLines: string[] = logContent.split(/[\r\n\t]+/g);
        if (logLines.length <= 0) {
            return;
        }
        const executionEvents: any[] = [];
        const cpuDecls: any[] = [];
        const busDecls: any[] = [];
        const cpusWithEvents: any[] = [];
        const stringPlaceholderSign = "-";
        const activeMsgInitEvents: any[] = [];
        const timestamps: number[] = [];
        let currrentTime: number = -1;
        const vBusDecl = { eventKind: this._logEvents.busDecl, id: 0, topo: [], name: "vBUS", time: 0 };
        const vCpuDecl = { eventKind: this._logEvents.cpuDecl, id: undefined, expl: false, sys: "", name: "vCPU", time: 0 };
        const knownLogEvents: string[] = Object.values(this._logEvents);
        const unknownLogEvents: Map<string, number> = new Map();
        logLines?.forEach((line) => {
            const lineSplit: string[] = line.split(" -> ");
            if (lineSplit.length > 1) {
                let content = lineSplit[1];

                let firstStringSignIndex = content.indexOf('"');
                const embeddedStrings = [];
                while (firstStringSignIndex > -1) {
                    const secondStringSignIndex = content.indexOf('"', firstStringSignIndex + 1);
                    if (secondStringSignIndex > 0) {
                        const embeddedString = content.slice(firstStringSignIndex, secondStringSignIndex + 1);
                        embeddedStrings.push(embeddedString);
                        content = content.replace(embeddedString, stringPlaceholderSign);
                    }
                    firstStringSignIndex = content.indexOf('"');
                }
                let contentSplit: string[] = content.split(/[^\S]+/g);
                if (embeddedStrings.length > 0) {
                    let contentSplitIterator = 0;
                    embeddedStrings.forEach((embeddedString) => {
                        for (let i = contentSplitIterator; i < contentSplit.length; i++) {
                            if (contentSplit[i] == stringPlaceholderSign) {
                                contentSplit[i] = embeddedString;
                                contentSplitIterator += ++i;
                                break;
                            }
                        }
                    });
                }

                const logEventObj: any = { eventKind: lineSplit[0] };

                // Parse the event
                for (let i = 0; i < contentSplit.length - 1; i++) {
                    const property = contentSplit[i].slice(0, contentSplit[i].length - 1);
                    // If log event is of type busdecl then the topology needs to be parsed
                    logEventObj[property] =
                        property == "topo"
                            ? contentSplit[++i].replace(/[{}]/g, "").split(",")
                            : this.stringValueToTypedValue(contentSplit[++i]);
                }

                if (logEventObj.time > currrentTime) {
                    currrentTime = logEventObj.time;
                    timestamps.push(currrentTime);
                }

                if (knownLogEvents.includes(logEventObj.eventKind)) {
                    if (logEventObj.eventKind == this._logEvents.busDecl) {
                        busDecls.push(logEventObj);
                    } else if (logEventObj.eventKind == this._logEvents.cpuDecl) {
                        cpuDecls.push(logEventObj);
                    } else if (logEventObj.eventKind != this._logEvents.deployObj) {
                        if (logEventObj.eventKind != this._logEvents.messageActivate) {
                            if (logEventObj.eventKind == this._logEvents.messageCompleted) {
                                const msgInitEvent: any = activeMsgInitEvents.splice(
                                    activeMsgInitEvents.indexOf(activeMsgInitEvents.find((msg) => msg.msgid == logEventObj.msgid)),
                                    1
                                )[0];

                                logEventObj.busid = msgInitEvent.busid;
                                logEventObj.callthr = msgInitEvent.callthr;
                                logEventObj.tocpu = msgInitEvent.tocpu;
                                if (msgInitEvent.eventKind == this._logEvents.messageRequest) {
                                    logEventObj.opname = msgInitEvent.opname;
                                    logEventObj.objref = msgInitEvent.objref;
                                    logEventObj.clnm = msgInitEvent.clnm;
                                }
                            }

                            const cpunm =
                                "cpunm" in logEventObj
                                    ? logEventObj.cpunm
                                    : "fromcpu" in logEventObj
                                    ? logEventObj.fromcpu
                                    : "tocpu" in logEventObj
                                    ? logEventObj.tocpu
                                    : logEventObj.id;
                            let cpuWithEvents = cpusWithEvents.find((cwe) => cwe.id == cpunm);
                            if (!cpuWithEvents) {
                                cpuWithEvents = {
                                    id: cpunm,
                                    executionEvents: [],
                                    timestamps: [],
                                };
                                cpusWithEvents.push(cpuWithEvents);
                            }

                            if (
                                logEventObj.eventKind == this._logEvents.messageRequest ||
                                logEventObj.eventKind == this._logEvents.replyRequest
                            ) {
                                activeMsgInitEvents.push(logEventObj);
                            }

                            cpuWithEvents.executionEvents.push(logEventObj);

                            if (
                                cpuWithEvents.timestamps.length == 0 ||
                                cpuWithEvents.timestamps[cpuWithEvents.timestamps.length - 1] < logEventObj.time
                            ) {
                                cpuWithEvents.timestamps.push(logEventObj.time);
                            }
                        }

                        executionEvents.push(logEventObj);
                    }

                    if (
                        (logEventObj.eventKind == this._logEvents.messageRequest ||
                            logEventObj.eventKind == this._logEvents.replyRequest) &&
                        logEventObj.busid == 0
                    ) {
                        [logEventObj.fromcpu, logEventObj.tocpu].forEach((tpid) => {
                            if (vBusDecl.topo.find((id: number) => id == tpid) == undefined) {
                                vBusDecl.topo.push(tpid);
                            }
                        });
                    }

                    if (logEventObj?.cpunm == 0 && vCpuDecl.id == undefined) {
                        vCpuDecl.id = logEventObj.cpunm;
                        cpuDecls.push(vCpuDecl);
                    }
                } else if (unknownLogEvents.has(logEventObj.eventKind)) {
                    unknownLogEvents.set(logEventObj.eventKind, unknownLogEvents.get(logEventObj.eventKind) + 1);
                } else {
                    unknownLogEvents.set(logEventObj.eventKind, 1);
                }
            }
        });

        unknownLogEvents.forEach((value, key) => console.log(`Encounted unknown log event: '${key}' ${value} times`));

        if (vBusDecl.topo.length > 0) {
            busDecls.push(vBusDecl);
        }

        cpuDecls.forEach((decl) => {
            const cpuWithEvent = cpusWithEvents.find((cwe) => cwe.id == decl.id);
            if (cpuWithEvent) {
                cpuWithEvent.name = decl.name;
            } else {
                cpusWithEvents.push({
                    id: decl.id,
                    executionEvents: [],
                    name: decl.name,
                    timestamps: [],
                });
            }
        });

        const dataObj: logData = {
            executionEvents: executionEvents,
            cpuDecls: cpuDecls.sort((a, b) => a.id - b.id),
            busDecls: busDecls.sort((a, b) => a.id - b.id),
            cpusWithEvents: cpusWithEvents.sort((a, b) => a.id - b.id),
            timestamps: timestamps,
            conjectures: [],
        };

        // Parse conjectures if found
        const conjecturesFilePath: string = `${logPath}.violations`;
        if (Fs.existsSync(conjecturesFilePath)) {
            const logContent: string = await Fs.readFile(conjecturesFilePath, "utf-8");
            if (logContent) {
                try {
                    logContent
                        .trim()
                        .split(/[\r\n\t]+/g)
                        .forEach((line) => {
                            const vc: ValidationConjecture = JSON.parse(line);
                            if (!vc.destination) {
                                vc.destination = {
                                    kind: "",
                                    opname: "",
                                    time: "",
                                    thid: "",
                                };
                            }
                            if (!vc.source) {
                                vc.source = {
                                    kind: "",
                                    opname: "",
                                    time: "",
                                    thid: "",
                                };
                            }
                            dataObj.conjectures.push(vc);
                        });
                } catch (ex) {
                    const msg = "Encountered an error when parsing validation conjectures!";
                    window.showWarningMessage(msg);
                    console.log(`${msg} - ${ex}`);
                }
            }
        }

        return dataObj;
    }

    private stringValueToTypedValue(value: string): any {
        const number = Number(value);
        if (number || number == 0) {
            return number;
        }

        if (value.toLowerCase() == "false") {
            return false;
        }

        if (value.toLowerCase() == "true") {
            return true;
        }

        if (value == '""') {
            return "";
        }

        return value.replace('"', "").replace('"', "");
    }

    private createWebView(logName: string, dataObj: logData) {
        if (!this._wsFolder) {
            return;
        }

        // Create panel
        this._panel =
            this._panel ||
            window.createWebviewPanel(
                `${this._context.extension.id}.rtLogView`,
                `Log Viewer: ${logName}`,
                {
                    viewColumn: ViewColumn.Active,
                    preserveFocus: false,
                },
                {
                    enableScripts: true, // Enable javascript in the webview
                    localResourceRoots: [this._context.extensionUri], // Restrict the webview to only load content from the extensions directory.
                    retainContextWhenHidden: true, // Retain state when view goes into the background
                }
            );

        // Listen for when the panel is disposed
        // This happens when the user closes the panel or when the panel is closed programatically
        this._panel.onDidDispose(() => (this._panel = undefined), this, this._disposables);

        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(
            async (cmd: string) => {
                let returnObj: any = { cmd: cmd };
                // Return view data on recieveing the "init" command
                if (cmd == this._initMsg) {
                    const config = workspace.getConfiguration(this._configIdentifier, this._wsFolder);
                    returnObj = { ...returnObj, ...dataObj };
                    returnObj.fontSize = config.get(this._scaleSetting) == false ? config.get(this._fontSetting) : undefined;
                    returnObj.matchTheme = config.get(this._matchSetting);
                    returnObj.logEvents = this._logEvents;
                }

                this._panel.webview.postMessage(returnObj);
            },
            null,
            this._disposables
        );

        // Generate the html for the webview
        this._panel.webview.html = this.buildHtmlForWebview(this._panel.webview, dataObj.cpuDecls);
    }

    private buildHtmlForWebview(webview: Webview, cpuDecls: any[]) {
        // Use a nonce to only allow specific scripts to be run
        const scriptNonce: string = this.generateNonce();
        const viewContentUri: Uri = Uri.joinPath(this.getResourcesUri(), "webviews", "rtLogView");
        const rtLogViewUri = webview.asWebviewUri(Uri.joinPath(viewContentUri, "rtLogView.js"));
        const styleUri = webview.asWebviewUri(Uri.joinPath(viewContentUri, "rtLogView.css"));
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta http-equiv="Content-Security-Policy" content="style-src ${
                webview.cspSource
            }; script-src 'strict-dynamic' 'nonce-${scriptNonce}';">
            <meta name="viewport" content="width=device-width, height=device-height, initial-scale=1.0">
            <link href="${styleUri}" rel="stylesheet">
        </head>
        <body>
            <div class="btnsContainer", id="btnsContainer">
                <button class="button btnsContainerItem" id="arch">Architecture overview</button>
                <button class="button btnsContainerItem" id="exec">Execution overview</button>
                ${cpuDecls
                    .map((cpu) => `<button class="button btnsContainerItem" id="CPU_${cpu.id}">${cpu.name}</button>\n`)
                    .reduce((prev, cur) => prev + cur, "")}
                <button class="button btnsContainerItem" id="legend">Diagram legend</button>
                <div class="btnsContainerItem timeSelector" id="timeSelector">
                    <b> Start time: </b>
                    <select id="timeOptions"></select>
                    <button class="button arrwBtn" id="tup">\u25B2</button>
                    <button class="button arrwBtn" id="tdown">\u25BC</i></button>
                </div>
            </div>

            <div class="viewContainer", id="viewContainer">
            </div> 
            <script nonce="${scriptNonce}" src="${rtLogViewUri}"></script>
        </body>
        </html>`;
    }

    private getResourcesUri(): Uri {
        return Uri.joinPath(this._context.extensionUri, "resources");
    }

    private generateNonce() {
        let text = "";
        const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }
}
