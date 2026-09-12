// Usage: node tools/verify.mjs <chainId> <apiKey>   (after: yarn build)
import { returnTags } from "../dist/main.mjs";

const [chainId, apiKey] = process.argv.slice(2);
if (!chainId || !apiKey) {
  console.error("usage: node tools/verify.mjs <chainId> <apiKey>");
  process.exit(1);
}

const t0 = Date.now();
const tags = await returnTags(chainId, apiKey);
console.log(`chain ${chainId}: ${tags.length} tags in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const problems = [];
const seen = new Set();
for (const tag of tags) {
  const addr = tag["Contract Address"];
  const name = tag["Public Name Tag"];
  if (!new RegExp(`^eip155:${chainId}:0x[0-9a-f]{40}$`).test(addr)) problems.push(`bad CAIP-10: ${addr}`);
  if (seen.has(addr)) problems.push(`duplicate: ${addr}`);
  seen.add(addr);
  if (!name || name.length > 50) problems.push(`name length ${name?.length}: ${name}`);
  for (const [k, v] of Object.entries(tag)) {
    if (typeof v !== "string" || v.trim() === "") problems.push(`empty ${k} on ${addr}`);
    if (/<[^>]*>/.test(String(v))) problems.push(`html in ${k} on ${addr}`);
  }
}
for (const tag of tags.slice(0, 5)) {
  console.log(`   ${tag["Public Name Tag"].padEnd(22)} ${tag["Contract Address"]}`);
  console.log(`     ${tag["Public Note"]}`);
}
if (problems.length) {
  console.log(`\nFAIL (${problems.length})`);
  for (const p of problems.slice(0, 10)) console.log("  " + p);
  process.exit(1);
}
console.log("PASS");
