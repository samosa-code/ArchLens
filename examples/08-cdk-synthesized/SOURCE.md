# Source

Not fetched from git history — this is a **published build artifact**, not
a source file in a repo. AWS Solutions publishes the final `cdk synth`
output for each solution to a public S3 bucket; the download link is the
same one used by the solution's "Launch in AWS Console" one-click-deploy
button.

| File | Solution | Version (from template `Description`) | Fetched from |
|---|---|---|---|
| `template.json` | [Instance Scheduler on AWS](https://github.com/aws-solutions/instance-scheduler-on-aws) (SO0030) | `v3.2.5` | `https://s3.amazonaws.com/solutions-reference/instance-scheduler-on-aws/latest/instance-scheduler-on-aws.template` |

Fetched 2026-07-19. `latest` is a moving alias controlled by AWS Solutions,
not a pinned version — the `v3.2.5` string embedded in the template's own
`Description` field ("(SO0030) instance-scheduler-on-aws v3.2.5") is the
actual reproducibility pin; if this needs re-fetching later and the content
differs, check that version string first. Deploy-link location:
[repo README, "One-Click Deploy From Amazon Web Services"](https://github.com/aws-solutions/instance-scheduler-on-aws/blob/main/README.md).
Unmodified from what was downloaded.
