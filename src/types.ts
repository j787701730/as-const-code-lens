import * as vscode from 'vscode';

export type ILocation = {
  name: string;
  filePath: string;
  relativePath: string;
  uri: vscode.Uri;
  range: vscode.Range;
  line: number;
  column: number;
  key: number;
};

export type IRefCounts = {
  objectName: string;
  propertyName: string;
  count: number;
  range?: vscode.Range;
  location?: ILocation[];
  key: number;
};
