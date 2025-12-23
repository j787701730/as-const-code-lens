import {
  createSourceFile,
  forEachChild,
  isAsExpression,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isTypeReferenceNode,
  isVariableStatement,
  Node,
  ScriptTarget,
} from 'typescript';
import * as vscode from 'vscode';
import { ILocation, IRefCounts } from './types';
import { toArray, uKey } from './util';

let statusBarItem: vscode.StatusBarItem;

// 全局装饰器集合，用于更新和清除
let decorationType: vscode.TextEditorDecorationType;
/** 引用数据 */
let refCountsGlobal: IRefCounts[] = [];

// 激活插件时的入口
export function activate(context: vscode.ExtensionContext) {
  // ========== 1. 创建状态栏项 ==========
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left, // 位置：右侧（Left 为左侧）
    0 // 优先级（数值越大越靠右/左）
  );

  // ========== 2. 配置状态栏样式和内容 ==========
  statusBarItem.text = '$(tag) const'; // 文本 + 内置图标（tag 是标签图标）
  const tooltip = new vscode.MarkdownString(
    `
 ### as-const-code-lens

 统计as const对象属性引用次数
    `,
    true
  );

  tooltip.isTrusted = true;

  statusBarItem.tooltip = tooltip;
  statusBarItem.command = 'as-const-code-lens.countRefs'; // 点击触发的命令

  // ========== 3. 显示状态栏 ==========
  statusBarItem.show();

  // 1. 创建装饰器样式：在属性后方显示引用次数（灰色小字体）
  decorationType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    after: {
      margin: '0 0 0 8px',
      color: '#999999',
      textDecoration: ';font-size: 0.85em;',
      // fontSize: '0.85em',
      // fontStyle: 'italic',
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
  });

  const commandDisposable = vscode.commands.registerCommand(
    'as-const-code-lens.openFile', // 命令名（需唯一）
    async (args: any) => {
      // console.log('key', args.key, 'locationKey', args.locationKey);

      const item = refCountsGlobal.find((el) => el.key === args.key);
      // console.log(item);
      if (!item) return;

      const location = toArray(item.location).find((el) => el.key === args.locationKey);
      if (!location) return;

      try {
        const doc = await vscode.workspace.openTextDocument(location.uri);
        await vscode.window.showTextDocument(doc, {
          viewColumn: vscode.ViewColumn.Active,
          preview: true,
          selection: new vscode.Range(
            new vscode.Position(location.line, location.column),
            new vscode.Position(location.line, location.column)
          ),
        });
      } catch (err) {
        vscode.window.showErrorMessage(`打开失败：${err}`);
      }
    }
  );

  // 注册命令：统计as const对象属性引用次数
  let disposable = vscode.commands.registerCommand('as-const-code-lens.countRefs', async () => {
    const editor = vscode.window.activeTextEditor;

    if (!editor) {
      // vscode.window.showErrorMessage('请打开一个TypeScript文件');
      return;
    }
    editor.setDecorations(decorationType, []);
    const document = editor.document;
    if (document.languageId !== 'typescript' && document.languageId !== 'typescriptreact') {
      // vscode.window.showErrorMessage('仅支持TypeScript文件');
      return;
    }

    // 1. 解析当前文档，找到所有as const声明的对象
    const constObjects = findConstObjects(document);

    // console.log('constObjects', constObjects);

    if (constObjects.length === 0) {
      // vscode.window.showInformationMessage('未找到as const声明的对象');
      return;
    }

    // 2. 统计每个属性的引用次数
    const refCounts = await countPropertyReferences(constObjects, document.uri.fsPath);
    refCountsGlobal = refCounts;
    // 3. 展示结果
    // let resultMsg = 'as const对象属性引用统计：\n';
    const decorations: vscode.DecorationOptions[] = [];
    refCounts.forEach((item) => {
      // resultMsg += `${item.objectName}.${item.propertyName}: ${item.count} 次引用\n`;
      // console.log('item', item);

      if (item.range) {
        const location = toArray(item.location) as ILocation[];
        if (location.length) {
          const md = new vscode.MarkdownString();
          md.isTrusted = true;
          md.appendMarkdown(`${item.objectName}.${item.propertyName} 引用了 ${item.count} 次\n\n`);
          location.forEach((el, i) => {
            md.appendMarkdown(
              `[${i + 1}. ${el.relativePath} 行 ${el.line}, 列 ${
                el.column
              }](command:as-const-code-lens.openFile?${JSON.stringify({
                key: item.key,
                locationKey: el.key,
              })})${i == location.length - 1 ? '' : '\n\n --- \n\n'}`
            );
          });

          // md.appendMarkdown(`[测试](command:as-const-code-lens.test?${item.key})`);
          decorations.push({
            range: item.range,
            hoverMessage: md,
            renderOptions: { after: { contentText: `${item.count}个引用` } },
          });
        } else {
          decorations.push({
            range: item.range,
            renderOptions: { after: { contentText: `${item.count}个引用` } },
          });
        }
      }
    });

    // 4. 应用装饰器到编辑器
    editor.setDecorations(decorationType, decorations);

    // vscode.window.showInformationMessage(resultMsg);
  });

  // 4. 监听编辑器切换，更新装饰器
  let editorChangeListener = vscode.window.onDidChangeActiveTextEditor(async (editor) => {
    if (editor && (editor.document.languageId === 'typescript' || editor.document.languageId === 'typescriptreact')) {
      // await updateRefCountDecorations();
      vscode.commands.executeCommand('as-const-code-lens.countRefs');
    } else if (editor) {
      // 清除其他文件的装饰器
      editor.setDecorations(decorationType, []);
    }
  });

  // 5. 文档保存监听
  let documentSaveListener = vscode.workspace.onDidSaveTextDocument(async (document) => {
    if (document.languageId === 'typescript' || document.languageId === 'typescriptreact') {
      vscode.commands.executeCommand('as-const-code-lens.countRefs');
    }
  });

  /** 开始运行 */
  vscode.commands.executeCommand('as-const-code-lens.countRefs');

  // 2. 监听鼠标点击事件（核心：检测是否点击了引用计数装饰器）
  // let clickListener = vscode.window.onDidChangeTextEditorSelection(async (e) => {
  //   const editor = e.textEditor;
  //   if (!editor || e.kind !== vscode.TextEditorSelectionChangeKind.Mouse) {
  //     return;
  //   }

  //   // 获取点击位置
  //   const clickPosition = e.selections[0].active;

  //   // 检查点击位置是否在装饰器范围内

  //   refCountsGlobal.forEach(async (item) => {
  //     if (item.range) {
  //       if (item.range.contains(clickPosition)) {
  //         // console.log('clickPosition----', item.range, item.location);

  //         try {
  //           // 弹出带命令的快速选择菜单
  //           const arr = item.location;

  //           /** 拼接描述信息 */
  //           const description = (el: any) => `${el.relativePath} - 行 ${el.line}, 列 ${el.column}`;

  //           if (Array.isArray(arr)) {
  //             const quickPick = vscode.window.createQuickPick();
  //             // console.log(arr[0]);
  //             quickPick.items = arr.map((el) => ({ label: el.name, description: description(el) }));
  //             // quickPick.title = 'web components vscode';
  //             quickPick.onDidChangeSelection(async (selection) => {
  //               if (selection[0]) {
  //                 const item = arr.find((el) => selection[0].description == description(el));
  //                 if (!item) {
  //                   return;
  //                 }
  //                 // console.log(item);
  //                 quickPick.dispose();
  //                 const doc = await vscode.workspace.openTextDocument(item.uri);
  //                 await vscode.window.showTextDocument(doc, {
  //                   viewColumn: vscode.ViewColumn.Active,
  //                   preview: true,
  //                   selection: new vscode.Range(
  //                     new vscode.Position(item.line, item.column),
  //                     new vscode.Position(item.line, item.column)
  //                   ),
  //                 });
  //               }
  //             });
  //             quickPick.onDidHide(() => quickPick.dispose());
  //             quickPick.show();
  //           }

  //           // 1. 打开文档（不显示）
  //           // const doc = await vscode.workspace.openTextDocument(item.location.uri);
  //           // await vscode.window.showTextDocument(doc, {
  //           //   viewColumn: vscode.ViewColumn.Active,
  //           //   preview: true,
  //           //   selection: new vscode.Range(
  //           //     new vscode.Position(item.location.line, item.location.column),
  //           //     new vscode.Position(item.location.line, item.location.column)
  //           //   ),
  //           // });
  //         } catch (err) {
  //           // vscode.window.showErrorMessage(`打开失败：${err}`);
  //         }
  //       }
  //     }
  //   });
  // });

  context.subscriptions.push(disposable, documentSaveListener, editorChangeListener, commandDisposable, {
    dispose: () => decorationType.dispose(),
  });
}

/**
 * 查找文档中所有as const声明的对象
 * @param document VSCode文档对象
 * @returns 包含对象名和属性的数组
 */
function findConstObjects(document: vscode.TextDocument): Array<{
  objectName: string;
  properties: string[];
  range?: vscode.Range[];
}> {
  const code = document.getText();
  const sourceFile = createSourceFile(document.fileName, code, ScriptTarget.Latest, true);

  const constObjects: Array<{ objectName: string; properties: string[]; range?: vscode.Range[] }> = [];

  // 遍历AST节点
  function visitNode(node: Node) {
    // 匹配：export const XXX = { ... } as con st;
    if (isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        // 检查是否是as const断言

        const decl: any = d;

        if (
          isAsExpression(decl.initializer) &&
          isTypeReferenceNode(decl.initializer.type) &&
          decl.initializer.type.typeName.getText() === 'const' &&
          isObjectLiteralExpression(decl.initializer.expression)
        ) {
          const objectName = decl.name.getText();
          let range: vscode.Range[] = [];
          const properties = decl.initializer.expression.properties.filter(isPropertyAssignment).map((prop: any) => {
            // console.log('prop', prop);

            // const start = document.positionAt(prop.name.getStart(sourceFile));
            // const end = document.positionAt(prop.name.getEnd());

            // const propName = prop.name.getText();
            // 1. 获取属性名结束的偏移量
            const propNameEndOffset = prop.name.getEnd(sourceFile);
            // 2. 获取该偏移量对应的位置（行号+列号）
            const propNameEndPos = document.positionAt(propNameEndOffset);
            // 3. 获取当前行的所有文本
            const lineText = document.lineAt(propNameEndPos.line).text;
            // 4. 计算当前行最后一个字符的偏移量（去掉行尾空格/制表符）
            // 方式1：获取行尾（包含空格）
            // const lineEndOffset = document.offsetAt(new vscode.Position(propNameEndPos.line, lineText.length));
            // 方式2：获取行尾有效字符位置（去掉末尾空格/逗号等）
            const trimmedLineText = lineText.trimEnd();
            const lineEndColumn = trimmedLineText.length;
            const lineEndOffset = document.offsetAt(new vscode.Position(propNameEndPos.line, lineEndColumn));

            // 5. 转换为行尾的Position对象
            const lineEndPos = document.positionAt(lineEndOffset);

            // console.log('start, end', start, end, lineEndPos);
            range.push(new vscode.Range(lineEndPos, lineEndPos));
            return prop.name.getText();
          });

          constObjects.push({ objectName, properties, range: range });
        }
      }
    }

    forEachChild(node, visitNode);
  }

  visitNode(sourceFile);
  return constObjects;
}

/**
 * 统计属性引用次数
 * @param constObjects as const声明的对象列表
 * @param filePath 当前文件路径
 * @returns 引用统计结果
 */
async function countPropertyReferences(
  constObjects: Array<{ objectName: string; properties: string[]; range?: vscode.Range[] }>,
  filePath: string
): Promise<IRefCounts[]> {
  const result: IRefCounts[] = [];

  // 初始化统计
  constObjects.forEach((obj) => {
    obj.properties.forEach((prop, i) => {
      result.push({
        objectName: obj.objectName,
        propertyName: prop,
        count: 0,
        range: obj.range?.[i],
        location: [],
        key: uKey(),
      });
    });
  });

  // 获取工作区中所有TS/TSX文件
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
  if (!workspaceFolder) {
    return result;
  }

  const files = await vscode.workspace.findFiles(
    new vscode.RelativePattern(workspaceFolder, '**/*.{ts,tsx}'),
    '**/node_modules/**'
  );

  // 遍历每个文件统计引用
  for (const fileUri of files) {
    const document = await vscode.workspace.openTextDocument(fileUri);
    const code = document.getText();
    const sourceFile = createSourceFile(document.fileName, code, ScriptTarget.Latest, true);

    // 遍历AST查找属性访问
    function visitNode(node: Node) {
      // 匹配：TestObj.A 这种属性访问
      if (isPropertyAccessExpression(node)) {
        const objectName = node.expression.getText();
        const propertyName = node.name.getText();

        // 检查是否是目标对象的属性
        const target = result.find((item) => item.objectName === objectName && item.propertyName === propertyName);

        if (target) {
          target.count++;
          // 获取节点起始位置的行列
          const startPos = document.positionAt(node.getStart());
          // 获取节点结束位置的行列
          // const endPos = document.positionAt(node.getEnd());
          // console.log(startPos, startPos.line, startPos.character);
          target.location?.push({
            name: `${objectName}.${propertyName}`,
            filePath: sourceFile.fileName,
            relativePath: vscode.workspace.asRelativePath(sourceFile.fileName),
            uri: vscode.Uri.file(sourceFile.fileName),
            range: new vscode.Range(document.positionAt(node.getStart()), document.positionAt(node.getEnd())),
            line: startPos.line, // VSCode行号从1开始
            column: startPos.character + objectName.length, // 列号从1开始
            key: uKey(),
          });
        }
      }

      forEachChild(node, visitNode);
    }

    visitNode(sourceFile);
  }

  return result;
}

export function deactivate() {
  // 销毁装饰器，避免内存泄漏
  if (decorationType) {
    decorationType.dispose();
  }
}
