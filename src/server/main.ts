import { loadConfig } from "./config.js";
import { createApp } from "./app.js";

const config = loadConfig(process.argv.slice(2));
const { server, close } = createApp(config);

process.on("SIGTERM", () => {
  console.log("Shutting down...");
  close();
});

process.on("SIGINT", () => {
  console.log("Shutting down...");
  close();
});

server.listen(config.port, () => {
  console.log(`Pi Web UI running on http://localhost:${config.port}`);
  console.log(`Sessions root: ${config.sessionsRoot}`);
});
