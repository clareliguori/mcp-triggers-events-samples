/**
 * CDK template assertions: DynamoDB TTL on the MCP server Subscriptions tables.
 *
 * This is the second of the two expiry layers (the first — the authoritative
 * read-time `expiresAt` gate — is covered by the `expiry.property.test.ts`
 * suites in usgs-server and scheduler-server). Here we assert the PHYSICAL
 * cleanup layer at synth time: each MCP server's Subscriptions table must
 * enable DynamoDB TTL on the numeric `ttl` attribute that mirrors `expiresAt`,
 * so rows for subscriptions a caller stopped refreshing are eventually reclaimed
 * by DynamoDB (best-effort, lagging — NOT the delivery gate).
 *
 * Scope (deliberate): TTL is asserted ONLY on UsgsServerStack and
 * SchedulerServerStack. The Data API Subscriptions table is a lookup/routing
 * store whose lifecycle is driven by explicit writes (create/refresh/unsubscribe
 * via the Subscription Manager), not by expiry; a TTL there would risk
 * TTL-deleting a row still referenced by a live MCP-side subscription and
 * pushing an otherwise-resolvable delivery to the DLQ. So it intentionally has
 * no TTL, and this test does not assert one for it.
 *
 * Validates Requirement 15.3 (eventual expiry) at the infrastructure layer.
 */

import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import type { Construct } from "constructs";
import { describe, it, vi } from "vitest";

/**
 * Replace `NodejsFunction` with a lightweight inline-code Lambda for synth.
 *
 * The production stacks compute the Lambda `entry` path relative to `__dirname`
 * assuming the COMPILED location (`packages/cdk/dist/lib`). Under vitest the
 * stacks run from TS source (`packages/cdk/lib`), so that path resolves one
 * level too shallow and `NodejsFunction` throws "Cannot find entry file" at
 * construction (it validates the entry up front, before any bundling). The
 * DynamoDB table whose TTL we assert is wholly independent of the Lambda's code
 * asset, so we swap `NodejsFunction` for a real `lambda.Function` with inline
 * code: every downstream call the stacks make on the handler (grants, role
 * policy, EventBridge target, env vars) is supported by `lambda.Function`, and
 * the synthesized DynamoDB table is the genuine production configuration.
 */
vi.mock("aws-cdk-lib/aws-lambda-nodejs", async () => {
  const lambda = await import("aws-cdk-lib/aws-lambda");
  class NodejsFunction extends lambda.Function {
    constructor(
      scope: Construct,
      id: string,
      props: Record<string, unknown> = {},
    ) {
      // Drop the NodejsFunction-only props (entry/bundling/etc.) and supply
      // inline code; keep everything else (environment, timeout, memory, role).
      const {
        entry: _entry,
        depsLockFilePath: _depsLockFilePath,
        bundling: _bundling,
        projectRoot: _projectRoot,
        awsSdkConnectionReuse: _awsSdkConnectionReuse,
        handler: _handler,
        code: _code,
        runtime,
        ...rest
      } = props;
      super(scope, id, {
        ...(rest as lambda.FunctionOptions),
        runtime: (runtime as lambda.Runtime) ?? lambda.Runtime.NODEJS_20_X,
        handler: "index.handler",
        code: lambda.Code.fromInline("exports.handler = async () => {};"),
      });
    }
  }
  return { NodejsFunction };
});

const { SchedulerServerStack } = await import("./scheduler-server-stack.js");
const { DEFAULT_PARENT_DOMAIN, DEFAULT_SUBDOMAIN } =
  await import("./shared-props.js");
const { UsgsServerStack } = await import("./usgs-server-stack.js");

/** A concrete synth environment (Route53/ACM imports need account + region). */
const env: cdk.Environment = {
  account: "111122223333",
  region: "us-west-2",
};

const shared = {
  parentDomain: DEFAULT_PARENT_DOMAIN,
  subdomain: DEFAULT_SUBDOMAIN,
};

/**
 * Assert that `template` contains a DynamoDB table with TTL enabled on the
 * `ttl` attribute. (Both MCP server stacks also create other tables without
 * TTL, so we match on the TTL specification rather than counting tables.)
 */
function expectSubscriptionsTableHasTtl(template: Template): void {
  template.hasResourceProperties("AWS::DynamoDB::Table", {
    TimeToLiveSpecification: {
      AttributeName: "ttl",
      Enabled: true,
    },
  });
}

describe("MCP server Subscriptions tables enable DynamoDB TTL (Req 15.3, cleanup layer)", () => {
  it("UsgsServerStack Subscriptions table enables TTL on the ttl attribute", () => {
    const app = new cdk.App();
    const stack = new UsgsServerStack(app, "UsgsServerStack", {
      ...shared,
      env,
    });
    expectSubscriptionsTableHasTtl(Template.fromStack(stack));
  });

  it("SchedulerServerStack Subscriptions table enables TTL on the ttl attribute", () => {
    const app = new cdk.App();
    const stack = new SchedulerServerStack(app, "SchedulerServerStack", {
      ...shared,
      env,
    });
    expectSubscriptionsTableHasTtl(Template.fromStack(stack));
  });
});
