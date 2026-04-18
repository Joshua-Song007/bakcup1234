import * as vscode from 'vscode';

export interface SessionItem {
  label: string;
  timestamp: number;
  explanation: string;
  scaffold: string;
  runnable: string;
  language: string;
}

export class SessionTreeItem extends vscode.TreeItem {
  constructor(public readonly session: SessionItem) {
    super(session.label, vscode.TreeItemCollapsibleState.None);
    this.description = new Date(session.timestamp).toLocaleTimeString();
    this.tooltip = session.label;
    this.command = {
      command: 'explainable.openSession',
      title: 'Open Session',
      arguments: [session],
    };
  }
}

const MAX_SESSIONS = 50;

export class SessionTreeProvider implements vscode.TreeDataProvider<SessionTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SessionTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private sessions: SessionItem[] = [];

  addSession(item: SessionItem): void {
    this.sessions.unshift(item);
    if (this.sessions.length > MAX_SESSIONS) {
      this.sessions.length = MAX_SESSIONS;
    }
    this._onDidChangeTreeData.fire();
  }

  clearSessions(): void {
    this.sessions = [];
    this._onDidChangeTreeData.fire();
  }

  getSessions(): SessionItem[] {
    return [...this.sessions];
  }

  getTreeItem(element: SessionTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: SessionTreeItem): SessionTreeItem[] {
    if (element) {
      return [];
    }
    return this.sessions.map(s => new SessionTreeItem(s));
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
