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
