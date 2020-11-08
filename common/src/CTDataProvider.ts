import { Event, EventEmitter, ExtensionContext, TreeDataProvider, TreeItem, TreeItemCollapsibleState } from 'vscode';
import { CTTreeView } from './CTTreeView';
import { NumberRange, VerdictKind } from './protocol.lspx';
import { Icons } from './Icons'

export class CTDataProvider implements TreeDataProvider<TestViewElement> {

    private _onDidChangeTreeData: EventEmitter<TestViewElement | undefined> = new EventEmitter<TestViewElement | undefined>();
    onDidChangeTreeData: Event<TestViewElement> = this._onDidChangeTreeData.event;

    private _minGroupSize: number = 100;
    private _maxGroupSize: number = 5000;
    private _groupSizePercentage = 0.1;
    private _roots: TestViewElement[];
    private _filter: boolean = false;
    private _icons: Icons;
    constructor(
        private _ctView: CTTreeView,
        private _context: ExtensionContext) {
            this._icons = new Icons(this._context);
    }

    public rebuildViewFromElement(viewElement?: TestViewElement)
    {
        this._onDidChangeTreeData.fire(viewElement);
    }

    public rebuildViewElementIfExpanded(viewElement: TestViewElement){
        if(viewElement.ExpandedState == TreeItemCollapsibleState.Expanded)
            this._onDidChangeTreeData.fire(viewElement);
    }

    public toggleFilteringForTestGroups(): any
    {
        this._filter = this._filter ? false : true;
        this._roots.forEach(symbol => symbol.getChildren().forEach(trace => trace.getChildren().forEach(group => this.rebuildViewElementIfExpanded(group))));
    }

    public handleElementExpanded(element: TestViewElement){
        element.ExpandedState = TreeItemCollapsibleState.Expanded;
    }

    public handleElementCollapsed(element: TestViewElement){
        element.ExpandedState = TreeItemCollapsibleState.Collapsed;
    }

    getRoots(): TestViewElement[] {
        return this._roots;
    }

    getTreeItem(element: TestViewElement): TreeItem {
        return element;
    }

    getChildren(element?: TestViewElement): Thenable<TestViewElement[]> {
        // Handle root query
        if(!element){
            let symbolNames = this._ctView.getSymbolNames();
            this._roots = symbolNames.map(symbolName => {
                let newSymbol = new TestViewElement(symbolName, TreeItemType.CTSymbol, TreeItemCollapsibleState.Collapsed);
                let oldSymbolIndex = this._roots.findIndex(symbol => newSymbol.label == symbol.label);
                if(oldSymbolIndex != -1)
                    newSymbol.setChildren(this._roots[oldSymbolIndex].getChildren());
                return newSymbol;
            });
            return Promise.resolve(this._roots);
        }

        if(element.type == TreeItemType.CTSymbol)
        {
            let ctTraces = this._ctView.getTraces(element.label);
            let oldTraces = element.getChildren();
            element.setChildren(ctTraces.map(trace => {
                let index = oldTraces.findIndex(t => t.label == trace.name);
                let traceViewElement = new TestViewElement(trace.name, TreeItemType.Trace, TreeItemCollapsibleState.Collapsed, "", element)
                if(index != -1)
                    traceViewElement.setChildren(oldTraces[index].getChildren());
                traceViewElement.iconPath = !trace.verdict ? null : trace.verdict == VerdictKind.Passed ? this._icons.getIcon("passed.svg") : this._icons.getIcon("failed.svg");
                return traceViewElement;
            }));

            return Promise.resolve(element.getChildren());
        }

        if(element.type == TreeItemType.Trace)
        {
            let numberOfTests: number = this._ctView.getNumberOftests(element.label);

            // Generate test groups
            let testGroups: TestViewElement[] = [];
            let percentageSize = numberOfTests * this._groupSizePercentage;
            let groupSize = this._minGroupSize > percentageSize ? this._minGroupSize : percentageSize > this._maxGroupSize ? this._maxGroupSize: percentageSize;
            let groups = Math.ceil(numberOfTests/groupSize);
            for(let i = 0; i < groups; i++)
            {
                let testIdRange: NumberRange = {start: (1 + i * groupSize), end: (groupSize >= numberOfTests ? numberOfTests + groupSize * i : groupSize * (i+1))};
                let groupViewElement = new TestViewElement("test group", TreeItemType.TestGroup, i < element.getChildren().length ? element.getChildren()[i].ExpandedState : TreeItemCollapsibleState.Collapsed, testIdRange.start + "-" + testIdRange.end, element);
                let testCasesForGroup = this._ctView.getTestResults(testIdRange, element.label);
                groupViewElement.iconPath = !testCasesForGroup || testCasesForGroup.some(tc => !tc.verdict) ? null : testCasesForGroup.some(tc => tc.verdict == VerdictKind.Passed) ? this._icons.getIcon("passed.svg") : this._icons.getIcon("failed.svg");
                testGroups.push(groupViewElement);
                numberOfTests -= groupSize;
            }
            element.setChildren(testGroups);

            return Promise.resolve(element.getChildren());
        }

        if(element.type == TreeItemType.TestGroup)
        {
            // Generate test views for the group
            let strRange : string[] = element.description.toString().split('-');
            let testIdRange: NumberRange = {start: parseInt(strRange[0]), end: parseInt(strRange[1])};
            let testsViewElements = this._ctView.getTestResults(testIdRange, element.getParent().label).map(testCase => new TestViewElement(testCase.id+"", TreeItemType.Test, TreeItemCollapsibleState.None, testCase.verdict ? VerdictKind[testCase.verdict] : "n/a", element));
            
            if(this._filter)           
                testsViewElements = testsViewElements.filter(twe => twe.description != VerdictKind[VerdictKind.Passed] && twe.description != VerdictKind[VerdictKind.Inconclusive]);

            testsViewElements.forEach(twe => {
                if(twe.description == VerdictKind[VerdictKind.Passed])
                    twe.iconPath = this._icons.getIcon("passed.svg"); 
                else if(twe.description == VerdictKind[VerdictKind.Failed])
                    twe.iconPath = this._icons.getIcon("failed.svg"); 
                else if(twe.description == VerdictKind[VerdictKind.Inconclusive])
                    twe.iconPath = this._icons.getIcon("inconclusive.svg");
                else if(twe.description == VerdictKind[VerdictKind.Filtered])
                    twe.iconPath = this._icons.getIcon("filtered.svg");
            });
            return Promise.resolve(testsViewElements);
        }

        // Handle default
        return Promise.resolve([])
    }
}

export enum TreeItemType
{
    CTSymbol = "ctSymbol",
    Trace = "trace",
    Test = "test",
    TestGroup = "testgroup"
}

export class TestViewElement extends TreeItem {
    // For checking if a testgroup is filtered
    private _children: TestViewElement[] = [];
    public ExpandedState: TreeItemCollapsibleState;
    constructor(
    public readonly label: string,
    public readonly type: TreeItemType,
    public readonly collapsibleState: TreeItemCollapsibleState,
    public description = "",
    private readonly _parent: TestViewElement = undefined) {
        super(label, collapsibleState);
        super.contextValue = type;
        if(description === "")
            super.description = false;
        else
            super.description = description;
        this.ExpandedState = collapsibleState;
    }

    public getParent(): TestViewElement {
        return this._parent;
    }

    public getChildren(): TestViewElement[]{
        return this._children;
    }

    public setChildren(testViewElements: TestViewElement[]){
        this._children = testViewElements;
    }
}
