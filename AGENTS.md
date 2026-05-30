## Standard development workflow

- Before completing a task, always validate your changes, which may include compile, lint, run tests, and run the application and interact with it.
- When you have completed a task, commit your changes in git using a well-formed commit message consisting of a single sentence summary and no more than one paragraph explaining the change.
  Do not include sensitive information in commit messages, including AWS resource ARNs.
  For the author of the commit, use `--author="$(git config user.name) (Kiro) <$(git config user.email)>"` in the git commit command.
  If you are working on a Kiro spec task, mark the task as complete in the tasks.md BEFORE committing your changes.

## AWS guidance

- Before starting a task, check whether a relevant AWS skill is available.
  Load the skill and prefer its guidance over general knowledge.
- When uncertain about specific AWS details (API parameters, permissions,
  limits, error codes), verify against documentation rather than guessing.
  State uncertainty explicitly if you cannot confirm.
- Prefer infrastructure-as-code (AWS CDK) over direct CLI commands. Do not use raw CloudFormation or SAM templates.
- Do not use em dashes in AWS resource names or descriptions. Use hyphens instead.
- Always use `--no-cli-pager` with the aws cli to get the full output.

## CDK cross-stack references

- Do not pass TypeScript construct references across stacks (no handing a construct, or a stack instance, from one stack's constructor to another). Sharing live constructs creates implicit, auto-generated CloudFormation exports and tight deploy-time coupling between stacks.
- Instead, share values across stacks with explicitly-named exports and imports: the producing stack publishes a `cdk.CfnOutput` with an explicit `exportName` (prefixed `EarthquakeAgent-`), and the consuming stack reads it with `cdk.Fn.importValue("<exportName>")`, rehydrating constructs as needed via `fromXxxArn` / `fromTableAttributes` / `fromUserPoolId`, etc.
- For deterministic values (such as custom-domain URLs derived from the shared domain name), pass them as Lambda environment variables or recompute them from `SharedProps` rather than importing, to avoid synth-time stack ordering dependencies.
- Do not expose public construct properties on a stack class solely for another stack to read. Keep cross-stack contracts to the named CfnOutput/Fn.importValue surface.
- Cross-region exception: `Fn.importValue` cannot resolve across regions. When a stack must consume a resource from a stack in a different region (for example, a CloudFront or Cognito custom-domain certificate that must live in us-east-1 while the app deploys to another region), enable `crossRegionReferences: true` on both stacks and pass the resource as a construct reference via props. This is the only sanctioned case for passing a construct across stacks; same-region sharing must still use named exports/imports.

## CDK certificate regions

- ACM certificates are regional. CloudFront and Cognito custom-domain certificates MUST live in us-east-1; REGIONAL API Gateway custom-domain certificates must live in the API's own region.
- This app splits the DNS/TLS foundation into `DnsRegionalStack` (target region: subdomain hosted zone, NS delegation, and the regional wildcard certificate for the API Gateways) and `DnsUsEast1Stack` (pinned to us-east-1: the wildcard certificate for CloudFront and Cognito). `DnsUsEast1Stack` is pinned to us-east-1 explicitly in `bin/app.ts`, not via `CDK_DEFAULT_REGION`.
- Prefer one shared wildcard certificate per region over per-service certificates. ACM issues one deterministic DNS validation CNAME per FQDN, so multiple certificates for the same wildcard name share a single validation record; binding one certificate to multiple API Gateways is supported and the certificate ARN is stable across automatic renewals.
