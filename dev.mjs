import { execa } from "execa";

const server = execa({
  stdout: "inherit",
  stderr: "inherit",
})`tsx watch src/server/main.ts`;
const client = execa({ stdout: "inherit", stderr: "inherit" })`vite dev`;

await Promise.allSettled([server, client]);
