if (!process.argv.some((arg) => arg.startsWith("--mode=") || arg === "--male" || arg === "--female")) {
  process.argv.push("--mode=male");
}

await import("./runTsumSlowIngest.js");
