import { createServer } from './app/server.js';
import { loadConfig } from './config/index.js';

const config = loadConfig(process.env);
const server = createServer(config);

server.listen(config.port, () => {
  console.log(`background-agent service listening on :${config.port} (${config.runMode})`);
});
