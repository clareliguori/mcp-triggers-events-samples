import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53targets from "aws-cdk-lib/aws-route53-targets";
import { Construct } from "constructs";
import { resolveDomainName, type SharedProps } from "./shared-props.js";

export type AuthStackProps = cdk.StackProps & SharedProps;

/**
 * Authentication foundation for the MCP Events Serverless Agent sample.
 *
 * Responsibilities (Requirements 13.4, 13.5, 10.1):
 * - Create a Cognito User Pool that supports self sign-up, email sign-in, and
 *   password reset (the flows the webapp Hosted UI exposes).
 * - Create a public User Pool Client (no client secret) configured for the
 *   OAuth authorization code grant, which Cognito serves with PKCE for public
 *   single page apps.
 * - Attach a custom Hosted UI domain at `auth.<subdomain>.<parentDomain>`
 *   (for example `auth.earthquake-agent.liguori.people.aws.dev`) using the
 *   shared wildcard certificate, and point a Route53 alias record at it.
 *
 * Cross-stack wiring follows the design's CfnOutput / Fn.importValue approach:
 * the wildcard certificate ARN and subdomain hosted zone id are imported from
 * DnsStack's exports rather than passed as construct props, so this stack stays
 * environment agnostic (see bin/app.ts). The User Pool id, client id, and
 * Hosted UI domain are published via the CfnOutput exports below and imported
 * by name (DataApiStack, WebappStack); no construct references are shared.
 *
 * IMPORTANT: A Cognito custom domain requires its ACM certificate to live in
 * the us-east-1 Region (Cognito fronts custom domains with CloudFront). Deploy
 * this sample to us-east-1 so the shared wildcard certificate created by
 * DnsStack satisfies that constraint. Cognito also requires the parent domain
 * `<subdomain>.<parentDomain>` to resolve (have a DNS A record) before the
 * custom domain can be created at deploy time.
 */
export class AuthStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    const domainName = resolveDomainName(props);
    const authDomainName = `auth.${domainName}`;
    const appUrl = `https://app.${domainName}`;

    // User Pool: email-based sign-in with self sign-up and email account
    // recovery (the password reset flow surfaced by the Hosted UI).
    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: "earthquake-agent-users",
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      // Demo sample: tear the pool down cleanly with the stack.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Public client for the SPA: no generated secret means Cognito requires
    // PKCE for the authorization code grant. Implicit grant is disabled.
    const client = userPool.addClient("WebappClient", {
      userPoolClientName: "earthquake-agent-webapp",
      generateSecret: false,
      authFlows: { userSrp: true },
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
          implicitCodeGrant: false,
        },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: [appUrl, `${appUrl}/`, "http://localhost:5173/"],
        logoutUrls: [appUrl, `${appUrl}/`, "http://localhost:5173/"],
      },
      preventUserExistenceErrors: true,
    });

    // Import the shared wildcard certificate (us-east-1) and subdomain zone
    // from DnsStack via their exported names. Using Fn.importValue keeps this
    // stack environment agnostic per the design's cross-stack approach.
    const certificate = acm.Certificate.fromCertificateArn(
      this,
      "WildcardCertificate",
      cdk.Fn.importValue("EarthquakeAgent-WildcardCertificateArn"),
    );

    // Custom Hosted UI domain at auth.<subdomain>.<parentDomain>.
    const userPoolDomain = userPool.addDomain("HostedUiDomain", {
      customDomain: {
        domainName: authDomainName,
        certificate,
      },
    });

    // Alias record so the Hosted UI domain resolves to the Cognito managed
    // CloudFront distribution. The subdomain zone is imported from DnsStack.
    const subdomainZone = route53.HostedZone.fromHostedZoneAttributes(
      this,
      "SubdomainZone",
      {
        hostedZoneId: cdk.Fn.importValue("EarthquakeAgent-SubdomainZoneId"),
        zoneName: domainName,
      },
    );

    new route53.ARecord(this, "HostedUiAliasRecord", {
      zone: subdomainZone,
      recordName: authDomainName,
      target: route53.RecordTarget.fromAlias(
        new route53targets.UserPoolDomainTarget(userPoolDomain),
      ),
      comment: "Alias to the Cognito Hosted UI custom domain distribution",
    });

    new cdk.CfnOutput(this, "UserPoolId", {
      value: userPool.userPoolId,
      description: "Cognito User Pool id for the earthquake-agent sample",
      exportName: "EarthquakeAgent-UserPoolId",
    });

    new cdk.CfnOutput(this, "UserPoolClientId", {
      value: client.userPoolClientId,
      description:
        "Cognito User Pool Client id for the webapp (PKCE public client)",
      exportName: "EarthquakeAgent-UserPoolClientId",
    });

    new cdk.CfnOutput(this, "HostedUiDomain", {
      value: authDomainName,
      description:
        "Cognito Hosted UI custom domain (auth.earthquake-agent.<parentDomain>)",
      exportName: "EarthquakeAgent-HostedUiDomain",
    });
  }
}
