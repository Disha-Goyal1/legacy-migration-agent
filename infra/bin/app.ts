import * as cdk from "aws-cdk-lib";
import { LegacyMigrationStack } from "../lib/legacy-migration-stack";

const app = new cdk.App();
const bedrockContext = app.node.tryGetContext("enableBedrock");
new LegacyMigrationStack(app, "LegacyMigrationAgent", {
  bedrockEnabled: bedrockContext === true || bedrockContext === "true",
  bedrockModelId:
    app.node.tryGetContext("bedrockModelId") ?? "amazon.nova-lite-v1:0",
  githubTokenSecretName:
    app.node.tryGetContext("githubTokenSecretName") ??
    "legacy-migration-agent/github-token",
});
