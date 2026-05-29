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
 * The subdomain zone id and certificate ARN are shared with the per-component
 * stacks (Data API, MCP servers, webhook receiver, webapp, auth) exclusively
 * via the CfnOutput exports below, which those stacks import by name with
 * `Fn.importValue`. No construct references are passed across stacks.
 */
export class DnsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DnsStackProps) {
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
