import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";
import { resolveDomainName, type SharedProps } from "./shared-props.js";

export type DnsStackProps = cdk.StackProps & SharedProps;

/**
 * Shared DNS and TLS foundation for the MCP Events Serverless Agent sample.
 *
 * Responsibilities (Requirements 13.2, 13.3):
 * - Look up the existing parent Route53 hosted zone (registered out of band).
 * - Create a dedicated public hosted zone for the subdomain
 *   `<subdomain>.<parentDomain>` (for example
 *   `earthquake-agent.liguori.people.aws.dev`).
 * - Add an NS delegation record in the parent zone so the subdomain zone is
 *   authoritative.
 * - Provision an ACM wildcard certificate for `*.<subdomain>.<parentDomain>`
 *   (plus the apex) validated via DNS against the subdomain zone.
 *
 * The subdomain zone and certificate are exposed as public properties so the
 * per-component stacks (Data API, MCP servers, webhook receiver, webapp, auth)
 * can attach custom domains, and via CfnOutput for cross-stack import.
 */
export class DnsStack extends cdk.Stack {
  /** Fully qualified subdomain, e.g. `earthquake-agent.liguori.people.aws.dev`. */
  public readonly domainName: string;

  /** The hosted zone created for the subdomain. */
  public readonly subdomainZone: route53.IHostedZone;

  /** Wildcard certificate covering `*.<domainName>` and the apex `<domainName>`. */
  public readonly certificate: acm.ICertificate;

  constructor(scope: Construct, id: string, props: DnsStackProps) {
    super(scope, id, props);

    const domainName = resolveDomainName(props);
    this.domainName = domainName;

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

    // Wildcard certificate for all per-component subdomains plus the apex.
    // DNS validation creates the validation records in the subdomain zone.
    const certificate = new acm.Certificate(this, "WildcardCertificate", {
      domainName: `*.${domainName}`,
      subjectAlternativeNames: [domainName],
      validation: acm.CertificateValidation.fromDns(subdomainZone),
    });
    this.certificate = certificate;

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

    new cdk.CfnOutput(this, "WildcardCertificateArn", {
      value: certificate.certificateArn,
      description: "ARN of the wildcard ACM certificate for the subdomain",
      exportName: "EarthquakeAgent-WildcardCertificateArn",
    });
  }
}
