# Example Templates

Real-world CloudFormation templates used as test/dev fixtures for ArchLens.
Pulled from public repos on 2026-07-19. Every file is unmodified from
upstream **except**: `05-malformed-and-missing-ref/` (hand-derived, clearly
marked synthetic), and `07-vulnerable-cfngoat/cfngoat.yaml` (two pairs of
AWS example-placeholder credentials redacted post-fetch — GitHub's push
protection blocks on key-shaped strings regardless of whether they're real;
see that fixture's `SOURCE.md` for exactly what changed and why).

Every fixture folder has its own **`SOURCE.md`** — exact upstream repo,
file path, and the specific commit SHA it was fetched from (pinned, not a
moving branch alias), with a permalink and a note on whether it's a
git-based source or a published build artifact. Spot-checked against the
pinned commits to confirm they still resolve and byte-match what's saved
here.

These are meant to be run through the CLI by hand during development, and
later promoted into `tests/fixtures/` (per the sprint plan's Section 6.3
robustness requirements) as proper automated test cases once the parser
exists.

## Sources

| Repo | Used for |
|---|---|
| [`aws-cloudformation/aws-cloudformation-templates`](https://github.com/aws-cloudformation/aws-cloudformation-templates) | AWS's official sample collection — 01, 02, 03, 04, 10 |
| [`aws-quickstart/quickstart-linux-bastion`](https://github.com/aws-quickstart/quickstart-linux-bastion) + [`aws-quickstart/quickstart-aws-vpc`](https://github.com/aws-quickstart/quickstart-aws-vpc) | Real nested-stack (`TemplateURL`) production pattern — 06 |
| [`bridgecrewio/cfngoat`](https://github.com/bridgecrewio/cfngoat) | Deliberately vulnerable CFN, built for security-tool testing — 07 |
| [`aws-solutions/instance-scheduler-on-aws`](https://github.com/aws-solutions/instance-scheduler-on-aws) | Published CDK-synthesized output — 08 |
| [`aws-samples/serverless-patterns`](https://github.com/aws-samples/serverless-patterns) | SAM (`Transform`) pattern — 09 |
| `aws-cloudformation/aws-cloudformation-templates` (`Solutions/VPCPeering`) | Real VPC peering solution — 10 |
| [`widdix/aws-cf-templates`](https://github.com/widdix/aws-cf-templates) | Different-repo production-grade collection — 11, 12 |
| [`bridgecrewio/checkov`](https://github.com/bridgecrewio/checkov) | Clean minimal pass/fail pairs per security check, from its own test suite — 13 |

## 01-simple-lambda

**Source:** `Lambda/LambdaSample.yaml` **and** `.json` (both fetched — same
resources, both formats).

2 resources (`AWS::IAM::Role`, `AWS::Lambda::Function`). Smoke-test fixture —
`Ref`, `Fn::GetAtt`, `Fn::Sub`, simple `Outputs`/`Export`. The YAML/JSON pair
directly tests Ticket 1.1's AC: "both produce an equivalent internal AST."

## 02-complex-vpc-nat

**Source:** `VPC/VPC_With_Managed_NAT_And_Private_Subnet.yaml`

21 resources, single file: VPC, public/private subnets, NAT gateways, route
tables, network ACLs, internet gateway. Heavy `Fn::FindInMap` (against
`Mappings`), `Fn::Select` + `Fn::GetAZs`, `Fn::Join`.

## 03-multi-stack-ecs-fargate

**Source:** `ECS/FargateLaunchType/clusters/public-vpc.yaml` +
`ECS/FargateLaunchType/services/public-service.yaml`

A **genuine** two-stack pair (AWS's own recommended deploy order: network
stack first, service stack against it):

- `network-stack/` — VPC, subnets, IGW, route table, ECS cluster, ALB +
  listener + target group, security groups (including real SG-to-SG
  ingress via `SourceSecurityGroupId`, not just CIDR), IAM roles (14
  resources). Every cross-stack value is pushed to `Outputs` with
  `Export.Name: !Join [':', [!Ref AWS::StackName, <name>]]`.
- `service-stack/` — ECS task definition + service + listener rule + target
  group. Pulls cross-stack values via `Fn::ImportValue` wrapped in
  `Fn::Join` (nested intrinsic, not a bare string). Real `Conditions` block
  (`HasCustomRole`) gating an `Fn::If`.

Primary fixture for Sprint 2 (cross-stack `Fn::ImportValue` resolution).

## 04-unresolved-import

**Source:** same `service-stack/template.yaml` as 03, copied standalone
*without* its matching network stack.

Deliberately incomplete rather than edited — every `Fn::ImportValue` points
at exports that don't exist in this fixture's input set. Tests "unresolvable
imports are flagged, not silently dropped" (PRD §6.1, PO Question 4).

## 05-malformed-and-missing-ref

**Synthetic** — hand-derived from `01-simple-lambda`, not upstream originals.

- `invalid-yaml.yaml` — broken indentation under the `LambdaHandlerPath`
  parameter. Confirmed to fail parsing (`PyYAML`: `mapping values are not
  allowed here`).
- `missing-resource-ref.yaml` — valid YAML/CFN shape, but
  `LambdaFunction.Properties.Role` does `!GetAtt LambdaExecutionRole.Arn`
  where no such resource exists (the real one is `LambdaRole`). Would fail
  `aws cloudformation validate-template` for real. Tests same-template
  unresolvable `Ref`/`GetAtt` — narrower than 04's cross-*stack* case.

## 06-nested-stack-quickstart

**Source:** `quickstart-linux-bastion/templates/linux-bastion-entrypoint-new-vpc.template.yaml`
(root) + `linux-bastion-entrypoint-existing-vpc.template.yaml` (same repo) +
`quickstart-aws-vpc/templates/aws-vpc.template.yaml` (**different** repo).

A real, 3-level `AWS::CloudFormation::Stack` / `TemplateURL` tree — the
pattern our multi-stack fixture (03) does *not* cover, since 03 uses
`Export`/`ImportValue` instead:

```
root.template.yaml
├── VPCStack   → TemplateURL → vpc-child.template.yaml      (submodule, another repo)
└── BastionStack → TemplateURL → bastion-child.template.yaml (same repo)
```

`TemplateURL` values are real S3-hosted Quick Start URLs (`!Sub` + `!If`
composing bucket/region/prefix) — since ArchLens does static local-file
analysis only (no AWS calls per PRD non-goals), the three files are flattened
into one local directory rather than left as remote references. Root fixture
for Sprint 5's nested-stack-boundary clustering (Ticket 5.2).

## 07-vulnerable-cfngoat

**Source:** `cfngoat.yaml` — 1327 lines, purpose-built insecure template
(EC2, IAM, KMS, Lambda, RDS, S3, SSM). Unlike every other fixture here
(written as best-practice examples), this one has **confirmed real
positive hits** for all three PRD security rules:

- Public ingress: `CidrIp: 0.0.0.0/0` (SG ingress, line ~122)
- Unencrypted storage: `StorageEncrypted: False` (RDS), unencrypted S3
  buckets, a commented-out `#Encrypted: False` EBS volume
- Wildcard IAM: `Resource: "*"` policy statements (lines ~419, ~686)

Everything we had before this was compliant-by-design and would never
trigger Sprint 9's rules — this fixes that.

Also originally demonstrated hardcoded-credentials-in-plaintext (UserData
and a Lambda's environment variables) using AWS's example-placeholder
key/secret pair — redacted post-fetch since it tripped GitHub's push
protection; see `SOURCE.md` in this folder.

## 08-cdk-synthesized

**Source:** the actual published deploy template for AWS Solution
"Instance Scheduler on AWS" (`solutions-reference` S3 bucket, linked from
the repo's README's one-click-deploy button) — real CDK `cdk synth` output,
not hand-written CFN. 8037 lines, JSON.

- 111 `Metadata."aws:cdk:path"` entries
- Hashed logical IDs throughout (e.g. `SchedulerRolekmsAccessCondition93ED0C6C`)
- Asset/bootstrap parameters typical of CDK apps

Explicitly in PRD scope ("CFN and SAM/CDK-synthesized templates only, for
v1") and the real stress test for Ticket 5.3's human-readable-labeling
fallback — CDK output essentially never has a usable `Name` tag, so this
exercises the "has-neither" cleaned-logical-ID path at real scale.

## 09-sam-apigw-lambda-dynamodb

**Source:** `apigw-lambda-dynamodb-go-sam/template.yml` from the
`serverless-patterns` collection.

Compact (77 lines) but structurally rich: `Transform:
AWS::Serverless-2016-10-31`, `AWS::Serverless::Api` with an inline OpenAPI
`DefinitionBody`, `AWS::Serverless::Function` with an `Events.Api` mapping
and a `DynamoDBCrudPolicy` (a SAM policy-template shorthand that expands
into a real IAM policy at deploy time — worth deciding explicitly whether
v1 expands this or treats it as opaque). Good multi-hop chain for Sprint 6/7
(API → Lambda → DynamoDB) testing.

## 10-vpc-peering

**Source:** `Solutions/VPCPeering/templates/VPCPeering-Requester-Setup.cfn.yaml`
+ `VPCPeering-Updates.cfn.yaml`, from the same `aws-cloudformation-templates`
repo as 01–04 (a directory we hadn't explored before this round).

- `requester-setup.yaml` — the actual `AWS::EC2::VPCPeeringConnection`
  resource.
- `peering-updates.yaml` — route table updates (`AWS::EC2::Route` with
  `VpcPeeringConnectionId`) and CIDR-based ingress rules for the peered
  range, across up to 6 route tables/security groups via `Fn::Select` +
  `Fn::Split` on a comma-joined parameter (an interesting intrinsic
  pattern in its own right).

Note: SG-to-SG ingress (`SourceSecurityGroupId`) is already covered by
fixture 03, not repeated here — this fixture's ingress rules are
CIDR-based (peer VPC range), which is the realistic pattern for
cross-VPC peering anyway.

## 11-large-production-wordpress-ha

**Source:** `widdix/aws-cf-templates` → `wordpress/wordpress-ha-aurora.yaml`
— 1459 lines, ~50 resources: Aurora cluster, ASG + launch template, ALB,
EFS, CloudFront, WAFv2, AWS Backup (vault/plan/selection), 16 CloudWatch
alarms. Different repo, different authoring conventions (heavy conditional
`Fn::If` blocks for optional features like Route53/CloudFront/backups) than
anything else in this set — deliberately diversifies away from
`aws-cloudformation-templates`-only fixtures for Sprint 5's clustering work
and Sprint 14's real-world validation.

## 12-diff-pair-wordpress-tls

**Source:** two real commits of the same file,
`widdix/aws-cf-templates` @ `f8c402fcf4` (before) and `1a9f04f934` (after).

A genuine, minimal, hand-verifiable real-world diff — not synthesized:

```diff
-          MinimumProtocolVersion: 'TLSv1.2_2019'
+          MinimumProtocolVersion: 'TLSv1.2_2025'
```

One resource (`CloudFrontDistribution`), one property, confirmed via `diff`
to be the *only* change between the two commits. Matches Ticket 11.3's AC
almost exactly ("only the changed property is reported"). Per the sprint
plan's own Sprint 11 QA strategy ("use real git history... synthetic
fixtures risk missing real-world diff shapes"). Does **not** cover a rename
scenario — commit history on our other fixture files didn't surface a clean
one; worth revisiting if Question 10's answer ends up needing a concrete
rename test case.

## 13-checkov-security-rule-pairs

**Source:** `bridgecrewio/checkov`'s own test fixtures
(`tests/cloudformation/checks/resource/aws/`) — clean, minimal, single-
resource pass/fail pairs, purpose-built for exactly this kind of rule
verification (checkov uses them to test its own equivalent checks).
Complements 07 (cfngoat): cfngoat is one big combined realistic stack,
these are isolated unit-test-style positive/negative pairs — one pair per
PRD security rule:

| Rule | Pass | Fail |
|---|---|---|
| IAM wildcard (`Action:"*"` + `Resource:"*"`) | `iam-wildcard/pass.json` | `iam-wildcard/fail.json` |
| Unencrypted EBS | `ebs-encryption/pass.yaml` | `ebs-encryption/fail.yaml` |
| Unencrypted RDS | `rds-encryption/pass.yaml` | `rds-encryption/fail.yaml` |
| Unrestricted SG ingress (port 22) | `sg-unrestricted-ingress/pass.yaml` | `sg-unrestricted-ingress/fail.yaml` |

Note: the SG-ingress fail case uses `CidrIp: !Ref SSHLocation` where the
parameter's *default* is `0.0.0.0/0` — a real edge case for whether the
security rule engine resolves parameter defaults before evaluating, not
just literal `CidrIp` values.

## Coverage summary

| Fixture | Files | Intrinsics | Conditions | Cross-stack | Nested stack | Security hits | Broken |
|---|---|---|---|---|---|---|---|
| 01 simple-lambda | 2 (yaml+json) | Ref, GetAtt, Sub | – | export only | – | – | – |
| 02 complex-vpc-nat | 1 | FindInMap, Select, GetAZs, Join | – | – | – | – | – |
| 03 multi-stack-ecs-fargate | 2 | ImportValue(Join), If, Join | ✅ | ✅ resolvable | – | – | – |
| 04 unresolved-import | 1 | ImportValue(Join) | ✅ | ✅ **unresolvable** | – | – | – |
| 05 malformed-and-missing-ref | 2 | Ref, GetAtt, Sub | – | – | – | – | ✅ (2 kinds) |
| 06 nested-stack-quickstart | 3 | Sub, If, Join | ✅ | – | ✅ **3-level** | – | – |
| 07 vulnerable-cfngoat | 1 | mixed | – | – | – | ✅ **all 3 rules** | – |
| 08 cdk-synthesized | 1 | Sub, GetAtt, Ref | ✅ | – | ✅ (CDK asset nesting) | – | – |
| 09 sam-apigw-lambda-dynamodb | 1 | Sub, GetAtt, Ref | – | – | – | – | – |
| 10 vpc-peering | 2 | Select, Split | ✅ | – | – | – | – |
| 11 large-production-wordpress-ha | 1 | If-heavy, FindInMap | ✅ | – | – | partial | – |
| 12 diff-pair-wordpress-tls | 2 | – | – | – | – | – | – |
| 13 checkov-security-rule-pairs | 8 | minimal | – | – | – | ✅ **pass/fail per rule** | – |
