import { Client } from "@deno/sandbox";

const token = process.env.DENO_API_KEY;
if (!token) throw new Error("DENO_API_KEY not set");

const client = new Client({ token });

const testSlug = `test-vol-${Date.now().toString(36)}`;
console.log(`Testing volume creation with slug: ${testSlug} (${testSlug.length} chars)`);

// Test 1: Create volume with 1000MB capacity (what backend now uses)
try {
  console.log("\n--- Test 1: Create with 1000MB capacity ---");
  const vol = await client.volumes.create({
    slug: testSlug,
    region: "ord",
    capacity: "1000MB",
  });
  console.log("SUCCESS:", vol);
  await client.volumes.delete(vol.slug);
  console.log("Cleaned up");
} catch (e) {
  console.error("FAILED:", e);
}

// Test 2: Create volume with 1GB capacity (known to work)
const testSlug2 = `${testSlug}-2`;
try {
  console.log("\n--- Test 2: Create with 1GB capacity ---");
  const vol = await client.volumes.create({
    slug: testSlug2,
    region: "ord",
    capacity: "1GB",
  });
  console.log("SUCCESS:", vol);
  await client.volumes.delete(vol.slug);
  console.log("Cleaned up");
} catch (e) {
  console.error("FAILED:", e);
}

// Test 3: Create volume with 500MB capacity (test minimum boundary)
const testSlug3 = `${testSlug}-3`;
try {
  console.log("\n--- Test 3: Create with 500MB capacity ---");
  const vol = await client.volumes.create({
    slug: testSlug3,
    region: "ord",
    capacity: "500MB",
  });
  console.log("SUCCESS:", vol);
  await client.volumes.delete(vol.slug);
  console.log("Cleaned up");
} catch (e) {
  console.error("FAILED:", e);
}
