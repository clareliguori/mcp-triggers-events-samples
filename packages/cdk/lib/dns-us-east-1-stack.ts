import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import type * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";
import { resolveDomainName, type SharedProps } from "./shared-props.js";

export interface DnsUsEast1StackProps extends cdk.StackProps, SharedProps {
  /**
   * The subdomain hosted zone created by DnsRegionalStack. This certificate is
   * DNS-validated against it. The zone lives in the target region while this
   * stack is pinned to us-east-1, so the zone is passed across regions via
   * CDK's `crossRegionReferences` mechanism (Fn.importValue cannot cross
   * regions). This is the one sanctioned exception to the named-export rule:
   * cross-region sharing has no CloudFormation export/import equivalent.
   */
  readonly subdomainZone: route53.IHostedZone;
}

/**
 * us-east-1 TLS foundation for the MCP Events Serverless Agent sample.
 *
 * This stack is ALWAYS pinned to us-east-1 (see bin/app.ts) regardless of the
 * application's target region. It owns a single resource:
 *
 * Responsibilities (Requirements 13.3, 13.4):
 * - Provision a us-east-1 ACM wildcard certificate for
 *   `*.<subdomain>.<parentDomain>` (plus the apex), validated via DNS against
 *   the subdomain zone owned by DnsRegionalStack.
 *
 * WHY US-EAST-1: The Webapp CloudFront distribution and the Cognito Hosted UI
 * custom domain (which Cognito fronts with CloudFront) both require their ACM
 * certificate to live in us-east-1, no matter where the rest of the
 * application is deployed. Pinning this certificate to us-east-1 lets the
 * application deploy to any target region while still satisfying that
 * constraint.
 *
 * CROSS-REGION WIRING: AuthStack and WebappStack deploy to the target region
 * but must reference this us-east-1 certificate. That cross-region reference is
 * provided via CDK's `crossRegionReferences: true` (set on both this stack and
 * the consuming stacks in bin/app.ts), which provisions the SSM-backed reader
 * custom resources CloudFormation needs. The certificate is therefore exposed
 * as a public property (consumed by AuthStack and WebappStack as a construct)
 * rather than via Fn.importValue, because Fn.importValue cannot resolve across
 * regions. Same-region cross-stack sharing in this app still uses named
 * CfnOutput exports per the convention in AGENTS.md; this is the documented
 * cross-region exception.
 *
 * VALIDATION RECORD SHARING: This certificate and the regional certificate from
 * DnsRegionalStack validate the same wildcard FQDN against the same hosted
 * zone. ACM issues one deterministic validation CNAME per FQDN, so both
 * certificates rely on a single validation record (an idempotent upsert in the
 * zone). Each certificate is a separate regional resource and renews
 * automatically and independently while that record remains in place.
 */
export class DnsUsEast1Stack extends cdk.Stack {
  /**
   * The us-east-1 wildcard certificate. Consumed cross-region by AuthStack and
   * WebappStack (see the CROSS-REGION WIRING note above).
   */
  public readonly certificate: acm.ICertificate;

  constructor(scope: Construct, id: string, props: DnsUsEast1StackProps) {
    super(scope, id, props);

    const domainName = resolveDomainName(props);

    const certificate = new acm.Certificate(
      this,
      "UsEast1WildcardCertificate",
      {
        domainName: `*.${domainName}`,
        subjectAlternativeNames: [domainName],
        validation: acm.CertificateValidation.fromDns(props.subdomainZone),
      },
    );
    this.certificate = certificate;

    new cdk.CfnOutput(this, "UsEast1WildcardCertificateArn", {
      value: certificate.certificateArn,
      description:
        "ARN of the us-east-1 wildcard ACM certificate for CloudFront (Webapp) and Cognito (Auth)",
    });
  }
}
