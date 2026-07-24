#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { loadTemplates } from '../parser/loader.js';
import { mergeGraphs } from '../graph/merge.js';
import { generate } from '../architecture/generate.js';
import { architectureGraphToRenderGraph } from './fromArchitectureGraph.js';
import { writeHtml } from './build.js';

/**
 * Ticket 3.3's manual-verification entry point — `npm run render:demo`
 * writes a real, openable `index.html`. Runs the same real 5-template
 * merge `arch:demo` uses through the FULL pipeline (`loadTemplates` →
 * `mergeGraphs` → `generate()` → `architectureGraphToRenderGraph()`), so
 * what you see is the real click-for-details panel against real absorbed
 * IAM roles/log groups, real connector-derived edges, and real security
 * findings — not yet the full CLI (`--out`, arg parsing, `--raw` toggle)
 * that's Ticket 3.4's job. (Ticket 3.1/3.2's own version of this file used
 * the raw 1:1 projection — swapped here since the "cooked" pipeline is
 * what Ticket 3.3 actually built.)
 *
 * The five files are independent of each other (no cross-stack references
 * between them) — merged purely for demo variety, the same "point
 * ArchLens at a big glob of unrelated templates" scenario
 * `graph/__test__/diverseCorpus.test.ts` already validates at much larger
 * scale.
 */
const EXAMPLE_FILES = [
  '09-sam-apigw-lambda-dynamodb/template.yaml', // API Gateway, Lambda, DynamoDB
  '14-diverse-corpus/apigateway-lambda-integration.yaml', // a second API Gateway + Lambda pattern
  '14-diverse-corpus/rds-mysql-with-read-replica.yaml', // RDS + its security group
  '14-diverse-corpus/sam-apigw-fifo-sqs-lambda-sns.yaml', // SQS/SNS + Lambda + API Gateway
  '02-complex-vpc-nat/template.yaml', // VPC networking: subnets, NAT, route tables, ACLs
].map((relativePath) => fileURLToPath(new URL(`../../examples/${relativePath}`, import.meta.url)));

const { templates, warnings: loadWarnings } = loadTemplates(EXAMPLE_FILES);
for (const warning of loadWarnings) {
  console.error(`Failed to load ${warning.file}: ${warning.message}`);
}

const graph = mergeGraphs(templates);
const arch = generate(graph);
const renderGraph = architectureGraphToRenderGraph(arch);

const outPath = fileURLToPath(new URL('../../archlens-output/index.html', import.meta.url));
writeHtml(renderGraph, outPath);

console.log(`Wrote ${outPath}`);
console.log('Open it directly in a browser — disconnect from the network first to confirm nothing external is requested.');
console.log(
  `Real-fixture graph: ${templates.length} templates, ${graph.nodes.length} raw resources -> ` +
    `${renderGraph.nodes.length} components + ${renderGraph.containers?.length ?? 0} containers, ${renderGraph.edges.length} edges.`,
);
console.log('Try dragging to pan, scrolling to zoom, and clicking a node to open its detail panel.');
