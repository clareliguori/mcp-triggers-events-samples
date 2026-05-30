import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";
import { resolveDomainName, type SharedProps } from "./shared-props.js";

export type DnsRegionalStackProps = cdk.StackProps & SharedProps;

/**
 * Target-region DNS and TLS foundation for the MCP Events Serverless Agent
 * sample.
 *
 * This stack deploys to the application's target region (resolved from
 * `CDK_DEFAULT_REGION` in bin/app.ts). It owns:
 *
 * Responsibilities (Requirements 13.2, 13.3):
 * - Look up the existing parent Route53 hosted zone (registered out of band).
 * - Create a dedicated public hosted zone for the subdomain
 *   `<subdomain>.<parentDomain>` (for example
 *   `earthquake-agent.liguori.people.aws.dev`). Route53 hosted-zone data is
 *   global, but the `AWS::Route53::HostedZone` resource is owned by this
 *   target-region stack so the bulk of consumers (the application stacks, which
 *   also deploy to the target region) can import the zone id with a normal
 *   same-region `Fn.importValue`.
 * - Add an NS delegation record in the parent zone so the subdomain zone is
 *   authoritative.
 * - Provision a REGIONAL ACM wildcard certificate for
 *   `*.<subdomain>.<parentDomain>` (plus the apex), validated via DNS against
 *   the subdomain zone. This certificate lives in the target region because the
 *   Data API, USGS, Scheduler, and Webhook Receiver stacks all expose REGIONAL
 *   API Gateway custom domains, which require their certificate in the same
 *   region as the API.
 *
 * REGION SPLIT NOTE: CloudFront (Webapp) and Cognito (Auth) custom domains
 * require their certificate in us-east-1, so that certificate is created
 * separately by DnsUsEast1Stack. That us-east-1 stack validates its certificate
 * against this stack's subdomain zone. Because the zone and that certificate
 * can be in different regions, the zone is shared with DnsUsEast1Stack via a
 * cross-region reference (CDK's `crossRegionReferences`), which Fn.importValue
 * cannot provide. Both certificates validate the same wildcard FQDN against the
 * same hosted zone; ACM uses one deterministic validation CNAME per FQDN, so
 * the two certificates share a single validation record (idempotent upsert) and
 * each renews automatically and independently while that record remains.
 *
 * Same-region consumers (the application stacks) import the zone id, zone name,
 * and regional certificate ARN by their explicit export names below.
 */
export class DnsRegionalStack extends cdk.Stack {
  /**
   * The subdomain hosted zone. Exposed only so DnsUsEast1Stack can validate its
   * us-east-1 certificate against it across regions (via crossRegionReferences,
   * the sanctioned mechanism where Fn.importValue cannot reach). Same-region
   * consumers import the zone id by name instead.
   */
  public readonly subdomainZone: route53.IHostedZone;

  constructor(scope: Construct, id: string, props: DnsRegionalStackProps) {
    super(scope, id, props);

    const domainName = resolveDomainName(props);

    // The parent zone already exists in this account. fromLookup performs a
    // synth-time lookup, so the stack must be environment-specific (account +
    // region resolved in bin/app.ts).
    const parentZone = route53.HostedZone.fromLookup(this, "ParentZone", {
      domainName: props.parentDomain,
    });

    // Dedicated public hosted zone for the subdomain.
    const subdomainZone = new route53.PublicHostedZone(this, "SubdomainZone", {
      zoneName: domainName,
      comment: `Subdomain zone for the MCP Events Serverless Agent sample (${domainName})`,
    });
    this.subdomainZone = subdomainZone;

    // Delegate the subdomain from the parent zone to the new zone by copying
    // the subdomain zone's name servers into an NS record in the parent zone.
    new route53.ZoneDelegationRecord(this, "SubdomainDelegation", {
      zone: parentZone,
      recordName: domainName,
      nameServers: subdomainZone.hostedZoneNameServers ?? [],
      ttl: cdk.Duration.minutes(5),
      comment: "NS delegation to the earthquake-agent subdomain zone",
    });

    // REGIONAL wildcard certificate for the API Gateway custom domains plus the
    // apex. DNS validation creates the validation records in the subdomain
    // zone.
    const certificate = new acm.Certificate(
      this,
      "RegionalWildcardCertificate",
      {
        domainName: `*.${domainName}`,
        subjectAlternativeNames: [domainName],
        validation: acm.CertificateValidation.fromDns(subdomainZone),
      },
    );

    new cdk.CfnOutput(this, "SubdomainZoneId", {
      value: subdomainZone.hostedZoneId,
      description: "Hosted zone ID for the earthquake-agent subdomain",
      exportName: "EarthquakeAgent-SubdomainZoneId",
    });

    new cdk.CfnOutput(this, "SubdomainZoneName", {
      value: domainName,
      description: "Subdomain zone name (earthquake-agent.<parentDomain>)",
      exportName: "EarthquakeAgent-SubdomainZoneName",
    });

    new cdk.CfnOutput(this, "RegionalWildcardCertificateArn", {
      value: certificate.certificateArn,
      description:
        "ARN of the regional wildcard ACM certificate for the API Gateway custom domains",
      exportName: "EarthquakeAgent-RegionalWildcardCertificateArn",
    });
  }
}
