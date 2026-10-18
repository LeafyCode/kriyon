import { execSync } from "node:child_process";

try {
  execSync("pnpm exec lefthook install", { stdio: "inherit" });
} catch {
  console.log("lefthook not installed (prod install?) — skipping");
}
