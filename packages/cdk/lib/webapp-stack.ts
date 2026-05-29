import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { resolveDomainName, type SharedProps } from "./shared-props.js";

export type WebappStackProps = cdk.StackProps & SharedProps;

/**
 * Webapp stack for the MCP Events Serverless Agent sample.
 *
 * Responsibilities (Requirements 10.1, 13.4, 13.5, 17.4):
 * - A private S3 bucket that stores the built SvelteKit SPA assets. Block all
 *   public access, S3-managed encryption, and SSL enforcement; demo buckets are
 *   torn down with the stack.
 * - A CloudFront distribution at the custom domain
 *   `app.<subdomain>.<parentDomain>` (for example
 *   `app.earthquake-agent.liguori.people.aws.dev`) fronting the bucket via
 *   Origin Access Control so the bucket is never publicly reachable
 *   (Requirement 17.4).
 * - SPA routing: `index.html` as the default root object and 403/404 responses
 *   rewritten to `/index.html` with a 200 so client-side routing works on deep
 *   links.
 * - A response headers policy applying sensible security headers (HSTS,
 *   X-Content-Type-Options, X-Frame-Options, Referrer-Policy).
 * - A Route53 alias record pointing the custom domain at the distribution.
 *
 * OAC NOTE (Requirement 17.4): The S3 origin is created with
 * `origins.S3BucketOrigin.withOriginAccessControl(bucket)`, the current
 * (aws-cdk-lib 2.230) OAC-based origin. It auto-creates an Origin Access
 * Control and wires the bucket policy so only this distribution can read the
 * bucket, preventing direct S3 access. The deprecated
 * `S3Origin` + `OriginAccessIdentity` pattern is intentionally avoided.
 *
 * CERTIFICATE NOTE: CloudFront requires its ACM certificate to live in
 * us-east-1. The shared wildcard certificate created by DnsStack already lives
 * in us-east-1 (this sample deploys to us-east-1, see AuthStack), so importing
 * it here satisfies that constraint.
 *
 * ASSET DEPLOYMENT NOTE: The SvelteKit app is built in task 12.x. This stack
 * provisions the bucket and distribution only; deploying the built static
 * assets into the bucket (for example with an `s3deploy.BucketDeployment`
 * pointed at the webapp build output) is wired up once the webapp exists.
 */
export class WebappStack extends cdk.Stack {
  /** The S3 bucket that stores the built SvelteKit SPA assets. */
  public readonly siteBucket: s3.Bucket;

  /** The CloudFront distribution that serves the SPA. */
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: WebappStackProps) {
    super(scope, id, props);

    const domainName = resolveDomainName(props);
    const appDomainName = `app.${domainName}`;

    // --- S3: SPA asset bucket (private, OAC-only access) ---------------------
    const siteBucket = new s3.Bucket(this, "SiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // Demo sample: remove the bucket and its contents with the stack.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    this.siteBucket = siteBucket;

    // --- Security response headers -------------------------------------------
    const responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(
      this,
      "SecurityHeadersPolicy",
      {
        responseHeadersPolicyName: "earthquake-agent-webapp-security-headers",
        comment: "Security headers for the earthquake-agent webapp SPA",
        securityHeadersBehavior: {
          strictTransportSecurity: {
            accessControlMaxAge: cdk.Duration.days(365),
            includeSubdomains: true,
            preload: true,
            override: true,
          },
          contentTypeOptions: { override: true },
          frameOptions: {
            frameOption: cloudfront.HeadersFrameOption.DENY,
            override: true,
          },
          referrerPolicy: {
            referrerPolicy:
              cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
            override: true,
          },
        },
      },
    );

    // --- Import shared wildcard certificate (us-east-1) ----------------------
    const certificate = acm.Certificate.fromCertificateArn(
      this,
      "WildcardCertificate",
      cdk.Fn.importValue("EarthquakeAgent-WildcardCertificateArn"),
    );

    // --- CloudFront distribution (OAC origin) --------------------------------
    const distribution = new cloudfront.Distribution(this, "Distribution", {
      comment: "earthquake-agent webapp SPA distribution",
      domainNames: [appDomainName],
      certificate,
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy,
      },
      // SPA deep-link support: serve index.html (200) for client-routed paths
      // that S3 reports as 403/404.
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: cdk.Duration.minutes(5),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: cdk.Duration.minutes(5),
        },
      ],
    });
    this.distribution = distribution;

    // --- Route53 alias to the distribution -----------------------------------
    const subdomainZone = route53.HostedZone.fromHostedZoneAttributes(
      this,
      "SubdomainZone",
      {
        hostedZoneId: cdk.Fn.importValue("EarthquakeAgent-SubdomainZoneId"),
        zoneName: domainName,
      },
    );

    new route53.ARecord(this, "WebappAliasRecord", {
      zone: subdomainZone,
      recordName: appDomainName,
      target: route53.RecordTarget.fromAlias(
        new route53targets.CloudFrontTarget(distribution),
      ),
      comment:
        "Alias to the webapp CloudFront distribution (app.earthquake-agent.*)",
    });

    // --- Cross-stack exports --------------------------------------------------
    new cdk.CfnOutput(this, "WebappCustomDomainUrl", {
      value: `https://${appDomainName}`,
      description: "Custom domain URL of the webapp SPA",
      exportName: "EarthquakeAgent-WebappCustomDomainUrl",
    });

    new cdk.CfnOutput(this, "WebappDistributionDomainName", {
      value: distribution.distributionDomainName,
      description: "CloudFront distribution domain name for the webapp SPA",
      exportName: "EarthquakeAgent-WebappDistributionDomainName",
    });

    new cdk.CfnOutput(this, "WebappBucketName", {
      value: siteBucket.bucketName,
      description: "Name of the S3 bucket that stores the webapp SPA assets",
      exportName: "EarthquakeAgent-WebappBucketName",
    });
  }
}
