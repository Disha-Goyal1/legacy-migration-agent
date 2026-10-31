import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  Node,
  Project,
  ScriptTarget,
  SyntaxKind,
  type CallExpression,
  type SourceFile,
} from "ts-morph";

export interface MigrationReport {
  sourceFile: string;
  outputFile: string;
  transformations: string[];
  warnings: string[];
  errors: string[];
  status: "completed" | "review_required" | "failed";
}

interface MigrationOptions {
  inputFile: string;
  outputFile: string;
  projectRoot: string;
  reportFile?: string;
}

export interface MigrationReportCollection {
  fixtures: MigrationReport[];
}

function addWarning(warnings: string[], message: string): void {
  if (!warnings.includes(message)) {
    warnings.push(message);
  }
}

function transformCommonJsExports(
  sourceFile: SourceFile,
  transformations: string[],
  warnings: string[],
): void {
  const assignments = sourceFile
    .getDescendantsOfKind(SyntaxKind.BinaryExpression)
    .filter(
      expression =>
        expression.getLeft().getText() === "module.exports" &&
        expression.getOperatorToken().getKind() === SyntaxKind.EqualsToken,
    );

  for (const assignment of assignments) {
    const statement = assignment.getParentIfKind(
      SyntaxKind.ExpressionStatement,
    );
    const object = assignment.getRight().asKind(SyntaxKind.ObjectLiteralExpression);
    const isTopLevel =
      statement?.getParentIfKind(SyntaxKind.SourceFile) !== undefined;

    if (!statement || !object || !isTopLevel) {
      addWarning(
        warnings,
        "A CommonJS export uses an unsupported form and was left unchanged.",
      );
      continue;
    }

    const exports: string[] = [];
    let supported = true;

    for (const property of object.getProperties()) {
      if (Node.isShorthandPropertyAssignment(property)) {
        exports.push(property.getName());
        continue;
      }

      if (!Node.isPropertyAssignment(property)) {
        supported = false;
        break;
      }

      const initializer = property.getInitializer();
      if (
        Node.isIdentifier(property.getNameNode()) &&
        initializer &&
        Node.isIdentifier(initializer)
      ) {
        const exportedName = property.getName();
        const localName = initializer.getText();
        exports.push(
          exportedName === localName
            ? localName
            : `${localName} as ${exportedName}`,
        );
        continue;
      }

      supported = false;
      break;
    }

    if (!supported || exports.length === 0) {
      addWarning(
        warnings,
        "A CommonJS export uses an unsupported form and was left unchanged.",
      );
      continue;
    }

    statement.replaceWithText(`export { ${exports.join(", ")} };`);
    transformations.push(
      `Converted a top-level module.exports object to named exports: ${exports.join(", ")}.`,
    );
    addWarning(
      warnings,
      "Converting CommonJS to ES module exports may change module interoperability at runtime.",
    );
  }

  for (const assignment of sourceFile
    .getDescendantsOfKind(SyntaxKind.BinaryExpression)
    .filter(expression => expression.getLeft().getText().startsWith("exports."))) {
    addWarning(
      warnings,
      `CommonJS assignment "${assignment.getLeft().getText()}" was not transformed.`,
    );
  }
}

function inferSafeReturnTypes(
  sourceFile: SourceFile,
  transformations: string[],
  warnings: string[],
): void {
  for (const fn of sourceFile.getFunctions()) {
    if (fn.getReturnTypeNode()) {
      continue;
    }

    const inferredType = fn.getReturnType();
    const returnType = inferredType.getText(sourceFile);
    if (inferredType.isAny()) {
      addWarning(
        warnings,
        `Function "${fn.getName() ?? "anonymous"}" has an uncertain any return type.`,
      );
      continue;
    }

    if (!["string", "number", "boolean"].includes(returnType)) {
      continue;
    }

    fn.setReturnType(returnType);
    transformations.push(
      `Inferred the ${returnType} return type of function "${fn.getName() ?? "anonymous"}" from its implementation.`,
    );
  }
}

function getPrimitiveLiteralType(node: Node): string | undefined {
  if (Node.isStringLiteral(node)) {
    return "string";
  }
  if (Node.isNumericLiteral(node)) {
    return "number";
  }
  if (
    node.getKind() === SyntaxKind.TrueKeyword ||
    node.getKind() === SyntaxKind.FalseKeyword
  ) {
    return "boolean";
  }
  return undefined;
}

function inferParametersFromLocalCalls(
  sourceFile: SourceFile,
  transformations: string[],
): void {
  for (const fn of sourceFile.getFunctions()) {
    const nameNode = fn.getNameNode();
    const name = fn.getName();
    if (
      !nameNode ||
      !name ||
      fn.getParentIfKind(SyntaxKind.SourceFile) === undefined
    ) {
      continue;
    }

    const parameters = fn.getParameters();
    if (
      parameters.length === 0 ||
      parameters.some(
        parameter =>
          parameter.getTypeNode() ||
          !Node.isIdentifier(parameter.getNameNode()) ||
          parameter.isOptional() ||
          parameter.isRestParameter() ||
          parameter.getInitializer(),
      )
    ) {
      continue;
    }

    const calls: CallExpression[] = [];
    let hasUnsupportedReference = false;

    for (const identifier of sourceFile.getDescendantsOfKind(
      SyntaxKind.Identifier,
    )) {
      if (identifier.getText() !== name || identifier === nameNode) {
        continue;
      }

      const call = identifier.getParentIfKind(SyntaxKind.CallExpression);
      if (call?.getExpression() === identifier) {
        calls.push(call);
      } else {
        hasUnsupportedReference = true;
        break;
      }
    }

    if (hasUnsupportedReference || calls.length === 0) {
      continue;
    }

    const inferredTypes = parameters.map(() => new Set<string>());
    let supportedCalls = true;

    for (const call of calls) {
      const arguments_ = call.getArguments();
      if (arguments_.length !== parameters.length) {
        supportedCalls = false;
        break;
      }

      for (const [index, argument] of arguments_.entries()) {
        if (!Node.isExpression(argument)) {
          supportedCalls = false;
          break;
        }
        const type = getPrimitiveLiteralType(argument);
        if (!type) {
          supportedCalls = false;
          break;
        }
        inferredTypes[index]?.add(type);
      }

      if (!supportedCalls) {
        break;
      }
    }

    if (!supportedCalls) {
      continue;
    }

    for (const [index, parameter] of parameters.entries()) {
      const types = inferredTypes[index];
      if (types?.size !== 1) {
        continue;
      }

      const [type] = types;
      if (!type) {
        continue;
      }

      parameter.setType(type);
      transformations.push(
        `Inferred parameter "${parameter.getName()}" as ${type} from consistent literal arguments at all visible local call sites of "${name}".`,
      );
    }
  }
}

function annotateUncertainParameters(
  sourceFile: SourceFile,
  transformations: string[],
  warnings: string[],
): void {
  for (const parameter of sourceFile.getDescendantsOfKind(SyntaxKind.Parameter)) {
    if (parameter.getTypeNode() || !parameter.getType().isAny()) {
      continue;
    }

    const name = parameter.getName();
    const type = parameter.isRestParameter() ? "any[]" : "any";
    parameter.setType(type);
    transformations.push(
      `Added an explicit ${type} type to uncertain parameter "${name}".`,
    );
    addWarning(
      warnings,
      `Parameter "${name}" has no reliable type evidence and needs human review.`,
    );
  }
}

function inspectForReview(
  sourceFile: SourceFile,
  warnings: string[],
): void {
  for (const node of sourceFile.getDescendants()) {
    if (node.getKind() === SyntaxKind.WithStatement) {
      addWarning(
        warnings,
        "The with statement has dynamic name resolution and needs human review.",
      );
    }

    if (Node.isElementAccessExpression(node)) {
      const argument = node.getArgumentExpression();
      if (
        argument &&
        !Node.isNumericLiteral(argument) &&
        !Node.isStringLiteral(argument)
      ) {
        addWarning(
          warnings,
          `Computed property access "${node.getText()}" may be dynamic and needs human review.`,
        );
      }
    }

    if (Node.isCallExpression(node)) {
      const callee = node.getExpression().getText();
      if (callee === "eval" || callee === "Function") {
        addWarning(
          warnings,
          `Dynamic code execution through ${callee}() needs human review.`,
        );
      } else if (callee === "require") {
        addWarning(
          warnings,
          "A require() call was left unchanged; CommonJS module loading needs human review.",
        );
      }
    }

    if (
      Node.isNewExpression(node) &&
      node.getExpression().getText() === "Proxy"
    ) {
      addWarning(
        warnings,
        "Proxy-based dynamic behavior cannot be validated automatically.",
      );
    }

    if (
      Node.isBinaryExpression(node) &&
      node.getOperatorToken().getKind() === SyntaxKind.PlusToken &&
      Node.isIdentifier(node.getLeft()) &&
      Node.isIdentifier(node.getRight()) &&
      (
        node.getLeft().getType().isAny() ||
        node.getRight().getType().isAny() ||
        node.getLeft().getType().isUnion() ||
        node.getRight().getType().isUnion()
      )
    ) {
      addWarning(
        warnings,
        `The "+" expression "${node.getText()}" may mean numeric addition or string concatenation.`,
      );
    }

    if (
      Node.isArrayLiteralExpression(node) &&
      node.getElements().length === 0
    ) {
      addWarning(
        warnings,
        "An empty array has no element type evidence and needs human review.",
      );
    }
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toPortablePath(filePath: string, projectRoot: string): string {
  const relativePath = path.relative(projectRoot, filePath);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new TypeError(
      `Migration path "${filePath}" must be inside project root "${projectRoot}".`,
    );
  }
  return relativePath.split(path.sep).join("/");
}

async function realPathOrNearestExistingParent(filePath: string): Promise<string> {
  let candidate = filePath;
  while (true) {
    try {
      return await fs.realpath(candidate);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        (error.code !== "ENOENT" && error.code !== "ENOTDIR")
      ) {
        throw error;
      }

      const parent = path.dirname(candidate);
      if (parent === candidate) {
        throw error;
      }
      candidate = parent;
    }
  }
}

async function assertWithinProjectRoot(
  filePath: string,
  projectRoot: string,
  realProjectRoot: string,
): Promise<void> {
  toPortablePath(filePath, projectRoot);
  const realPath = await realPathOrNearestExistingParent(filePath);
  const relativePath = path.relative(realProjectRoot, realPath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new TypeError(
      `Migration path "${filePath}" resolves outside project root "${projectRoot}".`,
    );
  }
}

async function writeAtomically(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryFile = `${filePath}.${randomUUID()}.tmp`;

  try {
    await fs.writeFile(temporaryFile, content, {
      encoding: "utf8",
      flag: "wx",
    });
    await fs.rename(temporaryFile, filePath);
  } catch (error) {
    await fs.rm(temporaryFile, { force: true });
    throw error;
  }
}

export async function writeMigrationReportCollection(
  filePath: string,
  collection: MigrationReportCollection,
): Promise<void> {
  await writeAtomically(
    filePath,
    `${JSON.stringify(collection, null, 2)}\n`,
  );
}

export async function migrateFile(
  options: MigrationOptions,
): Promise<MigrationReport> {
  const projectRoot = path.resolve(options.projectRoot);
  const sourcePath = path.resolve(options.inputFile);
  const outputPath = path.resolve(options.outputFile);
  const reportPath = path.resolve(
    options.reportFile ??
      path.join(path.dirname(outputPath), "migration-report.json"),
  );
  const realProjectRoot = await fs.realpath(projectRoot);
  await Promise.all(
    [sourcePath, outputPath, reportPath].map(filePath =>
      assertWithinProjectRoot(filePath, projectRoot, realProjectRoot),
    ),
  );
  const sourceFile = toPortablePath(sourcePath, projectRoot);
  const outputFile = toPortablePath(outputPath, projectRoot);
  toPortablePath(reportPath, projectRoot);
  const report: MigrationReport = {
    sourceFile,
    outputFile,
    transformations: [],
    warnings: [],
    errors: [],
    status: "failed",
  };

  try {
    const source = await fs.readFile(sourcePath, "utf8");
    const project = new Project({
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        target: ScriptTarget.ES2020,
        strict: true,
        types: ["node"],
        typeRoots: [path.resolve(__dirname, "..", "node_modules", "@types")],
      },
    });
    const sourceFile = project.createSourceFile(
      `${outputPath}.${randomUUID()}.ts`,
      source,
    );
    inferParametersFromLocalCalls(sourceFile, report.transformations);
    annotateUncertainParameters(
      sourceFile,
      report.transformations,
      report.warnings,
    );
    inferSafeReturnTypes(
      sourceFile,
      report.transformations,
      report.warnings,
    );
    transformCommonJsExports(
      sourceFile,
      report.transformations,
      report.warnings,
    );
    inspectForReview(sourceFile, report.warnings);

    report.errors.push(
      ...sourceFile.getPreEmitDiagnostics().map(diagnostic => {
        const line = diagnostic.getLineNumber();
        return `TypeScript error TS${diagnostic.getCode()}${line ? ` on line ${line}` : ""}: ${diagnostic.getMessageText()}`;
      }),
    );

    if (report.errors.length === 0) {
      await writeAtomically(outputPath, sourceFile.getFullText());
      report.status =
        report.warnings.length > 0 ? "review_required" : "completed";
    }
  } catch (error) {
    report.errors.push(formatError(error));
  }

  try {
    await writeAtomically(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    throw new Error(
      `Could not write migration report "${reportPath}": ${formatError(error)}`,
    );
  }

  return report;
}
