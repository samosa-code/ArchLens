# 15-multi-account-hub-spoke

**Provenance: synthetic — authored in-repo for Sprint 3.5, Ticket A.4.**

Unlike examples 01–14 (real-world templates), this fixture was written
specifically to validate account/region container nesting, because no real
fixture on disk spans accounts or regions (the gap PO Question 20's
decision explicitly noted, following the same pattern as the synthetic
1,000-node layout fixture PO Question 14 required).

It exercises the `Metadata: ArchLens: { account, region }` convention
(PO Question 27): CloudFormation templates carry no deploy-target
identity, so account/region membership is declared per template via an
ArchLens-recognized metadata key — never guessed.

Shape (hub/spoke, mirroring the AWS reference-diagram style the project's
vision doc targets):

- `hub-eventbus.yaml` — account **Hub (111122223333)**, region
  **us-east-1**: a central `AWS::Events::EventBus` + audit `AWS::SQS::Queue`.
- `spoke-app-us.yaml` — account **Spoke (444455556666)**, region
  **us-east-1**: `VPC → Subnet → EC2 Instance` (exercises VPC/Subnet
  container nesting *inside* a region container) + a DynamoDB table.
- `spoke-app-eu.yaml` — account **Spoke (444455556666)**, region
  **eu-west-1**: a Lambda + replica DynamoDB table (makes the Spoke
  account span two regions, so region containers nest inside it).

Expected containment tree:

```
Hub (111122223333)            [account]
└── us-east-1                 [region]   CentralBus, AuditQueue
Spoke (444455556666)          [account]
├── us-east-1                 [region]
│   ├── AppVpc                [vpc]
│   │   └── AppSubnet         [subnet]  AppServer
│   └── OrdersTable
└── eu-west-1                 [region]   ReplicaFunction, ReplicaTable
```

All resource types used are covered by explicit rules in
`src/architecture/rules.ts`, deliberately, so this fixture never affects
the unknown-type ceiling asserted in `classify.test.ts`.
