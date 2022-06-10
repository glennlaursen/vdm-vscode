// SPDX-License-Identifier: GPL-3.0-or-later

/* eslint-disable @typescript-eslint/naming-convention */
/* eslint-disable eqeqeq */

const vscode = acquireVsCodeApi();

// Get the view container
const viewContainer = document.getElementById("viewContainer");
viewContainer.classList.add("viewContainer");
const btnContainer = document.getElementById("btnsContainer");
viewContainer.style.height = `${window.innerHeight - btnContainer.clientHeight}px`;

// Global const variables
const archViewId = "arch";
const execViewId = "exec";
const legendViewId = "legend";
const settingsChangedMsg = "settingsChanged";
const initMsg = "init";
const btnColors = {};
const views = [];
const buttons = Array.from(document.getElementsByClassName("button"));
const timeSelector = document.getElementById("timeStamp");
const workerSource = document.currentScript.getAttribute('src').replace('rtLogView.js', 'diagramWorker.js'); 


// Global variables
let fontSize;
let backgroundColor;
let currentViewId = archViewId;
let selectedTime = 0;
let hasConjectures = false;
let diagramWorker;
let conjectures;
fetch(workerSource)
  .then(result => result.blob())
  .then(blob => {
    const blobUrl = URL.createObjectURL(blob);
    diagramWorker = new Worker(blobUrl);
    diagramWorker.onmessage = handleWorkerResponse;
    vscode.postMessage(initMsg);
    window.onbeforeunload = () => {
        diagramWorker.terminate();
    };
    
  });

function handleWorkerResponse(event) {
    const res = event.data;
    const view = views.find(view => view.id == res.msg);
    const isCpuView = (view.id != archViewId && view.id != execViewId && view.id != legendViewId);
    view.diagramHeight = res.height;
    // Container for the diagram
    const mainContainer = document.createElement("div");
    mainContainer.style.overflow = "scroll";
    mainContainer.style.width = "100%";
    // Handle vertical overflow on cpu diagram. If the diagram overflows a scrollbar should appear but only for the diagram. This is realised by using flex box.
    mainContainer.style.height = isCpuView ? "100vh" : "fit-content";
    mainContainer.style.flex = isCpuView ? 1 : "";
    view.containers = [mainContainer];

    // Container for the information to be displayed below the diagram
    const secondContainer = document.createElement("div");
    secondContainer.style.overflow = "scroll";
    secondContainer.classList.add("secondaryContainer");
    if(res.msg == execViewId) {
        mainContainer.appendChild(bitmapToCanvas(res.width, res.height, res.bitmap));

        // Add element to display warning if all events cannot fit onto the canvas.
        if(res.exceedTime) {
            const pElement = generateWarningElement(`*Max diagram size reached! Only displaying events until the time ${res.exceedTime}. Choose a later start time to view later events.`);
            secondContainer.appendChild(pElement);
        }

        if(conjectures && conjectures.length > 0) {
            // Setup container for the table
            const tableContainer = document.createElement("div");
            tableContainer.style.float = "left";
            const tableHeader = document.createElement("h1");
            tableHeader.textContent = "Validation Conjecture Violations";
            tableHeader.style.fontSize = `${fontSize * 1.5}px`;
            tableHeader.style.marginBottom = "5px";
            tableContainer.appendChild(tableHeader);
            tableContainer.appendChild(generateConjectureTable(conjectures));
            secondContainer.appendChild(tableContainer);
            
        }

        if(secondContainer.children.length > 0) {
            view.containers.push(secondContainer);
        }
    } else if(res.msg == archViewId || res.msg == legendViewId) {
        mainContainer.appendChild(bitmapToCanvas(res.width, res.height, res.bitmap));
    } else {
        // Container for the diagram
        
        mainContainer.appendChild(bitmapToCanvas(res.width, res.height, res.bitmap));
        // Add element to display warning if all events cannot fit onto the canvas.
        if(res.exceedTime) {
            const pElement = generateWarningElement(`*Max diagram size reached! Only displaying events until the time ${res.exceedTime}. Choose a later start time to view later events.`);
            secondContainer.appendChild(pElement);
            view.containers.push(secondContainer);
        }
        
    }
    viewContainer.innerHTML = "";
    view.containers.forEach(container => viewContainer.appendChild(container));
    // Reset the cursor to default style
    document.body.style.cursor='default';
};

// Handle button press
buttons.forEach((btn) => {
    // Each button corresponds to a view
    views.push({ id: btn.id, containers: []});
    btn.onclick = function () {
        // Update the pressed button to "pressed" color and the previous pressed button to "standard" color
        setButtonColors([document.getElementById(currentViewId)], btn);
        // Clear the view container
        viewContainer.innerHTML = "";
        // Check if components for the view has already been generated - the btn id is the view id
        const selectedView = views.find((vc) => vc.id == btn.id);
        displayView(selectedView.id, selectedTime);
        currentViewId = btn.id;
    };
});

// Handle time change
timeSelector.onchange = (event) => {
    selectedTime = event.target.value;
    displayView(currentViewId, selectedTime);
};

// Handle event from extension backend
window.addEventListener("message", (event) => {
    if (event.data.cmd == initMsg) {
        let minTimeStamp = event.data.timeStamps[0];

        event.data.timeStamps.forEach((timestamp) => {
            // Setup time options
            const opt = document.createElement("option");
            opt.value = timestamp;
            opt.innerHTML = timestamp;
            timeSelector.appendChild(opt);
            if (minTimeStamp > timestamp) {
                minTimeStamp = timestamp;
            }
        });
        selectedTime = minTimeStamp;
        hasConjectures = event.data.conjectures.length > 0;
        conjectures = event.data.conjectures;
        // Setup the diagram worker
        const osCanvas = new OffscreenCanvas(window.innerWidth, window.innerHeight);
        diagramWorker.postMessage({msg: initMsg, cpuDecls: event.data.cpuDecls,
            busDecls: event.data.busDecls,
            executionEvents: event.data.executionEvents,
            cpusWithEvents: event.data.cpusWithEvents,
            conjectures: conjectures,
        canvas: osCanvas}, [osCanvas]);
    }

    // Check for changes to font and theme and update the settings in the diagram worker
    updateFontAndColors(event.data.scaleWithFont, event.data.matchTheme);

    // Set button colors
    setButtonColors(
        buttons.filter((btn) => btn.id != currentViewId),
        document.getElementById(currentViewId)
    );

    displayView(currentViewId, selectedTime);
});

window.onresize = () => {
    // Handle vertical overflow. If the diagram overflows, i.e. is larger than the visible area
    // a scrollbar should appear but only for the diagram. This is realised by using flex box.
    const viewAreaHeight = window.innerHeight - btnContainer.clientHeight;
    viewContainer.style.height = `${viewAreaHeight}px`;
};


function generateCanvas(viewId, startTime) {
    // Generating the CPU canvas can take some time so set a wait curser
    if(viewId != execViewId && viewId != archViewId && viewId != legendViewId) {
        document.body.style.cursor='wait';
    }
    const offscreen = new OffscreenCanvas(window.innerWidth, window.innerHeight);
    diagramWorker.postMessage({msg: viewId, canvas: offscreen, startTime: startTime}, [offscreen]);
}

function generateConjectureTable(conjectures) {
    const table = document.createElement("table");
    table.style.float = "center";
    const headerNames = ["status", "name", "expression", "src time", "src thread", "dest time", "dest thread"];

    //  Build and add the headers
    const thead = table.createTHead();
    const headerRow = thead.insertRow();
    headerNames.forEach((header) => {
        const th = document.createElement("th");
        th.appendChild(document.createTextNode(header));
        headerRow.appendChild(th);
    });

    // Add the table body
    let tbdy = document.createElement("tbody");
    tbdy.id = "tbdy";
    table.appendChild(tbdy);

    // Build the rows
    conjectures.forEach((conj) => {
        const row = tbdy.insertRow();
        row.classList.add("row");
        // Add cells to the rows
        [
            { header: headerNames[0], value: conj.status },
            { header: headerNames[1], value: conj.name },
            { header: headerNames[2], value: conj.expression },
            { header: headerNames[3], value: conj.source.time },
            { header: headerNames[4], value: conj.source.thid },
            { header: headerNames[5], value: conj.destination.time },
            { header: headerNames[6], value: conj.destination.thid },
        ].forEach((content) => {
            const rowCell = row.insertCell();
            rowCell.classList.add("statuscell");
            // Parse a true or falls value to an icon instead
            rowCell.appendChild(
                document.createTextNode(content.value === true ? "\u2713" : content.value === false ? "\u2715" : content.value)
            );
            // Click listener for focusing the diagram on the time of the conjecture violation
            if (content.header == headerNames[3] || content.header == headerNames[5]) {
                rowCell.classList.add("clickableCell");
                rowCell.ondblclick = () => {
                    selectedTime = content.value;
                    timeSelector.value = selectedTime;
                    displayView(currentViewId, selectedTime);
                };
            }
        });
    });

    return table;
}

function generateSingleViewComponent(viewId) {
}

function generateCpuViewComponents(startTime, msg) {
   
}

function generateExecutionViewComponents(startTime) {
   
}

function generateWarningElement(txt) {
    // Generate p element to display warning if all events cannot fit onto the canvas.
    const pElement = document.createElement("p");
    pElement.classList.add("iswarning");
    pElement.textContent = txt;
    return pElement;
}

function displayView(viewId, timeStamp) {
    const view = views.find(view => view.id == viewId);
    if(view.containers.length == 0) {
        generateCanvas(viewId, timeStamp);
    }
    else if(view.time != timeStamp && viewId != archViewId && viewId != legendViewId) {
        generateCanvas(viewId, timeStamp);
    } else {
        viewContainer.innerHTML = "";
        view.containers.forEach(container =>  viewContainer.appendChild(container));
    }
    view.time = timeStamp;
}

function bitmapToCanvas(width, height, bitmap) {
    const canvas = document.createElement("CANVAS");
    canvas.style.marginTop = "15px";
    canvas.style.marginLeft = "15px";
    canvas.style.background = backgroundColor;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('bitmaprenderer');
    ctx.transferFromImageBitmap(bitmap);
    return canvas;
}

function resetViews(currentViewId, selectedTime) {
    viewContainer.innerHTML = "";
    // Remove view components from views and rebuild and display the view components for the current view
    views.forEach((view) => {
        view.components = [];
        if (view.id == currentViewId) {
            // Display the view
            displayView(view.id, selectedTime);
        }
    });
}

function setButtonColors(btns, activeBtn) {
    // There is alwasy an active (pressed) button. Change its color to secondary
    if (activeBtn) {
        activeBtn.style.background = btnColors.secondaryBackground;
        activeBtn.style.color = btnColors.secondaryForeground;
    }

    // Update the other buttons to primary color
    btns.forEach((btn) => {
        if (btn.id != activeBtn.id) {
            btn.style.background = btnColors.primaryBackground;
            btn.style.color = btnColors.primaryForeground;
        }
    });
}

function updateFontAndColors(scaleWithFont, matchTheme) {
    const computedStyle = getComputedStyle(document.body);
    // Update font properties
    fontSize = scaleWithFont ? Number(computedStyle.getPropertyValue("--vscode-editor-font-size").replace(/\D/g, "")) : 16;
    const fontFamily = computedStyle.getPropertyValue("--vscode-editor-font-family").trim();
    const fontColor = matchTheme ? computedStyle.getPropertyValue("--vscode-editor-foreground").trim() : "#000000";

    // Update background color for the diagrams
    backgroundColor = matchTheme ? computedStyle.getPropertyValue("--vscode-editor-background").trim() : "#ffffff";

    // Update colors for events and bus
   const themeColors = [
        fontColor, 
        computedStyle.getPropertyValue("--vscode-debugIcon-startForeground").trim(), 
        computedStyle.getPropertyValue("--vscode-debugIcon-breakpointCurrentStackframeForeground").trim(), 
        computedStyle.getPropertyValue("--vscode-debugIcon-stopForeground").trim(),
        computedStyle.getPropertyValue("--vscode-statusBar-debuggingBackground").trim(),
        computedStyle.getPropertyValue("--vscode-editorOverviewRuler-findMatchForeground").trim(),
        computedStyle.getPropertyValue("--vscode-debugIcon-continueForeground").trim()
    ];
    

    // Update button colors
    btnColors.primaryBackground = computedStyle.getPropertyValue("--vscode-button-background").trim();
    btnColors.secondaryBackground = computedStyle.getPropertyValue("--vscode-button-secondaryBackground").trim();
    btnColors.primaryForeground = computedStyle.getPropertyValue("--vscode-button-foreground").trim();
    btnColors.secondaryForeground = computedStyle.getPropertyValue("--vscode-button-secondaryForeground").trim();
    const gridLineWidth = fontSize / 10 > 1 ? fontSize / 10 : 1;
    const eventLineWidth = gridLineWidth * 4;

    diagramWorker.postMessage({msg: settingsChangedMsg, lineDashSize: gridLineWidth * 0.7,
        eventWrapperHeight: eventLineWidth * 2 + eventLineWidth,
        conjectureViolationMarkerWidth: gridLineWidth * 3,
        eventLineWidth: eventLineWidth,
        gridLineWidth: gridLineWidth,
        conjectureViolationFont: `900 ${fontSize * 1.1}px ${fontFamily}`,
        diagramFont: `${fontSize}px ${fontFamily}`,
        declFont: `${fontSize * 1.5}px ${fontFamily}`,
        themeColors: themeColors,
        backgroundColor: backgroundColor,
        conjectureViolationColor: matchTheme ? computedStyle.getPropertyValue("--vscode-debugIcon-breakpointForeground").trim() : "#FF0000",
        fontColor: fontColor,
        fontSize: fontSize
    });
}
