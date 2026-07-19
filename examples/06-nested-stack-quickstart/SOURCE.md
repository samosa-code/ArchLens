# Source

| File | Upstream repo | Path | Commit (pinned) | Permalink |
|---|---|---|---|---|
| `root.template.yaml` | [`aws-quickstart/quickstart-linux-bastion`](https://github.com/aws-quickstart/quickstart-linux-bastion) | `templates/linux-bastion-entrypoint-new-vpc.template.yaml` | `fe78fb53c649f50e97adc7a6f0351d477f3adb9d` | https://github.com/aws-quickstart/quickstart-linux-bastion/blob/fe78fb53c649f50e97adc7a6f0351d477f3adb9d/templates/linux-bastion-entrypoint-new-vpc.template.yaml |
| `bastion-child.template.yaml` | [`aws-quickstart/quickstart-linux-bastion`](https://github.com/aws-quickstart/quickstart-linux-bastion) | `templates/linux-bastion-entrypoint-existing-vpc.template.yaml` | `fe78fb53c649f50e97adc7a6f0351d477f3adb9d` | https://github.com/aws-quickstart/quickstart-linux-bastion/blob/fe78fb53c649f50e97adc7a6f0351d477f3adb9d/templates/linux-bastion-entrypoint-existing-vpc.template.yaml |
| `vpc-child.template.yaml` | [`aws-quickstart/quickstart-aws-vpc`](https://github.com/aws-quickstart/quickstart-aws-vpc) (**different repo**) | `templates/aws-vpc.template.yaml` | `39bed9b10d6b7069d686e1bd68a98cbf74c9a744` | https://github.com/aws-quickstart/quickstart-aws-vpc/blob/39bed9b10d6b7069d686e1bd68a98cbf74c9a744/templates/aws-vpc.template.yaml |

Fetched via each repo's `main` branch on 2026-07-19; pinned above to the
commit that was `main`'s HEAD for each file at fetch time. Unmodified from
upstream. `root.template.yaml` references both children via
`AWS::CloudFormation::Stack` / `TemplateURL` (real S3-hosted Quick Start
URLs) — the three files are a genuine, currently-live nested-stack tree,
flattened here into one local directory since ArchLens does local-file-only
static analysis.
